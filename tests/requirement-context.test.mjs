import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendRequirementInput,
  confirmRequirement,
  initializeRequirementContext,
  requirementConfirmationStatus,
} from '../scripts/requirement-context.mjs';
import { checkGate } from '../scripts/gate-check.mjs';
import { readRequirementClassification } from '../scripts/workflow-lib.mjs';
import { writeRequirementClassification } from '../scripts/requirement-classify.mjs';
import { enableHotolMode } from '../scripts/execution-mode.mjs';

const dirs = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'chisel-requirement-context-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'confirmations'), { recursive: true });
  writeFileSync(join(dir, 'requirement.md'), '# Initial request\n\nAdd export.\n');
  return dir;
}
function canonicalClarification(dir) {
  writeFileSync(join(dir, 'requirement-clarification.json'), JSON.stringify({
    schema_version: 2,
    source_step: 'clarify:requirement',
    clarified_at: '2026-08-12T00:00:00.000Z',
    requirement_ref: 'requirement.md',
    original_requirement_ref: 'requirement-original.md',
    input_ledger_ref: 'requirement-inputs.json',
    canonical_requirement_ref: 'requirement.md',
    dimensions: {
      functional_scope: { in_scope: ['src/export.js'], out_of_scope: ['UI'] },
      acceptance_criteria: [{ id: 'AC-001', description: 'export works', verification_method: 'node test' }],
    },
    unresolved: [],
    readiness: {
      status: 'ready',
      checked_dimensions: ['goal', 'scope', 'behavior', 'edge_cases', 'compatibility', 'non_functional', 'acceptance'],
      assumptions_confirmed: [],
      remaining_questions: [],
    },
  }));
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function readyRequirement() {
  return `# Export requirement

## 目标与业务结果
Export works.

## 范围
- IN: src/export.js
- OUT: UI

## 验收标准
- AC-001: export works

## 未决问题
- 无
`;
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('canonical requirement context', () => {
  it('freezes the initial input and requires confirmation of the synthesized requirement', () => {
    const dir = temp();
    initializeRequirementContext(dir);
    assert.match(readFileSync(join(dir, 'requirement-original.md'), 'utf8'), /Initial request/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'requirement-inputs.json'))).events[0].kind, 'initial_requirement');

    const canonical = readyRequirement();
    writeFileSync(join(dir, 'requirement.md'), canonical);
    canonicalClarification(dir);
    assert.match(checkGate(dir, 'clarification-complete').reason, /confirmation/);
    confirmRequirement(dir, hash(canonical));
    assert.equal(requirementConfirmationStatus(dir).valid, true);
    assert.equal(checkGate(dir, 'clarification-complete').pass, true);
  });

  it('invalidates confirmation and classification when a later user event is appended', () => {
    const dir = temp();
    initializeRequirementContext(dir);
    const canonical = readyRequirement();
    writeFileSync(join(dir, 'requirement.md'), canonical);
    canonicalClarification(dir);
    confirmRequirement(dir, hash(canonical));
    writeRequirementClassification(dir);
    assert.equal(readRequirementClassification(dir).valid, true);

    appendRequirementInput(dir, { kind: 'user_addition', source_step: 'implement:code', content: 'Keep the old export name.' });
    assert.equal(requirementConfirmationStatus(dir).valid, false);
    assert.equal(readRequirementClassification(dir).valid, false);
    assert.match(checkGate(dir, 'clarification-complete').reason, /inputs changed/);
  });

  it('refuses to classify an unconfirmed schema v2 requirement', () => {
    const dir = temp();
    initializeRequirementContext(dir);
    canonicalClarification(dir);
    assert.throws(() => writeRequirementClassification(dir), /not confirmed/);
  });

  it('refuses to confirm an incomplete synthesized requirement', () => {
    const dir = temp();
    initializeRequirementContext(dir);
    canonicalClarification(dir);
    const incomplete = '# Export requirement\n\n## 目标与业务结果\nExport works.\n';
    writeFileSync(join(dir, 'requirement.md'), incomplete);
    assert.throws(() => confirmRequirement(dir, hash(incomplete)), /missing sections/);
  });

  it('accepts an automation actor only for an explicitly authorized HOTOL idea', () => {
    const dir = temp();
    initializeRequirementContext(dir);
    const canonical = readyRequirement();
    writeFileSync(join(dir, 'requirement.md'), canonical);
    canonicalClarification(dir);
    assert.throws(() => confirmRequirement(dir, hash(canonical), 'hotol'), /not authorized/);
    enableHotolMode(dir);
    const confirmation = confirmRequirement(dir, hash(canonical), 'hotol');
    assert.equal(confirmation.confirmed_by, 'hotol');
    assert.equal(requirementConfirmationStatus(dir).valid, true);
    assert.equal(checkGate(dir, 'clarification-complete').pass, true);
  });
});
