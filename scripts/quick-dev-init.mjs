#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectComplexity, initTaskState, atomicWriteFile, ensureDir, readRequirementClassification } from './workflow-lib.mjs';

const IDEA_DIR = process.argv[2];
const modeFlag = process.argv.find(arg => arg === '--current-branch' || arg === '--worktree');
const requestedMode = process.env.CHISEL_QUICK_DEV_MODE || (modeFlag === '--current-branch' ? 'current-branch' : modeFlag === '--worktree' ? 'worktree' : 'worktree');

if (!IDEA_DIR) {
  process.stderr.write('用法: node quick-dev-init.mjs <idea-dir>\n');
  process.exit(1);
}

function readJson(rel) {
  const p = join(IDEA_DIR, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function parseRequirementForHotfix(ideaDir) {
  const reqPath = join(ideaDir, 'requirement.md');
  if (!existsSync(reqPath)) return null;
  const text = readFileSync(reqPath, 'utf8');
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const goal = titleMatch ? titleMatch[1].trim() : 'hotfix';
  const acceptanceBody = (text.match(/^##\s+验收标准(?:（初步）)?\s*$([\s\S]*?)(?=^##\s+|$)/m) || [])[1] || '';
  const acceptance = acceptanceBody.split('\n')
    .map(line => (line.match(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?(.+)$/) || [])[1]?.trim())
    .filter(value => value && !/^<.*>$/.test(value));
  if (acceptance.length === 0) return { error: 'hotfix requirement must contain at least one concrete acceptance criterion' };
  return {
    goal,
    acceptanceCriteria: acceptance.map((description, index) => ({ id: `AC-${String(index + 1).padStart(3, '0')}`, description, verification_method: 'behavior-check' })),
    traceRefs: acceptance.map((_, index) => `AC-${String(index + 1).padStart(3, '0')}`),
    allowedFiles: [],
    forbiddenFiles: [],
  };
}

function normalizeList(value) {
  return Array.isArray(value) ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] : [];
}

function scopeFromClarification(functionalScope = {}) {
  let allowedFiles = normalizeList(
    functionalScope.allowed_files || functionalScope.expected_files || functionalScope.files || functionalScope.paths,
  );
  if (allowedFiles.length === 0) {
    allowedFiles = normalizeList(functionalScope.in_scope).filter(value => value.includes('/') || value.includes('.') || value.includes('*'));
  }
  let forbiddenFiles = normalizeList(functionalScope.forbidden_files || functionalScope.excluded_files || functionalScope.out_of_scope);
  if (forbiddenFiles.length === 0) forbiddenFiles = normalizeList(functionalScope.out_of_scope).filter(value => value.includes('/') || value.includes('.') || value.includes('*'));
  return { allowedFiles, forbiddenFiles };
}

function main() {
  const complexity = detectComplexity(IDEA_DIR);
  const clarification = readJson('requirement-clarification.json');
  const preparedScope = readJson('quick-dev-scope.json');

  let goal, acceptanceCriteria, traceRefs, allowedFiles = [], forbiddenFiles = [], expectedFiles = [];

  if (clarification) {
    const dims = clarification.dimensions || {};
    const functionalScope = dims.functional_scope || {};
    acceptanceCriteria = Array.isArray(dims.acceptance_criteria) ? dims.acceptance_criteria.map((criterion, index) => {
      if (criterion && typeof criterion === 'object') return criterion;
      const raw = String(criterion || '').trim();
      const id = raw.match(/\bAC-\d{3}\b/)?.[0] || `AC-${String(index + 1).padStart(3, '0')}`;
      return { id, description: raw.replace(new RegExp(`^${id}\\s*[：:]?\\s*`), ''), verification_method: 'behavior-check' };
    }) : [];

    if (acceptanceCriteria.length === 0) {
      process.stderr.write(JSON.stringify({ error: 'acceptance_criteria is empty' }) + '\n');
      process.exit(1);
    }

    const inScope = Array.isArray(functionalScope.in_scope) ? functionalScope.in_scope : [];
    goal = inScope.length > 0 ? inScope.join('；') : 'implement trivial requirement';
    traceRefs = acceptanceCriteria.map(ac => ac.id || `AC-${String(acceptanceCriteria.indexOf(ac) + 1).padStart(3, '0')}`);
    ({ allowedFiles, forbiddenFiles } = scopeFromClarification(functionalScope));
  } else if (complexity === 'hotfix') {
    const hotfix = parseRequirementForHotfix(IDEA_DIR);
    if (!hotfix || hotfix.error) {
      process.stderr.write(JSON.stringify({ error: hotfix?.error || 'requirement.md not found for hotfix' }) + '\n');
      process.exit(1);
    }
    goal = hotfix.goal;
    acceptanceCriteria = hotfix.acceptanceCriteria;
    traceRefs = hotfix.traceRefs;
    allowedFiles = hotfix.allowedFiles;
    forbiddenFiles = hotfix.forbiddenFiles;
  } else {
    process.stderr.write(JSON.stringify({ error: 'requirement-clarification.json not found (required for non-hotfix)' }) + '\n');
    process.exit(1);
  }

  if (preparedScope) {
    allowedFiles = normalizeList(preparedScope.allowed_files).length > 0 ? normalizeList(preparedScope.allowed_files) : allowedFiles;
    forbiddenFiles = normalizeList(preparedScope.forbidden_files).length > 0 ? normalizeList(preparedScope.forbidden_files) : forbiddenFiles;
    expectedFiles = normalizeList(preparedScope.expected_files);
  }
  if (expectedFiles.length === 0) expectedFiles = [...allowedFiles];
  if (allowedFiles.length === 0 || expectedFiles.length === 0) {
    const escalation = {
      schema_version: 1,
      source_step: 'quick-dev:init',
      required: true,
      minimum_complexity: 'moderate',
      reason: 'direct profile has no concrete file scope; bounded planning is required',
      observed_scope: { files: [], module_roots: [], broad_pattern: true, risk_level: 'unknown' },
    };
    atomicWriteFile(join(IDEA_DIR, 'scope-escalation.json'), `${JSON.stringify(escalation, null, 2)}\n`);
    process.stderr.write(JSON.stringify({
      error: 'quick-dev requires a non-empty lightweight discovery scope; scope escalation was recorded', escalation,
    }) + '\n');
    process.exit(2);
  }

  const distinctFiles = [...new Set([...allowedFiles, ...expectedFiles])];
  const moduleRoots = new Set(distinctFiles.map(path => path.replace(/^\.\//, '').split('/')[0]).filter(Boolean));
  const broadPattern = distinctFiles.some(path => /\*\*|(?:^|\/)\*(?:\/|$)|^src\/?$|^app\/?$|全量|所有/i.test(path));
  const classification = readRequirementClassification(IDEA_DIR);
  const riskLevel = classification.valid ? classification.value.risk_level
    : (['hotfix', 'minor', 'trivial'].includes(complexity) ? 'low' : 'medium');
  const maxFiles = complexity === 'hotfix' ? 1 : 2;
  if (distinctFiles.length > maxFiles || moduleRoots.size > 2 || broadPattern || riskLevel !== 'low') {
    const escalation = {
      schema_version: 1,
      source_step: 'quick-dev:init',
      required: true,
      minimum_complexity: riskLevel === 'high' || moduleRoots.size > 2 ? 'standard' : 'moderate',
      reason: `direct profile exceeded: files=${distinctFiles.length}/${maxFiles}, modules=${moduleRoots.size}/2, broad=${broadPattern}, risk=${riskLevel}`,
      observed_scope: { files: distinctFiles, module_roots: [...moduleRoots], broad_pattern: broadPattern, risk_level: riskLevel },
    };
    atomicWriteFile(join(IDEA_DIR, 'scope-escalation.json'), `${JSON.stringify(escalation, null, 2)}\n`);
    process.stderr.write(`${JSON.stringify({ error: 'quick-dev scope requires escalation', escalation })}\n`);
    process.exit(2);
  }

  const taskId = 'task-001';
  const taskFile = `tasks/${taskId}.md`;
  const taskPath = join(IDEA_DIR, taskFile);

  ensureDir(dirname(taskPath));

  const acSection = acceptanceCriteria.map(ac => `- ${ac.id || 'AC'}: ${ac.description || ''} (${ac.verification_method || 'manual'})`).join('\n');
  const allowedSection = allowedFiles.length > 0 ? allowedFiles.map(file => `- ${file}`).join('\n') : '- 无（快速通道未声明文件范围；仅允许在 scope contract 标注的范围内修改）';
  const forbiddenSection = forbiddenFiles.length > 0 ? forbiddenFiles.map(file => `- ${file}`).join('\n') : '- 无';

  const complexityLabel = complexity === 'hotfix' ? 'Hotfix' : complexity === 'minor' ? 'Minor' : complexity === 'trivial' ? 'Trivial' : complexity.charAt(0).toUpperCase() + complexity.slice(1);

  const taskMd = `---
task_id: ${taskId}
title: "${complexityLabel}: ${goal.slice(0, 60)}"
risk_level: low
task_complexity: ${complexity}
expected_files: [${expectedFiles.join(', ')}]
trace_refs: [${traceRefs.join(', ')}]
allowed_files: [${allowedFiles.join(', ')}]
forbidden_files: [${forbiddenFiles.join(', ')}]
---

## 目标行为

${goal}

### Allowed Files / Areas

${allowedSection}

### Forbidden Files / Areas

${forbiddenSection}

## Impact Surface

- files: [${expectedFiles.join(', ')}]
- symbols: []
- invariants: []
- shared_state: []

## Context to Load

- requirement.md${complexity !== 'hotfix' ? '\n- requirement-clarification.json' : ''}

## Traceability

trace_refs: ${traceRefs.join(', ')}

## Acceptance Criteria

${acSection}

## Behavior Invariants

- existing functionality unchanged
`;

  atomicWriteFile(taskPath, taskMd);

  const ideaName = IDEA_DIR.split('/').filter(Boolean).pop() || 'unknown';
  initTaskState(IDEA_DIR, ideaName, [{
    taskId,
    depends_on: [],
    description: goal.slice(0, 100),
    file: taskFile,
    expected_files: expectedFiles,
    impact_surface: { files: expectedFiles, symbols: [], invariants: [], shared_state: [], reads: [], writes: [] },
    exports: [],
    imports: [],
    status: 'confirmed'
  }]);

  if (!['current-branch', 'worktree'].includes(requestedMode)) {
    process.stderr.write(JSON.stringify({ error: 'quick-dev mode must be current-branch or worktree' }) + '\n');
    process.exit(1);
  }
  let repoPath = process.cwd();
  let baseCommit = null;
  try {
    repoPath = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
    baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
  } catch { /* current-branch may be used from a non-Git outer workspace */ }
  const worktreeDecision = {
    schema_version: requestedMode === 'worktree' && repoPath ? 2 : 1,
    decision: requestedMode,
    decided_at: new Date().toISOString(),
    reason: `${complexity} quick path — explicit ${requestedMode} isolation decision`,
    ...(requestedMode === 'worktree' && repoPath ? {
      branch_name: `feat/${ideaName}`,
      repos: [{ path: repoPath, base_commit: baseCommit || 'unknown', requested_worktree: true }],
      setup_required: true,
    } : {}),
  };
  atomicWriteFile(join(IDEA_DIR, 'worktree-decision.json'), JSON.stringify(worktreeDecision, null, 2));

  ensureDir(join(IDEA_DIR, 'to-be'));
  const traceItems = [];
  for (const [index, ac] of acceptanceCriteria.entries()) {
    const acId = traceRefs[index];
    traceItems.push({
      id: acId,
      type: 'acceptance_criteria',
      description: ac?.description || acId,
      source: clarification ? 'requirement-clarification.json' : 'requirement.md',
      source_refs: [acId],
      covered_by_tasks: [taskId]
    });
    for (const vc of Array.isArray(ac?.verification_conditions) ? ac.verification_conditions : []) {
      const vcId = vc?.id || `VC-${String(traceItems.length + 1).padStart(3, '0')}`;
      const ref = `${acId}/${vcId}`;
      traceRefs.push(ref);
      traceItems.push({
        id: ref,
        type: 'verification_condition',
        description: vc?.condition || ref,
        source: 'requirement-clarification.json',
        source_refs: [acId, vcId],
        covered_by_tasks: [taskId]
      });
    }
  }
  // Keep the generated task brief and the machine matrix in lock-step when
  // verification conditions were discovered after the initial AC list.
  const rewritten = readFileSync(taskPath, 'utf8').replace(/^trace_refs:.*$/gm, `trace_refs: [${traceRefs.join(', ')}]`);
  atomicWriteFile(taskPath, rewritten);
  const traceMatrix = { schema_version: 2, items: traceItems };
  atomicWriteFile(join(IDEA_DIR, 'to-be/traceability-matrix.json'), JSON.stringify(traceMatrix, null, 2));

  atomicWriteFile(join(IDEA_DIR, 'quick-dev-scope.json'), JSON.stringify({
    schema_version: 1,
    source_step: 'quick-dev:init',
    task_id: taskId,
    complexity,
    allowed_files: allowedFiles,
    forbidden_files: forbiddenFiles,
    expected_files: expectedFiles,
    acceptance_criteria: traceRefs.filter(ref => !ref.includes('/')),
    scope_mode: 'explicit',
  }, null, 2));

  console.log(JSON.stringify({
    success: true,
    task_id: taskId,
    task_file: taskFile,
    acceptance_criteria_count: acceptanceCriteria.length,
    trace_refs: traceRefs
  }));
}

main();
