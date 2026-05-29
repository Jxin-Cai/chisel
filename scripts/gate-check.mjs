#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_REWORK_COUNT, allTasksApproved, readFrontmatter, readTaskState, taskStateFile } from './workflow-lib.mjs';
import { validateTasksDocument } from './task-init.mjs';

import { getTaskScope } from './scope-check.mjs';

function detectComplexity(ideaDir) {
  const reqPath = join(ideaDir, 'requirement.md');
  if (!existsSync(reqPath)) return 'standard';
  const text = readFileSync(reqPath, 'utf8');
  const explicitMatch = text.match(/^##\s*复杂度[：:]\s*(trivial|standard|complex)\s*$/m);
  if (explicitMatch) return explicitMatch[1];
  const scopeSection = text.split('## 涉及范围')[1]?.split('##')[0] || '';
  const scopeItems = scopeSection.split('\n').filter(l => /^-\s+\S/.test(l)).length;
  const hasNewTable = /新增.*表|新.*table|create.*table|DDL/i.test(text);
  const hasNewApi = /新增.*接口|new.*api|新.*endpoint/i.test(text);
  if (scopeItems <= 2 && !hasNewTable && !hasNewApi) return 'trivial';
  if (scopeItems > 5) return 'complex';
  return 'standard';
}

function hasSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\s*$`, 'm').test(text);
}

const AS_IS_MAIN_FILES = [
  'as-is/repo-map.json',
  'as-is/overview.md',
  'as-is/core-walkthrough.md',
  'as-is/evidence-index.md',
  'as-is/evidence-ledger.json',
  'as-is/coverage-matrix.json',
  'as-is/knowledge-candidates.md',
  'as-is/context-budget.md',
  'as-is/quality-score.json'
];

const AI_INPUT_FILES = [
  'as-is/ai-input/facts.md',
  'as-is/ai-input/call-graph.md',
  'as-is/ai-input/data-schema.md',
  'as-is/ai-input/api-surface.md',
  'as-is/ai-input/constraints.md',
  'as-is/ai-input/change-surface.md'
];

const PLACEHOLDER_RE = /<[^>\n]+>/;

function has(ideaDir, rel) {
  return existsSync(join(ideaDir, rel));
}

function taskEntries(ideaDir) {
  return Object.entries(readTaskState(taskStateFile(ideaDir)).tasks || {});
}

function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function hasRequiredLines(file, needles) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  return needles.every(needle => text.includes(needle));
}

function fileHasMermaid(file) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  return text.includes('```mermaid');
}

function fileLineCount(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).length;
}

function sectionText(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^#{2,3}\\s+${escaped}[^\\n]*\\n([\\s\\S]*?)(?=^#{2,3}\\s+|(?![\\s\\S]))`, 'm'));
  return match ? match[1].trim() : '';
}

function meaningfulLines(text) {
  return String(text || '').split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('|---') && !/^\|\s*-+/.test(line) && !PLACEHOLDER_RE.test(line));
}

function hasMeaningfulSection(text, heading) {
  const body = sectionText(text, heading);
  const headerCells = new Set(['区域', '文件范围', '修改类型', '注意事项', '修改区域', '直接影响', '间接影响']);
  return meaningfulLines(body).some(line => {
    if (/^\|.*\|$/.test(line)) {
      const cells = line.split('|').map(cell => cell.trim()).filter(Boolean);
      return cells.some(cell => !headerCells.has(cell));
    }
    return !line.startsWith('```');
  });
}

function hasTemplatePlaceholder(text) {
  return PLACEHOLDER_RE.test(text) || text.includes('路径：') && text.includes('模块：') && text.includes('接口 / 行为：');
}

function arraysEqual(a = [], b = []) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validateAsIsOverview(ideaDir) {
  const overviewPath = join(ideaDir, 'as-is/overview.md');
  const overview = readText(overviewPath);
  const requiredSections = ['### 3分钟摘要', '### 读者导航', '### 风险地图', '### 常见误解点', '### 用户确认清单'];
  const missing = requiredSections.filter(section => !overview.includes(section));
  if (missing.length > 0) return `as-is overview is missing required user-understanding sections: ${missing.join(', ')}`;
  const checklist = sectionText(overview, '用户确认清单');
  const hasChecklistItem = meaningfulLines(checklist).some(line => /^- \[[ xX]\]\s*(?:\[C-\d{3}\]|C-\d{3})\s*[^：:\n]+[：:]\s*\S+/.test(line));
  if (!hasChecklistItem && !checklist.includes('无需用户确认')) return 'as-is overview 用户确认清单 must contain at least one C-xxx item or explicitly state 无需用户确认';
  const ledgerReason = validateEvidenceLedger(ideaDir);
  if (ledgerReason) return ledgerReason;
  return '';
}

function confirmationItemIds(ideaDir) {
  const overview = readText(join(ideaDir, 'as-is/overview.md'));
  const checklist = sectionText(overview, '用户确认清单');
  if (!checklist || checklist.includes('无需用户确认')) return [];
  return [...new Set([...checklist.matchAll(/\bC-\d{3}\b/g)].map(match => match[0]))];
}

const DECISION_STATUSES = new Set(['confirmed', 'defaulted', 'deferred']);

function validateClarificationDecisions(ideaDir) {
  const ids = confirmationItemIds(ideaDir);
  if (ids.length === 0) return '';
  const text = readText(join(ideaDir, 'clarifications.md'));
  const body = sectionText(text, '逐项决策记录');
  if (!body) return 'clarifications.md missing ## 逐项决策记录';
  for (const id of ids) {
    const row = body.split('\n').find(line => line.includes(id));
    if (!row) return `clarifications.md missing decision for ${id}`;
    const cells = row.split('|').map(cell => cell.trim()).filter(Boolean);
    const status = cells.at(-1);
    if (!DECISION_STATUSES.has(status)) return `${id} decision status must be confirmed/defaulted/deferred`;
  }
  return '';
}

function decisionIds(decisions = []) {
  return new Set(decisions.map(decision => decision?.id).filter(Boolean));
}

function validateClarificationsJson(ideaDir) {
  const file = join(ideaDir, 'clarifications.json');
  if (!existsSync(file)) return 'clarifications.json missing';
  const parsed = readJsonFile(file);
  if (parsed.error) return `clarifications.json invalid JSON: ${parsed.error}`;
  const doc = parsed.value;
  if (doc?.schema_version !== 1) return 'clarifications.json schema_version must be 1';
  if (doc.source_step !== 'understand:confirm') return 'clarifications.json source_step must be understand:confirm';
  if (!doc.confirmed_at || typeof doc.confirmed_at !== 'string') return 'clarifications.json missing confirmed_at';
  if (!doc.summary || typeof doc.summary !== 'string') return 'clarifications.json missing summary';
  if (!Array.isArray(doc.decisions)) return 'clarifications.json decisions must be an array';
  for (const [index, decision] of doc.decisions.entries()) {
    const label = decision?.id || `decisions[${index}]`;
    if (!/^C-\d{3}$/.test(decision?.id || '')) return `${label} missing valid C-xxx id`;
    if (!decision.question || typeof decision.question !== 'string') return `${label} missing question`;
    if (!decision.decision || typeof decision.decision !== 'string') return `${label} missing decision`;
    if (!decision.rationale || typeof decision.rationale !== 'string') return `${label} missing rationale`;
    if (!DECISION_STATUSES.has(decision.status)) return `${label} status must be confirmed/defaulted/deferred`;
    if (!decision.source || typeof decision.source !== 'string') return `${label} missing source`;
  }
  const requiredIds = confirmationItemIds(ideaDir);
  const actualIds = decisionIds(doc.decisions);
  for (const id of requiredIds) {
    if (!actualIds.has(id)) return `clarifications.json missing decision for ${id}`;
  }
  for (const field of ['answers', 'unresolved', 'constraints_added', 'knowledge_signals']) {
    if (doc[field] !== undefined && !Array.isArray(doc[field])) return `clarifications.json ${field} must be an array`;
  }
  return '';
}

function validateAiInput(ideaDir) {
  const missing = AI_INPUT_FILES.filter(file => !has(ideaDir, file));
  if (missing.length > 0) return `missing ai-input files: ${missing.join(', ')}`;
  for (const rel of AI_INPUT_FILES) {
    const text = readText(join(ideaDir, rel));
    if (hasTemplatePlaceholder(text)) return `${rel} still contains template placeholders`;
  }
  return '';
}

function validateTaskIntegrity(ideaDir) {
  if (!has(ideaDir, 'task-workflow-state.yaml')) return 'task-workflow-state.yaml missing';
  const entries = taskEntries(ideaDir);
  const taskIds = new Set(entries.map(([taskId]) => taskId));
  const requiredSections = [
    '## 目标行为',
    '### Allowed Files / Areas',
    '### Forbidden Files / Areas',
    '## Impact Surface',
    '## Context to Load',
    '## Traceability',
    '## Acceptance Criteria',
    '## Behavior Invariants'
  ];

  const parsedTasks = [];
  for (const [taskId, task] of entries) {
    const danglingDeps = (task.depends_on || []).filter(dep => !taskIds.has(dep));
    if (danglingDeps.length > 0) return `${taskId} has unknown dependencies: ${danglingDeps.join(', ')}`;

    const taskPath = join(ideaDir, task.file || `tasks/${taskId}.md`);
    if (!existsSync(taskPath)) return `missing task file: ${taskId}`;

    const text = readText(taskPath);
    const fm = readFrontmatter(text);
    parsedTasks.push([taskId, fm]);
    if (!Object.hasOwn(fm, 'expected_files')) return `${taskId} frontmatter missing expected_files`;
    const riskLevel = fm.risk_level || 'high';
    const riskSections = {
      low: ['## Acceptance Criteria'],
      medium: ['## Acceptance Criteria', '## Behavior Invariants', '### Forbidden Files / Areas'],
      high: requiredSections
    };
    const riskRequiredSections = riskSections[riskLevel] || requiredSections;
    const riskMissingSections = riskRequiredSections.filter(section => !text.includes(section));
    if (riskMissingSections.length > 0) return `${taskId} (risk_level=${riskLevel}) missing required sections: ${riskMissingSections.join(', ')}`;
    if (!arraysEqual(task.expected_files || [], fm.expected_files || [])) {
      return `${taskId} expected_files mismatch between state and task file`;
    }
  }

  const traceReason = validateTraceabilityMatrix(ideaDir, { requireTaskRefs: true });
  if (traceReason) return traceReason;

  return '';
}

function validateWikiLoadProof(text) {
  const required = ['## Wiki Entries Loaded', '## Progressive Load Proof'];
  const missing = required.filter(section => !hasSection(text, section));
  if (missing.length > 0) return `missing wiki proof sections: ${missing.join(', ')}`;
  const proof = `${sectionText(text, 'Wiki Entries Loaded')}\n${sectionText(text, 'Progressive Load Proof')}`;
  if (!/category\/min-score|load_plan/.test(proof)) return 'wiki proof must include category/min-score and load_plan';
  const hasLoadedEntry = /^\|\s*(FZ|WBI|DNR|TERM|ADR|HOTSPOT|MODULE)[-_A-Za-z0-9]*\b/im.test(proof);
  const hasEmptyDeclaration = /None matched|无命中/.test(proof);
  if (!hasLoadedEntry && !hasEmptyDeclaration) return 'wiki proof must include loaded entries or explicit None matched/无命中';
  return '';
}

function sectionTextAnyDepth(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^#{2,6}\\s+${escaped}[^\\n]*\\n([\\s\\S]*?)(?=^#{2,6}\\s+|(?![\\s\\S]))`, 'm'));
  return match ? match[1].trim() : '';
}

function parseMarkdownTableRows(section) {
  const rows = String(section || '').split('\n')
    .map(line => line.trim())
    .filter(line => /^\|.*\|$/.test(line))
    .map(line => line.split('|').map(cell => cell.trim()).slice(1, -1));
  const header = rows.find(cells => cells.some(cell => cell === 'Invariant'));
  if (!header) return { rows: [], columns: new Map() };
  const columns = new Map(header.map((cell, index) => [cell, index]));
  const dataRows = rows.filter(cells => cells !== header && !cells.every(cell => /^-+$/.test(cell)));
  return {
    columns,
    rows: dataRows.map(cells => ({
      invariant: cells[columns.get('Invariant')] || '',
      proof: cells[columns.get('Proof')] || '',
      result: cells[columns.get('Result')] || ''
    }))
  };
}

function normalizeInvariant(value) {
  return String(value || '')
    .replace(/^[-*]\s*(?:\[[ xX]\]\s*)?/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBlankProof(value) {
  const proof = String(value || '').trim();
  return !proof || PLACEHOLDER_RE.test(proof) || /^(?:-|—|无|N\/?A|TODO|TBD|待补)$/i.test(proof);
}

function validateInvariantProofs(text, behaviorInvariants = [], { requireAllPass = false } = {}) {
  const expected = behaviorInvariants.map(normalizeInvariant).filter(Boolean);
  if (expected.length === 0) return '';

  const section = sectionTextAnyDepth(text, 'Invariant Proofs');
  if (!section) return 'missing scope proof section: Invariant Proofs';
  const table = parseMarkdownTableRows(section);
  for (const column of ['Invariant', 'Proof', 'Result']) {
    if (!table.columns.has(column)) return 'Invariant Proofs table must include columns: Invariant, Proof, Result';
  }

  const rowsByInvariant = new Map();
  for (const row of table.rows) {
    const invariant = normalizeInvariant(row.invariant);
    if (!invariant) continue;
    rowsByInvariant.set(invariant, row);
    if (isBlankProof(row.proof)) return `invariant proof must be non-empty for: ${invariant}`;
    if (!/^(pass|fail)$/i.test(String(row.result || '').trim())) return `invariant result must be pass/fail for: ${invariant}`;
  }

  for (const invariant of expected) {
    const row = rowsByInvariant.get(invariant);
    if (!row) return `missing invariant proof: ${invariant}`;
    if (requireAllPass && String(row.result || '').trim().toLowerCase() !== 'pass') {
      return 'approved CR must have all invariant results: pass';
    }
  }

  return '';
}

function validateScopeProof(text, mode, { behaviorInvariants = [], requireAllInvariantPass = false } = {}) {
  const hitProofHeading = mode === 'cr' ? 'Hit Proofs Reviewed' : 'Hit Proofs Summary';
  if (!text.includes('scope-check.mjs')) return 'missing scope proof command: scope-check.mjs';
  if (!/Result[：:]\s*(pass|fail)\b/i.test(text)) return 'missing scope proof Result: pass/fail';
  if (!/schema_version[：:]\s*[23]\b/.test(text)) return 'missing scope proof schema_version: 2 or 3';
  if (!/violations_count[：:]\s*\d+\b/.test(text)) return 'missing numeric scope proof violations_count';
  if (/schema_version[：:]\s*3\b/.test(text) && !text.includes('Invariant Proofs')) return 'schema_version 3 scope proof must include Invariant Proofs';
  if (!text.includes(hitProofHeading)) return `missing scope proof section: ${hitProofHeading}`;
  const invariantReason = validateInvariantProofs(text, behaviorInvariants, { requireAllPass: requireAllInvariantPass });
  if (invariantReason) return invariantReason;
  if (mode === 'cr' && requireAllInvariantPass && !/Result[：:]\s*pass\b/i.test(text)) {
    return 'approved CR must have scope check Result: pass';
  }
  return '';
}

function validateTaskReport(reportPath, behaviorInvariants = [], traceRefs = []) {
  const text = readText(reportPath);
  if (!hasRequiredLines(reportPath, ['## 做了什么', '## 改了什么'])) return 'missing required report sections';
  if (traceRefs.length > 0) {
    if (!hasSection(text, '## Traceability Evidence')) return 'missing ## Traceability Evidence';
    const traceSection = sectionText(text, 'Traceability Evidence');
    for (const ref of traceRefs) {
      if (!traceSection.includes(ref)) return `Traceability Evidence missing ${ref}`;
    }
    const traceRows = meaningfulLines(traceSection).filter(line => /^\|.*\|$/.test(line));
    const hasEvidenceRow = traceRows.some(row => {
      const cells = row.split('|').map(cell => cell.trim()).filter(Boolean);
      return cells.length >= 3 && !cells.includes('Trace Ref') && !cells.every(cell => /^-+$/.test(cell));
    });
    if (!hasEvidenceRow) return 'Traceability Evidence must contain at least one evidence row';
  }
  const wikiProofReason = validateWikiLoadProof(text);
  if (wikiProofReason) return wikiProofReason;
  return validateScopeProof(text, 'report', { behaviorInvariants });
}

function validateCrFile(crPath, status, behaviorInvariants = []) {
  const text = readText(crPath);
  const required = ['## 结论', '## 功能完整度', '## Scope Control', '## Rework Items'];
  const missing = required.filter(section => !hasSection(text, section));
  if (missing.length > 0) return `missing sections: ${missing.join(', ')}`;
  const reworkCount = Number(readFrontmatter(text).rework_count || 0);
  if (reworkCount > 0 && !hasSection(text, 'Rework Verification'))
    return 'CR with rework_count > 0 must include ## Rework Verification section';
  const wikiProofReason = validateWikiLoadProof(text);
  if (wikiProofReason) return wikiProofReason;
  const crResult = readFrontmatter(text).result || status;
  const scopeProofReason = validateScopeProof(text, 'cr', { behaviorInvariants, requireAllInvariantPass: crResult === 'approved' });
  if (scopeProofReason) return scopeProofReason;
  if (crResult === 'needs_rework' && !/\bCR-\d{3}\b/.test(text)) return 'needs_rework CR must include at least one CR-xxx rework item';
  return '';
}

const REVIEW_DIMENSIONS = ['spec', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];
const QUALITY_REVIEW_DIMENSIONS = ['d2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];

function dimensionCrPath(ideaDir, dimension) {
  return join(ideaDir, `cr/dim-${dimension}-cr.md`);
}

function taskStatusMap(ideaDir) {
  return new Map(taskEntries(ideaDir).map(([taskId, task]) => [taskId, task.status]));
}

function affectedTasks(fm) {
  return Array.isArray(fm.affected_tasks) ? fm.affected_tasks.filter(Boolean) : [];
}

function validateAffectedTaskStatuses(ideaDir, taskIds, allowedStatuses) {
  const statuses = taskStatusMap(ideaDir);
  for (const taskId of taskIds) {
    const status = statuses.get(taskId);
    if (!status) return `affected task not found in task workflow: ${taskId}`;
    if (!allowedStatuses.includes(status)) return `affected task ${taskId} status must be ${allowedStatuses.join('/')} but is ${status}`;
  }
  return '';
}

function behaviorInvariantsForTasks(ideaDir, taskIds) {
  return [...new Set(taskIds.flatMap(taskId => getTaskScope(ideaDir, taskId).behaviorInvariants || []))];
}

function validateDimensionCrFile(ideaDir, dimension) {
  const crPath = dimensionCrPath(ideaDir, dimension);
  if (!existsSync(crPath)) return { valid: false, reason: `cr/dim-${dimension}-cr.md missing` };

  const text = readText(crPath);
  const fm = readFrontmatter(text);
  if (fm.dimension !== dimension) return { valid: false, reason: `cr/dim-${dimension}-cr.md dimension must be ${dimension}` };
  if (!['pass', 'fail'].includes(fm.result)) return { valid: false, reason: `cr/dim-${dimension}-cr.md result must be pass/fail` };
  if (!Array.isArray(fm.affected_tasks)) return { valid: false, reason: `cr/dim-${dimension}-cr.md affected_tasks must be an array` };
  if (!Number.isFinite(Number(fm.rework_count || 0))) return { valid: false, reason: `cr/dim-${dimension}-cr.md rework_count must be numeric` };

  const required = dimension === 'spec'
    ? ['## 结论', '## Acceptance Criteria 覆盖', '## Expected Files 覆盖', '## Scope Check Proof']
    : ['## 结论', '## 检查结果', '## Scope Check Proof', '## Rework Items'];
  const missing = required.filter(section => !hasSection(text, section));
  if (missing.length > 0) return { valid: false, reason: `cr/dim-${dimension}-cr.md missing sections: ${missing.join(', ')}` };

  const wikiProofReason = validateWikiLoadProof(text);
  if (wikiProofReason) return { valid: false, reason: `cr/dim-${dimension}-cr.md ${wikiProofReason}` };
  const invariants = behaviorInvariantsForTasks(ideaDir, affectedTasks(fm));
  const scopeProofReason = validateScopeProof(text, 'cr', { behaviorInvariants: invariants, requireAllInvariantPass: fm.result === 'pass' });
  if (scopeProofReason) return { valid: false, reason: `cr/dim-${dimension}-cr.md ${scopeProofReason}` };

  const reworkCount = Number(fm.rework_count || 0);
  if (reworkCount > 0 && !hasSection(text, 'Rework Verification')) {
    return { valid: false, reason: `cr/dim-${dimension}-cr.md with rework_count > 0 must include ## Rework Verification section` };
  }
  if (fm.result === 'fail') {
    const issuePattern = dimension === 'spec' ? /\bSPEC-\d{3}\b/ : new RegExp(`\\bCR-\\d{3}\\s*\\[${dimension.toUpperCase()}\\]`);
    if (!issuePattern.test(text)) return { valid: false, reason: `cr/dim-${dimension}-cr.md fail result must include ${dimension === 'spec' ? 'SPEC-xxx' : `CR-xxx [${dimension.toUpperCase()}]`} item` };
  }

  return { valid: true, fm };
}

function validateLegacyRequirementCr(ideaDir, gateId) {
  const reqCrPath = join(ideaDir, 'cr/requirement-cr.md');
  if (!existsSync(reqCrPath)) return result(gateId, false, 'cr/requirement-cr.md missing');
  const crText = readText(reqCrPath);
  const crFm = readFrontmatter(crText);
  if (crFm.review_level !== 'requirement') return result(gateId, false, 'cr/requirement-cr.md review_level must be requirement');
  if (!['approved', 'needs_rework', 'blocked'].includes(crFm.result)) return result(gateId, false, 'cr/requirement-cr.md result must be approved/needs_rework/blocked');
  const required = ['## 结论', '## 需求覆盖度', '## Scope Control'];
  const missing = required.filter(section => !crText.includes(section));
  if (missing.length > 0) return result(gateId, false, `requirement-cr.md missing sections: ${missing.join(', ')}`);
  const reworkCount = Number(crFm.rework_count || 0);
  if (reworkCount > 0 && !hasSection(crText, 'Rework Verification'))
    return result(gateId, false, 'CR with rework_count > 0 must include ## Rework Verification section');
  return result(gateId, true, '', { legacy: true });
}

function validateDimensionCrComplete(ideaDir, gateId) {
  const hasAnyDimensionCr = REVIEW_DIMENSIONS.some(dimension => existsSync(dimensionCrPath(ideaDir, dimension)));
  if (!hasAnyDimensionCr) return validateLegacyRequirementCr(ideaDir, gateId);

  const spec = validateDimensionCrFile(ideaDir, 'spec');
  if (!spec.valid) return result(gateId, false, spec.reason);
  const specAffectedTasks = affectedTasks(spec.fm);
  if (spec.fm.result === 'fail') {
    if (specAffectedTasks.length === 0) return result(gateId, false, 'dim-spec fail result must include affected_tasks');
    const statusReason = validateAffectedTaskStatuses(ideaDir, specAffectedTasks, ['needs_rework', 'blocked']);
    return statusReason ? result(gateId, false, statusReason) : result(gateId, true, '', { review_result: 'needs_rework', dimensions: ['spec'] });
  }

  const parsedDimensions = [spec];
  for (const dimension of QUALITY_REVIEW_DIMENSIONS) {
    const parsed = validateDimensionCrFile(ideaDir, dimension);
    if (!parsed.valid) return result(gateId, false, parsed.reason);
    parsedDimensions.push(parsed);
  }

  const failed = parsedDimensions.filter(parsed => parsed.fm.result === 'fail');
  if (failed.length === 0) {
    return allTasksApproved(ideaDir)
      ? result(gateId, true, '', { review_result: 'approved', dimensions: REVIEW_DIMENSIONS })
      : result(gateId, false, 'all dimension CRs passed but not all tasks are approved');
  }

  const failedTasks = [...new Set(failed.flatMap(parsed => affectedTasks(parsed.fm)))];
  if (failedTasks.length === 0) return result(gateId, false, 'failed dimension CRs must include affected_tasks');
  const statusReason = validateAffectedTaskStatuses(ideaDir, failedTasks, ['needs_rework', 'blocked']);
  return statusReason ? result(gateId, false, statusReason) : result(gateId, true, '', { review_result: 'needs_rework', dimensions: REVIEW_DIMENSIONS });
}

const MIN_EVIDENCE_LINES = 5;
const KNOWLEDGE_CATEGORIES = new Set(['forbidden_zone', 'weird_but_intentional', 'smell', 'glossary']);
const KNOWLEDGE_STATUSES = new Set(['proposed', 'confirmed', 'merged', 'rejected', 'deferred']);
const KNOWLEDGE_TERMINAL_STATUSES = new Set(['merged', 'rejected', 'deferred']);
const KNOWLEDGE_CONTENT_KEYS = {
  forbidden_zone: ['范围', '原因'],
  weird_but_intentional: ['现象', '原因'],
  smell: ['坏味道', '位置', '本次不处理原因'],
  glossary: ['术语', '定义']
};

function knowledgeCandidatesDir(ideaDir) {
  return join(ideaDir, 'knowledge-candidates');
}

function knowledgeCandidateFiles(ideaDir) {
  const dir = knowledgeCandidatesDir(ideaDir);
  if (!existsSync(dir)) return { missing: true, jsonFiles: [], markdownFiles: [] };
  const files = readdirSync(dir).filter(file => !file.startsWith('.'));
  return {
    missing: false,
    jsonFiles: files.filter(file => file.endsWith('.json')).map(file => join(dir, file)),
    markdownFiles: files.filter(file => file.endsWith('.md'))
  };
}

function sanitizeSmartQuotes(text) {
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

function readJsonFile(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    return { value: JSON.parse(sanitizeSmartQuotes(raw)) };
  } catch (error) {
    return { error: error.message };
  }
}

function factIds(text) {
  return [...new Set([...String(text || '').matchAll(/\[F-\d{3}\]/g)].map(match => match[0].slice(1, -1)))];
}

function validateEvidenceLedger(ideaDir) {
  const ledgerPath = join(ideaDir, 'as-is/evidence-ledger.json');
  if (!existsSync(ledgerPath)) return 'as-is/evidence-ledger.json missing';
  const parsed = readJsonFile(ledgerPath);
  if (parsed.error) return `as-is/evidence-ledger.json invalid JSON: ${parsed.error}`;
  const facts = parsed.value?.facts;
  if (!Array.isArray(facts) || facts.length === 0) return 'as-is/evidence-ledger.json must contain non-empty facts array';
  const ids = new Set();
  for (const [index, fact] of facts.entries()) {
    const label = fact?.id || `facts[${index}]`;
    if (!/^F-\d{3}$/.test(fact?.id || '')) return `${label} missing valid F-xxx id`;
    if (ids.has(fact.id)) return `${fact.id} is duplicated in evidence-ledger`;
    ids.add(fact.id);
    if (!fact.claim || typeof fact.claim !== 'string') return `${label} missing claim`;
    if (fact.status !== 'confirmed') return `${label} status must be "confirmed" (got "${fact.status || ''}")`;
    if (!Array.isArray(fact.evidence) || fact.evidence.length === 0) return `${label} missing evidence`;
    for (const [evidenceIndex, evidence] of fact.evidence.entries()) {
      if (!evidence?.file || typeof evidence.file !== 'string') return `${label} evidence[${evidenceIndex}] missing file`;
      if (!Number.isInteger(evidence.line_start) || evidence.line_start <= 0) return `${label} evidence[${evidenceIndex}] missing positive line_start`;
      if (evidence.line_end !== undefined && (!Number.isInteger(evidence.line_end) || evidence.line_end < evidence.line_start)) return `${label} evidence[${evidenceIndex}] has invalid line_end`;
    }
  }
  return '';
}

function evidenceLedgerFactIds(ideaDir) {
  const parsed = readJsonFile(join(ideaDir, 'as-is/evidence-ledger.json'));
  if (parsed.error || !Array.isArray(parsed.value?.facts)) return new Set();
  return new Set(parsed.value.facts.map(fact => fact.id).filter(Boolean));
}

function evidenceHasFileLine(evidence) {
  return Boolean(evidence && typeof evidence.file === 'string' && Number.isInteger(evidence.line_start) && evidence.line_start > 0);
}

function itemEvidence(item) {
  if (Array.isArray(item?.evidence)) return item.evidence;
  return item?.location ? [item.location] : [];
}

function validateAsIsCoverageMatrix(ideaDir) {
  const file = join(ideaDir, 'as-is/coverage-matrix.json');
  if (!existsSync(file)) return 'as-is/coverage-matrix.json missing';
  const parsed = readJsonFile(file);
  if (parsed.error) return `as-is/coverage-matrix.json invalid JSON: ${parsed.error}`;
  const doc = parsed.value;
  if (doc?.schema_version !== 1) return 'coverage-matrix.json schema_version must be 1';
  const ledgerIds = evidenceLedgerFactIds(ideaDir);
  for (const section of ['entrypoints', 'links', 'data', 'side_effects']) {
    const items = doc?.[section];
    if (!Array.isArray(items)) return `coverage-matrix.json ${section} must be an array`;
    const naReason = doc?.not_applicable?.[section];
    if (items.length === 0 && !String(naReason || '').trim()) return `coverage-matrix.json ${section} must contain items or not_applicable reason`;
    for (const [index, item] of items.entries()) {
      const label = `${section}[${index}]`;
      if (!item?.id || typeof item.id !== 'string') return `${label} missing id`;
      const hasDescription = ['name', 'description', 'from', 'entity'].some(key => String(item[key] || '').trim());
      if (!hasDescription) return `${label} missing name/description/from/entity`;
      if (section === 'links') {
        const validDepths = ['happy_path_only', 'error_paths_included', 'all_branches'];
        if (!validDepths.includes(item.depth)) return `${label} missing valid depth (must be happy_path_only, error_paths_included, or all_branches)`;
      }
      const evidence = itemEvidence(item);
      if (evidence.length === 0) return `${label} missing evidence or location`;
      const invalidEvidenceIndex = evidence.findIndex(entry => !evidenceHasFileLine(entry));
      if (invalidEvidenceIndex >= 0) return `${label} evidence[${invalidEvidenceIndex}] missing file or positive line_start`;
      const unknownFacts = (item.covered_by_facts || []).filter(id => !ledgerIds.has(id));
      if (unknownFacts.length > 0) return `${label} references unknown facts: ${unknownFacts.join(', ')}`;
    }
  }
  return '';
}

function validateRepoMap(ideaDir) {
  const file = join(ideaDir, 'as-is/repo-map.json');
  if (!existsSync(file)) return 'as-is/repo-map.json missing';
  const parsed = readJsonFile(file);
  if (parsed.error) return `as-is/repo-map.json invalid JSON: ${parsed.error}`;
  const doc = parsed.value;
  if (doc?.schema_version !== 1 && doc?.schema_version !== 2 && doc?.schema_version !== 3) return 'repo-map.json schema_version must be 1, 2, or 3';
  if (!doc.generated_at || typeof doc.generated_at !== 'string') return 'repo-map.json missing generated_at';
  if (!Array.isArray(doc.languages) || doc.languages.length === 0) return 'repo-map.json languages must be non-empty array';
  for (const [index, lang] of doc.languages.entries()) {
    if (!lang?.language || typeof lang.language !== 'string') return `repo-map.json languages[${index}] missing language`;
    if (!Number.isInteger(lang.file_count) || lang.file_count <= 0) return `repo-map.json languages[${index}] missing positive file_count`;
  }
  if (!doc.stats || typeof doc.stats !== 'object') return 'repo-map.json missing stats';
  if (!Number.isInteger(doc.stats.total_files) || doc.stats.total_files <= 0) return 'repo-map.json stats.total_files must be positive';
  if (!Number.isInteger(doc.stats.source_files)) return 'repo-map.json stats.source_files must be integer';
  if (doc.schema_version === 1) {
    if (!Array.isArray(doc.entry_candidates)) return 'repo-map.json entry_candidates must be an array';
    for (const [index, entry] of doc.entry_candidates.entries()) {
      if (!entry?.file || typeof entry.file !== 'string') return `repo-map.json entry_candidates[${index}] missing file`;
      if (!entry.type || typeof entry.type !== 'string') return `repo-map.json entry_candidates[${index}] missing type`;
    }
    if (!Array.isArray(doc.core_modules)) return 'repo-map.json core_modules must be an array';
  }
  if (doc.schema_version === 3 && Array.isArray(doc.entry_candidates)) {
    for (const [index, entry] of doc.entry_candidates.entries()) {
      if (!entry?.file || typeof entry.file !== 'string') return `repo-map.json entry_candidates[${index}] missing file`;
    }
  }
  if (!Array.isArray(doc.directory_summary)) return 'repo-map.json directory_summary must be an array';
  return '';
}

function validateContextBudget(ideaDir) {
  const file = join(ideaDir, 'as-is/context-budget.md');
  if (!existsSync(file)) return 'as-is/context-budget.md missing';
  const text = readText(file);
  const requiredSections = ['## 已读文件清单', '## 未读但可能相关的文件', '## 上下文覆盖度自评'];
  const missing = requiredSections.filter(s => !text.includes(s));
  if (missing.length > 0) return `context-budget.md missing sections: ${missing.join(', ')}`;
  const readSection = sectionText(text, '已读文件清单');
  const rows = meaningfulLines(readSection).filter(l => /^\|.*\|$/.test(l));
  const dataRows = rows.filter(row => {
    const cells = row.split('|').map(c => c.trim()).filter(Boolean);
    return cells.length >= 3 && !cells.every(c => /^-+$/.test(c)) && !cells.includes('文件');
  });
  if (dataRows.length === 0) return 'context-budget.md 已读文件清单 must contain at least one file entry';
  const coverageSection = sectionText(text, '上下文覆盖度自评');
  if (!coverageSection || meaningfulLines(coverageSection).length < 2) return 'context-budget.md 上下文覆盖度自评 must contain coverage assessment';
  return '';
}

const QUALITY_SCORE_DIMENSIONS = ['coverage', 'evidence_density', 'uncertainty', 'diagram', 'structure', 'risk_awareness'];

function validateQualityScore(ideaDir) {
  const file = join(ideaDir, 'as-is/quality-score.json');
  if (!existsSync(file)) return 'as-is/quality-score.json missing';
  const parsed = readJsonFile(file);
  if (parsed.error) return `as-is/quality-score.json invalid JSON: ${parsed.error}`;
  const doc = parsed.value;
  if (doc?.schema_version !== 1 && doc?.schema_version !== 2) return 'quality-score.json schema_version must be 1 or 2';
  if (typeof doc.overall !== 'number' || doc.overall < 0 || doc.overall > 1) return 'quality-score.json overall must be 0-1';
  if (!doc.dimensions || typeof doc.dimensions !== 'object') return 'quality-score.json missing dimensions';
  for (const dim of QUALITY_SCORE_DIMENSIONS) {
    const d = doc.dimensions[dim];
    if (!d || typeof d.score !== 'number') return `quality-score.json dimensions.${dim} missing score`;
    if (d.score < 0 || d.score > 1) return `quality-score.json dimensions.${dim}.score must be 0-1`;
  }
  if (doc.overall < 0.6) return `quality-score.json overall ${doc.overall} is below minimum threshold 0.6`;
  const complexity = detectComplexity(ideaDir);
  for (const dim of QUALITY_SCORE_DIMENSIONS) {
    if (dim === 'risk_awareness' && complexity === 'standard') continue;
    if (doc.dimensions[dim].score < 0.3) return `quality-score.json ${dim} score ${doc.dimensions[dim].score} is below minimum threshold 0.3`;
  }
  return '';
}

function validateTraceabilityMatrix(ideaDir, { requireTaskRefs = false, taskIdsOverride = null, traceRefsOverride = null } = {}) {
  const matrixPath = join(ideaDir, 'to-be/traceability-matrix.json');
  if (!existsSync(matrixPath)) return 'to-be/traceability-matrix.json missing';
  const parsed = readJsonFile(matrixPath);
  if (parsed.error) return `to-be/traceability-matrix.json invalid JSON: ${parsed.error}`;
  const items = parsed.value?.items;
  if (!Array.isArray(items) || items.length === 0) return 'traceability-matrix.json must contain non-empty items array';
  const ids = new Set();
  const state = has(ideaDir, 'task-workflow-state.yaml') ? readTaskState(taskStateFile(ideaDir)) : { tasks: {} };
  const taskIds = taskIdsOverride || new Set(Object.keys(state.tasks || {}));
  for (const [index, item] of items.entries()) {
    const label = item?.id || `items[${index}]`;
    if (!item?.id || typeof item.id !== 'string') return `${label} missing id`;
    if (ids.has(item.id)) return `${item.id} is duplicated in traceability-matrix`;
    ids.add(item.id);
    if (!item.type || typeof item.type !== 'string') return `${label} missing type`;
    if (!item.description || typeof item.description !== 'string') return `${label} missing description`;
    if (!Array.isArray(item.covered_by_tasks) || item.covered_by_tasks.length === 0) return `${label} must be covered by at least one task`;
    if (requireTaskRefs) {
      const missingTasks = item.covered_by_tasks.filter(taskId => !taskIds.has(taskId));
      if (missingTasks.length > 0) return `${label} references unknown tasks: ${missingTasks.join(', ')}`;
    }
  }
  if (traceRefsOverride) {
    for (const [taskId, refs] of traceRefsOverride.entries()) {
      if (!Array.isArray(refs) || refs.length === 0) return `${taskId} missing trace_refs`;
      const missingRefs = refs.filter(ref => !ids.has(ref));
      if (missingRefs.length > 0) return `${taskId} references unknown trace_refs: ${missingRefs.join(', ')}`;
    }
  } else if (requireTaskRefs) {
    for (const [taskId, task] of Object.entries(state.tasks || {})) {
      const taskPath = join(ideaDir, task.file || `tasks/${taskId}.md`);
      const fm = existsSync(taskPath) ? readFrontmatter(readText(taskPath)) : {};
      const refs = Array.isArray(fm.trace_refs) ? fm.trace_refs : [];
      if (refs.length === 0) return `${taskId} frontmatter missing trace_refs`;
      const missingRefs = refs.filter(ref => !ids.has(ref));
      if (missingRefs.length > 0) return `${taskId} references unknown trace_refs: ${missingRefs.join(', ')}`;
    }
  }
  return '';
}

function validateTasksJsonAgainstTraceability(ideaDir) {
  const tasksPath = join(ideaDir, 'to-be/tasks.json');
  if (!existsSync(tasksPath)) return 'to-be/tasks.json missing';
  const parsed = readJsonFile(tasksPath);
  if (parsed.error) return `to-be/tasks.json invalid JSON: ${parsed.error}`;
  let tasks;
  try {
    tasks = validateTasksDocument(parsed.value);
  } catch (error) {
    return `to-be/tasks.json ${error.message}`;
  }
  const taskIds = new Set(tasks.map(task => task.task_id));
  const traceRefs = new Map(tasks.map(task => [task.task_id, task.trace_refs]));
  return validateTraceabilityMatrix(ideaDir, { requireTaskRefs: true, taskIdsOverride: taskIds, traceRefsOverride: traceRefs });
}

const VALID_CP_DECISIONS = new Set(['改造', '新增', '删除']);
const VALID_FLOW_DECISIONS = new Set(['保留', '改造', '新增', '删除']);
const VALID_RISK_CATEGORIES = new Set(['并发安全', '数据一致性', '接口兼容', '回滚困难', '性能退化', '其他']);
const VALID_LEVELS = new Set(['low', 'medium', 'high']);

function validateImpactRiskReport(ideaDir) {
  const file = join(ideaDir, 'to-be/impact-risk-report.json');
  if (!existsSync(file)) return 'to-be/impact-risk-report.json missing';
  const parsed = readJsonFile(file);
  if (parsed.error) return `to-be/impact-risk-report.json invalid JSON: ${parsed.error}`;
  const doc = parsed.value;
  if (doc?.schema_version !== 1) return 'impact-risk-report.json schema_version must be 1';
  if (!doc.generated_at || typeof doc.generated_at !== 'string') return 'impact-risk-report.json missing generated_at';
  if (!doc.summary || typeof doc.summary !== 'object') return 'impact-risk-report.json missing summary';
  if (!VALID_LEVELS.has(doc.summary.risk_level)) return 'impact-risk-report.json summary.risk_level must be low/medium/high';
  if (!Array.isArray(doc.change_points)) return 'impact-risk-report.json change_points must be an array';
  if (!Array.isArray(doc.risk_matrix)) return 'impact-risk-report.json risk_matrix must be an array';
  if (!Array.isArray(doc.reuse_nodes)) return 'impact-risk-report.json reuse_nodes must be an array';
  if (!doc.flow_graph || typeof doc.flow_graph !== 'object') return 'impact-risk-report.json missing flow_graph';

  const cpIds = new Set();
  for (const [index, cp] of doc.change_points.entries()) {
    const label = cp?.id || `change_points[${index}]`;
    if (!cp?.id || !/^CP-\d+$/.test(cp.id)) return `${label} id must match CP-N format`;
    if (cpIds.has(cp.id)) return `${cp.id} is duplicated in change_points`;
    cpIds.add(cp.id);
    if (!VALID_CP_DECISIONS.has(cp.decision)) return `${label} decision must be 改造/新增/删除`;
    if (!VALID_LEVELS.has(cp.risk_level)) return `${label} risk_level must be low/medium/high`;
  }

  for (const [index, risk] of doc.risk_matrix.entries()) {
    const label = risk?.id || `risk_matrix[${index}]`;
    if (!risk?.id) return `${label} missing id`;
    if (!VALID_RISK_CATEGORIES.has(risk.category)) return `${label} category must be one of: 并发安全/数据一致性/接口兼容/回滚困难/性能退化/其他`;
    if (!VALID_LEVELS.has(risk.severity)) return `${label} severity must be low/medium/high`;
    if (!VALID_LEVELS.has(risk.likelihood)) return `${label} likelihood must be low/medium/high`;
    const unknownCps = (risk.affected_cps || []).filter(ref => !cpIds.has(ref));
    if (unknownCps.length > 0) return `${label} references unknown change_points: ${unknownCps.join(', ')}`;
  }

  const fg = doc.flow_graph;
  if (!Array.isArray(fg.nodes)) return 'impact-risk-report.json flow_graph.nodes must be an array';
  if (!Array.isArray(fg.edges)) return 'impact-risk-report.json flow_graph.edges must be an array';
  const nodeIds = new Set();
  for (const [index, node] of fg.nodes.entries()) {
    const label = `flow_graph.nodes[${index}]`;
    if (!node?.id) return `${label} missing id`;
    if (nodeIds.has(node.id)) return `${label} id '${node.id}' is duplicated`;
    nodeIds.add(node.id);
    if (!VALID_FLOW_DECISIONS.has(node.decision)) return `${label} decision must be 保留/改造/新增/删除`;
    if (node.decision !== '保留') {
      if (!node.cp_ref || !cpIds.has(node.cp_ref)) return `${label} non-reserved node must have valid cp_ref referencing a change_point`;
    }
  }
  for (const [index, edge] of fg.edges.entries()) {
    const label = `flow_graph.edges[${index}]`;
    if (!edge?.from || !nodeIds.has(edge.from)) return `${label} from references unknown node: ${edge.from}`;
    if (!edge?.to || !nodeIds.has(edge.to)) return `${label} to references unknown node: ${edge.to}`;
  }

  return '';
}

function validateAsIsConfirmation(ideaDir) {
  const file = join(ideaDir, 'confirmations/as-is.json');
  if (!existsSync(file)) return 'confirmations/as-is.json missing';
  const parsed = readJsonFile(file);
  if (parsed.error) return `confirmations/as-is.json invalid JSON: ${parsed.error}`;
  const doc = parsed.value;
  if (doc?.schema_version !== 1) return 'confirmations/as-is.json schema_version must be 1';
  if (doc.phase !== 'as-is') return 'confirmations/as-is.json phase must be as-is';
  if (doc.status !== 'confirmed') return 'confirmations/as-is.json status must be confirmed';
  if (!doc.confirmed_at || typeof doc.confirmed_at !== 'string') return 'confirmations/as-is.json missing confirmed_at';
  if (!doc.confirmed_by || typeof doc.confirmed_by !== 'string') return 'confirmations/as-is.json missing confirmed_by';
  if (!Array.isArray(doc.source_files)) return 'confirmations/as-is.json source_files must be an array';
  for (const source of ['as-is/overview.md', 'as-is/core-walkthrough.md', 'as-is/evidence-index.md', 'as-is/evidence-ledger.json', 'as-is/coverage-matrix.json', 'clarifications.json']) {
    if (!doc.source_files.includes(source)) return `confirmations/as-is.json source_files missing ${source}`;
  }
  if (!Array.isArray(doc.checklist)) return 'confirmations/as-is.json checklist must be an array';
  const checklistById = new Map(doc.checklist.map(item => [item?.id, item]));
  for (const id of confirmationItemIds(ideaDir)) {
    const item = checklistById.get(id);
    if (!item) return `confirmations/as-is.json checklist missing ${id}`;
    if (!DECISION_STATUSES.has(item.status)) return `${id} confirmation status must be confirmed/defaulted/deferred`;
  }
  return validateClarificationsJson(ideaDir);
}

function validateToBeConfirmation(ideaDir) {
  const file = join(ideaDir, 'confirmations/to-be.json');
  if (!existsSync(file)) return 'confirmations/to-be.json missing';
  const parsed = readJsonFile(file);
  if (parsed.error) return `confirmations/to-be.json invalid JSON: ${parsed.error}`;
  const doc = parsed.value;
  if (doc?.schema_version !== 1) return 'confirmations/to-be.json schema_version must be 1';
  if (doc.phase !== 'to-be') return 'confirmations/to-be.json phase must be to-be';
  if (doc.status !== 'confirmed') return 'confirmations/to-be.json status must be confirmed';
  if (!doc.confirmed_at || typeof doc.confirmed_at !== 'string') return 'confirmations/to-be.json missing confirmed_at';
  if (!doc.confirmed_by || typeof doc.confirmed_by !== 'string') return 'confirmations/to-be.json missing confirmed_by';
  if (!Array.isArray(doc.source_files)) return 'confirmations/to-be.json source_files must be an array';
  for (const source of ['to-be/implementation-plan.md', 'to-be/tasks.json', 'to-be/traceability-matrix.json', 'to-be/impact-risk-report.json']) {
    if (!doc.source_files.includes(source)) return `confirmations/to-be.json source_files missing ${source}`;
  }
  const planContent = readText(join(ideaDir, 'to-be/implementation-plan.md'));
  if (!planContent.includes('## 变更完整性自检结果')) return 'to-be/implementation-plan.md missing "## 变更完整性自检结果" section (planner self-review required)';
  if (!planContent.includes('### 伴生变更推断')) return 'to-be/implementation-plan.md missing "### 伴生变更推断" section';
  const parsedTasks = readJsonFile(join(ideaDir, 'to-be/tasks.json'));
  if (parsedTasks.error) return `to-be/tasks.json invalid JSON: ${parsedTasks.error}`;
  let tasks;
  try {
    tasks = validateTasksDocument(parsedTasks.value);
  } catch (error) {
    return `to-be/tasks.json ${error.message}`;
  }
  const acknowledged = new Set(doc.task_acknowledgement?.task_ids || []);
  for (const task of tasks) {
    if (!acknowledged.has(task.task_id)) return `confirmations/to-be.json task_acknowledgement missing ${task.task_id}`;
  }
  if (doc.task_acknowledgement?.dependencies_reviewed !== true) return 'confirmations/to-be.json dependencies_reviewed must be true';
  if (doc.risk_acknowledgement?.reviewed !== true) return 'confirmations/to-be.json risk_acknowledgement.reviewed must be true';
  return '';
}

function hasDecisionReason(candidate) {
  return Boolean(candidate.decision && typeof candidate.decision.reason === 'string' && candidate.decision.reason.trim());
}

function validCandidateEvidence(evidence) {
  if (typeof evidence === 'string') return /^[^\s:]+(?:\/[^\s:]+)*:\d+\b/.test(evidence.trim());
  return Boolean(evidence && typeof evidence.file === 'string' && Number.isInteger(evidence.line_start) && evidence.line_start > 0);
}

function validateKnowledgeCandidate(candidate, mode = 'base') {
  const missing = [];
  for (const field of ['id', 'category', 'status', 'source_step']) {
    if (!candidate?.[field]) missing.push(field);
  }
  if (typeof candidate?.confirmed !== 'boolean') missing.push('confirmed');
  if (!Array.isArray(candidate?.evidence) || candidate.evidence.length === 0) missing.push('evidence');
  if (!candidate?.content || typeof candidate.content !== 'object' || Array.isArray(candidate.content) || Object.keys(candidate.content).length === 0) missing.push('content');
  if (missing.length > 0) return `missing required fields: ${missing.join(', ')}`;
  if (!KNOWLEDGE_CATEGORIES.has(candidate.category)) return `unsupported category: ${candidate.category}`;
  if (!KNOWLEDGE_STATUSES.has(candidate.status)) return `unsupported status: ${candidate.status}`;
  if (candidate.quality_score !== undefined && (!Number.isFinite(candidate.quality_score) || candidate.quality_score < 0)) return 'quality_score must be >= 0 when provided';
  if (!Array.isArray(candidate.keywords) || candidate.keywords.filter(Boolean).length === 0) return 'keywords must not be empty';
  const invalidEvidenceIndex = candidate.evidence.findIndex(evidence => !validCandidateEvidence(evidence));
  if (invalidEvidenceIndex >= 0) return `evidence[${invalidEvidenceIndex}] must be structured file/line_start or legacy file:line string`;
  const missingContentKeys = (KNOWLEDGE_CONTENT_KEYS[candidate.category] || []).filter(key => !String(candidate.content[key] || '').trim());
  if (missingContentKeys.length > 0) return `content missing required keys: ${missingContentKeys.join(', ')}`;
  if (candidate.status === 'confirmed' && candidate.confirmed !== true) return 'confirmed candidate must set confirmed=true';

  if (mode === 'extracted') {
    if (!KNOWLEDGE_TERMINAL_STATUSES.has(candidate.status)) return `candidate is not in terminal status: ${candidate.status}`;
    if (candidate.status === 'merged') {
      if (candidate.confirmed !== true) return 'merged candidate must set confirmed=true';
      if (!candidate.merge?.wiki_file || !candidate.merge?.entry_id) return 'merged candidate missing merge.wiki_file or merge.entry_id';
    }
    if (['rejected', 'deferred'].includes(candidate.status) && !hasDecisionReason(candidate)) {
      return `${candidate.status} candidate missing decision.reason`;
    }
  }
  return '';
}

function validateKnowledgeCandidatesExist(ideaDir) {
  const files = knowledgeCandidateFiles(ideaDir);
  if (files.missing) return 'knowledge-candidates directory missing';
  if (files.markdownFiles.length > 0) return `legacy markdown candidate files are not gate-checkable: ${files.markdownFiles.join(', ')}`;
  for (const file of files.jsonFiles) {
    const parsed = readJsonFile(file);
    if (parsed.error) return `${file} invalid JSON: ${parsed.error}`;
    const reason = validateKnowledgeCandidate(parsed.value, 'base');
    if (reason) return `${file} ${reason}`;
  }
  return '';
}

function validateKnowledgeExtracted(ideaDir) {
  if (!has(ideaDir, '.knowledge-extracted')) return '.knowledge-extracted missing';
  const baseReason = validateKnowledgeCandidatesExist(ideaDir);
  if (baseReason) return baseReason;
  const files = knowledgeCandidateFiles(ideaDir);
  for (const file of files.jsonFiles) {
    const parsed = readJsonFile(file);
    const reason = validateKnowledgeCandidate(parsed.value, 'extracted');
    if (reason) return `${file} ${reason}`;
  }
  return '';
}

function validateFinalSummary(ideaDir) {
  if (!has(ideaDir, '.done')) return '.done missing';
  const summaryPath = join(ideaDir, 'final-summary.md');
  if (!existsSync(summaryPath)) return 'final-summary.md missing';
  const text = readText(summaryPath);
  const requiredSections = ['## 变更摘要', '## Scope Control Summary', '## Knowledge Candidates', '## Wiki Updates'];
  const missing = requiredSections.filter(section => !text.includes(section));
  if (missing.length > 0) return `final-summary.md missing sections: ${missing.join(', ')}`;
  for (const section of requiredSections.map(item => item.replace(/^##\s+/, ''))) {
    if (!hasMeaningfulSection(text, section)) return `final-summary.md section is empty: ${section}`;
  }
  if (!/scope-check|越界|Scope|forbidden|expected/i.test(sectionText(text, 'Scope Control Summary'))) return 'final-summary.md Scope Control Summary must summarize scope control';
  return '';
}

export function checkGate(ideaDir, gateId) {
  if (!ideaDir || ideaDir === 'none') return { pass: false, gate: gateId, reason: 'idea-dir does not exist' };
  switch (gateId) {
    case 'requirement-exists': {
      if (!has(ideaDir, 'requirement.md')) return result(gateId, false, 'requirement.md missing');
      const reqText = readText(join(ideaDir, 'requirement.md'));
      const reqLines = meaningfulLines(reqText);
      if (reqLines.length < 3) return result(gateId, false, 'requirement.md has insufficient content (< 3 meaningful lines)');
      return result(gateId, true);
    }
    case 'as-is-complete': {
      const missing = AS_IS_MAIN_FILES.filter(file => !has(ideaDir, file));
      if (missing.length > 0) return result(gateId, false, `missing main files: ${missing.join(', ')}`);
      if (!hasRequiredLines(join(ideaDir, 'as-is/overview.md'), ['### 需求摘要', '### 当前能力边界', '### 待澄清问题']))
        return result(gateId, false, 'as-is overview is missing required sections (需求摘要, 当前能力边界, 待澄清问题)');
      const overviewReason = validateAsIsOverview(ideaDir);
      if (overviewReason) return result(gateId, false, overviewReason);
      if (!readText(join(ideaDir, 'as-is/overview.md')).includes('阅读充分性声明'))
        return result(gateId, false, 'as-is overview missing 阅读充分性声明 section');
      const mermaidFiles = ['as-is/overview.md', 'as-is/core-walkthrough.md'];
      const noMermaid = mermaidFiles.filter(f => !fileHasMermaid(join(ideaDir, f)));
      if (noMermaid.length > 0) return result(gateId, false, `main files missing Mermaid diagrams: ${noMermaid.join(', ')}`);
      const evidenceLines = fileLineCount(join(ideaDir, 'as-is/evidence-index.md'));
      if (evidenceLines < MIN_EVIDENCE_LINES) return result(gateId, false, `evidence-index.md has only ${evidenceLines} non-empty lines (min ${MIN_EVIDENCE_LINES})`);
      const coverageReason = validateAsIsCoverageMatrix(ideaDir);
      if (coverageReason) return result(gateId, false, coverageReason);
      const repoMapReason = validateRepoMap(ideaDir);
      if (repoMapReason) return result(gateId, false, repoMapReason);
      const budgetReason = validateContextBudget(ideaDir);
      if (budgetReason) return result(gateId, false, budgetReason);
      const qualityReason = validateQualityScore(ideaDir);
      if (qualityReason) return result(gateId, false, qualityReason);
      return result(gateId, true);
    }
    case 'as-is-confirmed': {
      if (has(ideaDir, 'confirmations/as-is.json') || has(ideaDir, 'clarifications.json')) {
        const reason = validateAsIsConfirmation(ideaDir);
        return reason ? result(gateId, false, reason) : result(gateId, true);
      }
      if (!has(ideaDir, '.as-is-confirmed')) return result(gateId, false, 'confirmations/as-is.json missing');
      if (!has(ideaDir, 'clarifications.md')) return result(gateId, false, 'clarifications.md missing — legacy confirm must produce clarifications');
      const decisionReason = validateClarificationDecisions(ideaDir);
      return decisionReason ? result(gateId, false, decisionReason) : result(gateId, true, '', { legacy: true });
    }
    case 'strategy-exists':
      return checkGate(ideaDir, 'to-be-exists');
    case 'strategy-confirmed':
      return checkGate(ideaDir, 'to-be-confirmed');
    case 'to-be-exists': {
      const planFile = join(ideaDir, 'to-be/implementation-plan.md');
      if (!has(ideaDir, 'to-be/implementation-plan.md'))
        return result(gateId, false, 'to-be/implementation-plan.md missing');
      const requiredSections = ['## 目标行为', '## 非目标行为', '## 允许修改范围', '## 禁止修改范围', '## Task 拆分建议'];
      if (!hasRequiredLines(planFile, requiredSections))
        return result(gateId, false, 'to-be implementation plan is missing required sections (目标行为, 非目标行为, 允许修改范围, 禁止修改范围, Task 拆分建议)');
      const planText = readFileSync(planFile, 'utf8');
      if (!planText.includes('## 改造点映射'))
        return result(gateId, false, 'to-be implementation plan is missing required section: 改造点映射');
      const taskSection = planText.split('## Task 拆分建议')[1] || '';
      if (taskSection.includes('task_id') || taskSection.includes('### task-')) {
        if (!taskSection.includes('Acceptance Criteria') && !taskSection.includes('验收标准'))
          return result(gateId, false, 'Task 拆分建议 section missing Acceptance Criteria in task entries');
      }
      const tasksReason = validateTasksJsonAgainstTraceability(ideaDir);
      if (tasksReason) return result(gateId, false, tasksReason);
      const toBeComplexity = detectComplexity(ideaDir);
      if (toBeComplexity !== 'trivial') {
        const irReason = validateImpactRiskReport(ideaDir);
        if (irReason) return result(gateId, false, irReason);
      }
      return result(gateId, true);
    }
    case 'to-be-confirmed': {
      if (has(ideaDir, 'confirmations/to-be.json')) {
        const reason = validateToBeConfirmation(ideaDir);
        return reason ? result(gateId, false, reason) : result(gateId, true);
      }
      if (!has(ideaDir, '.to-be-confirmed')) return result(gateId, false, 'confirmations/to-be.json missing');
      if (!has(ideaDir, 'to-be/implementation-plan.md')) return result(gateId, false, '.to-be-confirmed exists but implementation-plan.md is missing');
      return result(gateId, true, '', { legacy: true });
    }
    case 'tasks-exist':
      return result(gateId, has(ideaDir, 'tasks'), 'tasks directory missing');
    case 'task-workflow-exists':
      return result(gateId, has(ideaDir, 'task-workflow-state.yaml'), 'task-workflow-state.yaml missing');
    case 'task-integrity': {
      const reason = validateTaskIntegrity(ideaDir);
      return reason ? result(gateId, false, reason) : result(gateId, true);
    }
    case 'task-report-exists': {
      if (!has(ideaDir, 'task-workflow-state.yaml')) return result(gateId, false, 'task-workflow-state.yaml missing');
      const invalid = taskEntries(ideaDir).map(([taskId, task]) => {
        if (!['coded', 'reviewing', 'approved', 'needs_rework', 'blocked'].includes(task.status)) return '';
        const reportPath = join(ideaDir, task.report_file);
        if (!has(ideaDir, task.report_file)) return taskId;
        const { behaviorInvariants } = getTaskScope(ideaDir, taskId);
        const taskPath = join(ideaDir, task.file || `tasks/${taskId}.md`);
        const taskFm = existsSync(taskPath) ? readFrontmatter(readText(taskPath)) : {};
        const traceRefs = Array.isArray(taskFm.trace_refs) ? taskFm.trace_refs : [];
        const reason = validateTaskReport(reportPath, behaviorInvariants, traceRefs);
        return reason ? `${taskId} (${reason})` : '';
      }).filter(Boolean);
      return invalid.length === 0 ? result(gateId, true) : result(gateId, false, `invalid task reports: ${invalid.join(', ')}`);
    }
    case 'cr-complete': {
      if (!has(ideaDir, 'task-workflow-state.yaml')) return result(gateId, false, 'task-workflow-state.yaml missing');
      const crComplexity = detectComplexity(ideaDir);
      if (crComplexity === 'trivial') {
        const hasAnyDimCr = REVIEW_DIMENSIONS.some(d => existsSync(dimensionCrPath(ideaDir, d)));
        if (!hasAnyDimCr) return validateLegacyRequirementCr(ideaDir, gateId);
        const spec = validateDimensionCrFile(ideaDir, 'spec');
        if (!spec.valid) return result(gateId, false, spec.reason);
        if (spec.fm.result === 'fail') {
          const specAffected = affectedTasks(spec.fm);
          if (specAffected.length === 0) return result(gateId, false, 'dim-spec fail must include affected_tasks');
          const statusReason = validateAffectedTaskStatuses(ideaDir, specAffected, ['needs_rework', 'blocked']);
          return statusReason ? result(gateId, false, statusReason) : result(gateId, true, '', { review_result: 'needs_rework', dimensions: ['spec'] });
        }
        return allTasksApproved(ideaDir)
          ? result(gateId, true, '', { review_result: 'approved', dimensions: ['spec'] })
          : result(gateId, false, 'spec passed but not all tasks are approved');
      }
      return validateDimensionCrComplete(ideaDir, gateId);
    }
    case 'rework-limit': {
      if (!has(ideaDir, 'task-workflow-state.yaml')) return result(gateId, false, 'task-workflow-state.yaml missing');
      const over = taskEntries(ideaDir).filter(([, task]) => Number(task.rework_count || 0) >= MAX_REWORK_COUNT).map(([taskId]) => taskId);
      return over.length === 0 ? result(gateId, true) : result(gateId, false, `rework over limit: ${over.join(', ')}`);
    }
    case 'all-approved':
      return result(gateId, has(ideaDir, 'task-workflow-state.yaml') && allTasksApproved(ideaDir), 'not all tasks approved');
    case 'knowledge-candidates-exists': {
      const reason = validateKnowledgeCandidatesExist(ideaDir);
      return reason ? result(gateId, false, reason) : result(gateId, true);
    }
    case 'knowledge-extracted': {
      const reason = validateKnowledgeExtracted(ideaDir);
      return reason ? result(gateId, false, reason) : result(gateId, true);
    }
    case 'clarification-complete': {
      if (has(ideaDir, 'confirmations/strategy.json') || has(ideaDir, 'confirmations/to-be.json')) return result(gateId, true, '', { legacy: true });
      const file = join(ideaDir, 'requirement-clarification.json');
      if (!existsSync(file)) return result(gateId, false, 'requirement-clarification.json missing');
      const parsed = readJsonFile(file);
      if (parsed.error) return result(gateId, false, `requirement-clarification.json invalid JSON: ${parsed.error}`);
      const doc = parsed.value;
      if (doc?.schema_version !== 1) return result(gateId, false, 'requirement-clarification.json schema_version must be 1');
      if (doc.source_step !== 'clarify:requirement') return result(gateId, false, 'source_step must be clarify:requirement');
      if (!doc.clarified_at) return result(gateId, false, 'missing clarified_at');
      if (!doc.dimensions || typeof doc.dimensions !== 'object') return result(gateId, false, 'missing dimensions');
      const complexity = detectComplexity(ideaDir);
      const requiredDimensions = complexity === 'trivial'
        ? ['functional_scope', 'acceptance_criteria']
        : ['functional_scope', 'impact_analysis', 'compatibility_constraints', 'non_functional', 'priority', 'acceptance_criteria', 'risk_tolerance'];
      const missingDimensions = requiredDimensions.filter(d => !doc.dimensions[d]);
      if (missingDimensions.length > 0) return result(gateId, false, `missing dimensions: ${missingDimensions.join(', ')}`);
      if (!Array.isArray(doc.dimensions.acceptance_criteria) || doc.dimensions.acceptance_criteria.length === 0)
        return result(gateId, false, 'acceptance_criteria must be non-empty array');
      return result(gateId, true);
    }
    case 'worktree-decided': {
      if (has(ideaDir, 'task-workflow-state.yaml')) return result(gateId, true, '', { legacy: true });
      const file = join(ideaDir, 'worktree-decision.json');
      if (!existsSync(file)) return result(gateId, false, 'worktree-decision.json missing');
      const parsed = readJsonFile(file);
      if (parsed.error) return result(gateId, false, `worktree-decision.json invalid JSON: ${parsed.error}`);
      const doc = parsed.value;
      if (![1, 2].includes(doc?.schema_version)) return result(gateId, false, 'worktree-decision.json schema_version must be 1 or 2');
      if (!['worktree', 'current-branch'].includes(doc.decision)) return result(gateId, false, 'decision must be worktree or current-branch');
      if (!doc.decided_at) return result(gateId, false, 'missing decided_at');
      if (doc.schema_version === 2) {
        if (!doc.branch_name || typeof doc.branch_name !== 'string') return result(gateId, false, 'v2 schema requires branch_name');
        if (!Array.isArray(doc.repos) || doc.repos.length === 0) return result(gateId, false, 'v2 schema requires non-empty repos array');
        for (const [index, repo] of doc.repos.entries()) {
          if (!repo?.path || typeof repo.path !== 'string') return result(gateId, false, `repos[${index}] missing path`);
          if (!repo.base_commit || typeof repo.base_commit !== 'string') return result(gateId, false, `repos[${index}] missing base_commit`);
        }
      }
      return result(gateId, true);
    }
    case 'ai-input-ready': {
      const reason = validateAiInput(ideaDir);
      return reason ? result(gateId, false, reason) : result(gateId, true);
    }
    case 'traceability-complete': {
      const matrixPath = join(ideaDir, 'to-be/traceability-matrix.json');
      if (!existsSync(matrixPath)) return result(gateId, true, '', { skipped: true });
      const parsed = readJsonFile(matrixPath);
      if (parsed.error) return result(gateId, false, `traceability-matrix.json invalid JSON: ${parsed.error}`);
      const items = parsed.value?.items;
      if (!Array.isArray(items) || items.length === 0) return result(gateId, true, '', { skipped: true });
      const state = readTaskState(taskStateFile(ideaDir));
      for (const item of items) {
        const coveredByTasks = item.covered_by_tasks || [];
        if (coveredByTasks.length === 0) return result(gateId, false, `${item.id || 'unknown'} has no covering task`);
        for (const taskId of coveredByTasks) {
          const task = state.tasks[taskId];
          if (!task) return result(gateId, false, `${item.id} references unknown task: ${taskId}`);
          if (task.status !== 'approved') return result(gateId, false, `${item.id} not fully covered: ${taskId} is ${task.status}`);
        }
      }
      return result(gateId, true);
    }
    case 'quick-dev-ready': {
      const file = join(ideaDir, 'requirement-clarification.json');
      if (!existsSync(file)) return result(gateId, false, 'requirement-clarification.json missing');
      const parsed = readJsonFile(file);
      if (parsed.error) return result(gateId, false, `invalid JSON: ${parsed.error}`);
      const doc = parsed.value;
      if (!doc?.dimensions?.functional_scope) return result(gateId, false, 'missing functional_scope dimension');
      if (!Array.isArray(doc?.dimensions?.acceptance_criteria) || doc.dimensions.acceptance_criteria.length === 0)
        return result(gateId, false, 'missing or empty acceptance_criteria');
      return result(gateId, true);
    }
    case 'done': {
      const reason = validateFinalSummary(ideaDir);
      if (reason) return result(gateId, false, reason);
      const traceGate = checkGate(ideaDir, 'traceability-complete');
      if (!traceGate.pass && !traceGate.skipped) return result(gateId, false, `traceability incomplete: ${traceGate.reason}`);
      return result(gateId, true);
    }
    default:
      return { pass: false, gate: gateId, reason: `unknown gate: ${gateId}` };
  }
}

function result(gate, pass, reason = '', extra = {}) {
  return pass ? { pass: true, gate, ...extra } : { pass: false, gate, reason, ...extra };
}

export async function main(argv) {
  const ideaDir = argv[0];
  const gateId = argv[1];
  if (!ideaDir || !gateId) {
    process.stderr.write('用法: gate-check.mjs <idea-dir> <gate-id>\n');
    process.exit(1);
  }
  const checked = checkGate(ideaDir, gateId);
  console.log(JSON.stringify(checked));
  if (!checked.pass) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
