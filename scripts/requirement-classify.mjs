#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  atomicWriteFile,
  requirementClassificationFingerprint,
} from './workflow-lib.mjs';
import { requirementConfirmationStatus } from './requirement-context.mjs';
import { readRepositoryEvidence, writeRepositoryEvidence } from './repository-evidence.mjs';

function listSize(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    return Object.values(value).filter(item => Array.isArray(item) ? item.length > 0 : Boolean(item)).length;
  }
  return value ? 1 : 0;
}

function functionalScopeSize(value) {
  if (Array.isArray(value)) return new Set(value.map(item => normalizedText(item).trim()).filter(Boolean)).size;
  if (!value || typeof value !== 'object') return value ? 1 : 0;
  const canonical = ['in_scope', 'allowed_files', 'expected_files', 'files', 'paths', 'modules', 'services', 'repositories'];
  const items = canonical.flatMap(key => Array.isArray(value[key]) ? value[key] : value[key] ? [value[key]] : []);
  return new Set(items.map(item => normalizedText(item).trim()).filter(Boolean)).size;
}

const RANK = Object.freeze({ hotfix: 0, minor: 1, trivial: 2, moderate: 3, standard: 4, complex: 5 });
function floorComplexity(value, floor) { return RANK[value] >= RANK[floor] ? value : floor; }
function normalizedText(value) { return typeof value === 'string' ? value : JSON.stringify(value || ''); }
function hasCanonicalUnresolved(doc) {
  const values = ['unresolved', 'open_questions', 'unresolved_questions']
    .flatMap(key => [doc?.[key], doc?.dimensions?.[key]]);
  return values.some(value => {
    if (Array.isArray(value)) return value.some(item => hasCanonicalUnresolved({ unresolved: item }));
    if (value && typeof value === 'object') {
      if (String(value.status || '').toLowerCase() === 'resolved') return false;
      return Object.keys(value).length > 0;
    }
    if (typeof value !== 'string') return value === true;
    const text = value.trim().toLowerCase();
    return Boolean(text) && !/^(?:none|no|no(?:\s+(?:open|unresolved))?\s+questions?|resolved|n\/a|无(?:未决|待解决)?(?:问题|事项)?|没有(?:未决|待解决)?(?:问题|事项)?|已解决)$/.test(text);
  });
}
function explicitRisk(requirement, dimensions) {
  const text = [
    requirement.match(/^##\s*(?:risk|风险)(?:[：:]\s*|\s*\n\s*)(low|medium|high|低|中|高)(?:风险)?\s*$/im)?.[1],
    dimensions.risk_level, dimensions.risk, dimensions.impact_analysis?.risk_level,
  ].map(normalizedText).join(' ');
  if (/(?:^|\W)(high|高)(?:$|\W)/i.test(text)) return 'high';
  if (/(?:^|\W)(medium|中)(?:$|\W)/i.test(text)) return 'medium';
  if (/(?:^|\W)(low|低)(?:$|\W)/i.test(text)) return 'low';
  return null;
}

function actionableText(value) {
  return normalizedText(value).split(/\n|[。.!?；;]/).filter(segment =>
    !/(?:不要|不得|禁止|无需|不涉及|保持|兼容|do\s+not|don't|without|preserve|no\s+change)/i.test(segment)
  ).join('\n');
}

export function computeRequirementClassification(ideaDir) {

  const requirement = readFileSync(join(ideaDir, 'requirement.md'), 'utf8');
  const clarification = JSON.parse(readFileSync(join(ideaDir, 'requirement-clarification.json'), 'utf8'));
  const escalation = existsSync(join(ideaDir, 'scope-escalation.json'))
    ? JSON.parse(readFileSync(join(ideaDir, 'scope-escalation.json'), 'utf8')) : null;
  const dimensions = clarification.dimensions || {};
  const combined = `${requirement}\n${JSON.stringify(dimensions)}`;
  const actionable = actionableText(combined);
  const repositoryEvidence = readRepositoryEvidence(ideaDir);
  const repositorySignals = repositoryEvidence?.signals || {};
  const acceptanceCount = listSize(dimensions.acceptance_criteria);
  const scopeCount = functionalScopeSize(dimensions.functional_scope);
  const verificationCount = (Array.isArray(dimensions.acceptance_criteria) ? dimensions.acceptance_criteria : [])
    .reduce((sum, item) => sum + (Array.isArray(item?.verification_conditions) ? item.verification_conditions.length : 0), 0);
  const explicitRiskLevel = explicitRisk(requirement, dimensions);
  const tolerance = normalizedText(dimensions.risk_tolerance).toLowerCase();
  const lowRiskTolerance = /(^|\W)(low|zero|none|低|零|不接受)(\W|$)/i.test(tolerance);
  const highRisk = /(auth|permission|token|payment|billing|migration|ddl|delete|security|privacy|鉴权|权限|支付|迁移|删除|安全|隐私)/i.test(actionable);
  const dataApiMigration = /(new\s+api|new\s+endpoint|新增.{0,4}(接口|表)|schema|database|数据库|migration|迁移|ddl)/i.test(actionable);
  const crossBoundary = /(cross[- ]?(repo|module|service)|跨仓|跨模块|跨服务|多个仓库|multi[- ]?repo)/i.test(combined);
  const repositoryFileCount = Number(repositorySignals.candidate_file_count || 0);
  const repositoryModuleCount = Number(repositorySignals.candidate_module_count || 0);
  const repositoryKnown = Number(repositoryEvidence?.source_files || 0) > 0;
  const architectural = crossBoundary || /(并发|distributed|architecture|架构)/i.test(actionable)
    || (dataApiMigration && (repositorySignals.has_migration_files || repositorySignals.has_external_boundary_files || !repositoryKnown));
  const broadScope = repositoryFileCount > 8 || repositoryModuleCount > 2
    || /全量|所有模块|entire|all modules|全链路/i.test(normalizedText(dimensions.functional_scope));
  const canonicalUnresolved = hasCanonicalUnresolved(clarification);
  const uncertain = canonicalUnresolved || /\b(TBD|unknown|unclear|open question)\b|待定|未知|不明确|待确认/i.test(combined);
  const explicit = requirement.match(/^##\s*复杂度(?:[：:]\s*|\s*\n\s*)(hotfix|minor|trivial|moderate|standard|complex)\s*$/mi)?.[1]?.toLowerCase();
  let delivery = 'moderate';
  const reasons = [];
  if (explicit === 'hotfix') delivery = 'hotfix';
  else if (explicit === 'complex' || repositoryFileCount > 20 || repositoryModuleCount > 4) delivery = 'complex';
  else if (highRisk || architectural || repositoryFileCount > 8 || repositoryModuleCount > 2) delivery = 'standard';
  else if (repositoryFileCount > 2 || (repositoryKnown && repositoryFileCount === 0)) delivery = 'moderate';
  else if (repositoryFileCount > 0) delivery = explicit === 'minor' ? 'minor' : 'trivial';
  else if (!repositoryKnown && acceptanceCount <= 2 && scopeCount <= 2) delivery = explicit === 'minor' ? 'minor' : 'trivial';
  if (explicitRiskLevel) reasons.push(`explicit risk level: ${explicitRiskLevel}`);
  if (highRisk) reasons.push('high-risk domain signal');
  if (architectural) reasons.push('architecture/data/API change signal');
  if (crossBoundary) reasons.push('cross-repository/module boundary signal');
  if (broadScope) reasons.push('broad functional scope signal');
  if (lowRiskTolerance) reasons.push('low risk tolerance requires conservative routing');
  if (uncertain) reasons.push('unresolved requirement signal');
  if (canonicalUnresolved) reasons.push('clarification contains canonical unresolved/open questions');
  if (repositoryEvidence) reasons.push(`${repositoryFileCount} candidate files across ${repositoryModuleCount} modules from bounded repository discovery`);
  else reasons.push('repository evidence unavailable; using conservative requirement fallback');
  reasons.push(`${acceptanceCount} acceptance criteria, ${verificationCount} verification conditions, and ${scopeCount} scope items (diagnostic only)`);

  let routing = delivery;
  const inferredRisk = explicitRiskLevel || (highRisk ? 'high' : (architectural || broadScope ? 'medium' : 'low'));
  if (['moderate', 'standard', 'complex'].includes(explicit)) routing = floorComplexity(routing, explicit);
  if (explicit === 'minor') routing = floorComplexity(routing, 'minor');
  if (explicit === 'trivial') routing = floorComplexity(routing, 'trivial');
  if ((inferredRisk === 'high' || uncertain || lowRiskTolerance) && routing !== 'complex') routing = floorComplexity(routing, 'standard');
  else if (inferredRisk === 'medium') routing = floorComplexity(routing, 'moderate');
  if ((architectural || crossBoundary || broadScope) && routing !== 'complex') routing = floorComplexity(routing, 'standard');
  if (escalation?.required === true) {
    const requestedMinimum = escalation.minimum_complexity;
    const validMinimum = ['moderate', 'standard', 'complex'].includes(requestedMinimum);
    const minimum = validMinimum ? requestedMinimum : 'standard';
    routing = floorComplexity(routing, minimum);
    reasons.push(validMinimum
      ? `quick-dev scope escalation: ${escalation.reason || 'scope exceeded direct profile'}`
      : `invalid scope escalation minimum_complexity '${requestedMinimum ?? 'missing'}'; fail-safe floor standard`);
  }
  // A hotfix is only valid when it remains low-risk and tightly bounded.
  if (routing === 'hotfix' && (inferredRisk !== 'low' || uncertain || acceptanceCount > 2 || verificationCount > 3 || scopeCount > 1 || architectural || broadScope)) {
    routing = 'standard';
    reasons.push('hotfix request is not low-risk and tightly bounded');
  }
  const difficulty = ['hotfix', 'minor', 'trivial'].includes(routing) ? 'simple'
    : routing === 'moderate' ? 'moderate' : 'complex';
  const executionProfile = difficulty === 'simple' ? 'direct'
    : difficulty === 'moderate' ? 'lightweight' : 'full';
  const subagentBudget = difficulty === 'simple'
    ? { max_concurrent: 1, discovery: 0, planning: 0, document_writers: 0, reviewers: 1 }
    : difficulty === 'moderate'
      ? { max_concurrent: 2, discovery: 0, planning: 1, document_writers: 1, reviewers: 1 }
      : { max_concurrent: 4, discovery: 2, planning: 1, document_writers: 1, reviewers: 2 };
  return {
    schema_version: 1,
    source_step: 'classify:requirement',
    classified_at: new Date().toISOString(),
    input_fingerprint: requirementClassificationFingerprint(ideaDir),
    difficulty,
    delivery_complexity: delivery,
    routing_complexity: routing,
    risk_level: inferredRisk,
    uncertainty_level: uncertain ? 'high' : 'low',
    execution_profile: executionProfile,
    subagent_budget: subagentBudget,
    signals: {
      acceptance_criteria: acceptanceCount,
      verification_conditions: verificationCount,
      scope_items: scopeCount,
      broad_scope: broadScope,
      cross_boundary: crossBoundary,
      data_api_migration: dataApiMigration,
      high_risk_domain: highRisk,
      explicit_risk: explicitRiskLevel,
      low_risk_tolerance: lowRiskTolerance,
      architectural,
      uncertain,
      repository_evidence: Boolean(repositoryEvidence),
      candidate_files: repositoryFileCount,
      candidate_modules: repositoryModuleCount,
    },
    reasons,
  };
}

export const buildRequirementClassification = computeRequirementClassification;

export function writeRequirementClassification(ideaDir, projectRoot = ideaDir) {
  if (!existsSync(join(ideaDir, 'requirement.md')) || !existsSync(join(ideaDir, 'requirement-clarification.json'))) {
    throw new Error('requirement.md and requirement-clarification.json are required');
  }
  const clarification = JSON.parse(readFileSync(join(ideaDir, 'requirement-clarification.json'), 'utf8'));
  if (clarification?.schema_version === 2) {
    const confirmation = requirementConfirmationStatus(ideaDir);
    if (!confirmation.valid) throw new Error(`canonical requirement is not confirmed: ${confirmation.reason}`);
  }
  writeRepositoryEvidence(ideaDir, resolve(projectRoot), readFileSync(join(ideaDir, 'requirement.md'), 'utf8'), clarification.dimensions || {});
  const result = buildRequirementClassification(ideaDir);
  atomicWriteFile(join(ideaDir, 'requirement-classification.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ideaDir = process.argv[2];
  const projectRoot = process.argv[3] || '.';
  if (!ideaDir) {
    process.stderr.write('Usage: node requirement-classify.mjs <idea-dir>\n');
    process.exit(1);
  }
  try { console.log(JSON.stringify(writeRequirementClassification(resolve(ideaDir), resolve(projectRoot)), null, 2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
}
