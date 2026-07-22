#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { detectComplexity, initTaskState, atomicWriteFile, ensureDir } from './workflow-lib.mjs';

const IDEA_DIR = process.argv[2];

if (!IDEA_DIR) {
  process.stderr.write('用法: node quick-dev-init.mjs <idea-dir>\n');
  process.exit(1);
}

function readJson(rel) {
  const p = join(IDEA_DIR, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function main() {
  const clarification = readJson('requirement-clarification.json');
  if (!clarification) {
    process.stderr.write(JSON.stringify({ error: 'requirement-clarification.json not found' }) + '\n');
    process.exit(1);
  }

  const dims = clarification.dimensions || {};
  const functionalScope = dims.functional_scope || {};
  const acceptanceCriteria = Array.isArray(dims.acceptance_criteria) ? dims.acceptance_criteria : [];

  if (acceptanceCriteria.length === 0) {
    process.stderr.write(JSON.stringify({ error: 'acceptance_criteria is empty' }) + '\n');
    process.exit(1);
  }

  const inScope = Array.isArray(functionalScope.in_scope) ? functionalScope.in_scope : [];
  const goal = inScope.length > 0 ? inScope.join('；') : 'implement trivial requirement';
  const traceRefs = acceptanceCriteria.map(ac => ac.id || `AC-${String(acceptanceCriteria.indexOf(ac) + 1).padStart(3, '0')}`);

  const taskId = 'task-001';
  const taskFile = `tasks/${taskId}.md`;
  const taskPath = join(IDEA_DIR, taskFile);

  ensureDir(dirname(taskPath));

  const acSection = acceptanceCriteria.map(ac => `- ${ac.id || 'AC'}: ${ac.description || ''} (${ac.verification_method || 'manual'})`).join('\n');

  const complexity = detectComplexity(IDEA_DIR);
  const complexityLabel = complexity === 'hotfix' ? 'Hotfix' : complexity === 'minor' ? 'Minor' : 'Trivial';

  const taskMd = `---
task_id: ${taskId}
title: "${complexityLabel}: ${goal.slice(0, 60)}"
risk_level: low
task_complexity: ${complexity}
expected_files: []
trace_refs: [${traceRefs.join(', ')}]
---

## 目标行为

${goal}

### Allowed Files / Areas

- (unrestricted for trivial task)

### Forbidden Files / Areas

- (none)

## Impact Surface

- files: []
- symbols: []
- invariants: []
- shared_state: []

## Context to Load

- requirement.md
- requirement-clarification.json

## Traceability

trace_refs: ${traceRefs.join(', ')}

## Acceptance Criteria

${acSection}

## Behavior Invariants

- existing functionality unchanged
`;

  writeFileSync(taskPath, taskMd);

  const ideaName = IDEA_DIR.split('/').filter(Boolean).pop() || 'unknown';
  initTaskState(IDEA_DIR, ideaName, [{
    taskId,
    depends_on: [],
    description: goal.slice(0, 100),
    file: taskFile,
    expected_files: [],
    impact_surface: { files: [], symbols: [], invariants: [], shared_state: [] },
    exports: [],
    imports: [],
    status: 'confirmed'
  }]);

  const worktreeDecision = {
    schema_version: 1,
    decision: 'current-branch',
    decided_at: new Date().toISOString(),
    reason: `${complexity} complexity — always current-branch`
  };
  atomicWriteFile(join(IDEA_DIR, 'worktree-decision.json'), JSON.stringify(worktreeDecision, null, 2));

  ensureDir(join(IDEA_DIR, 'to-be'));
  const traceMatrix = {
    items: traceRefs.map((ref, i) => ({
      id: ref,
      type: 'acceptance_criteria',
      description: acceptanceCriteria[i]?.description || ref,
      source: 'requirement-clarification.json',
      covered_by_tasks: [taskId]
    }))
  };
  atomicWriteFile(join(IDEA_DIR, 'to-be/traceability-matrix.json'), JSON.stringify(traceMatrix, null, 2));

  console.log(JSON.stringify({
    success: true,
    task_id: taskId,
    task_file: taskFile,
    acceptance_criteria_count: acceptanceCriteria.length,
    trace_refs: traceRefs
  }));
}

main();
