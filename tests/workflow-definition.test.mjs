import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_COMPLEXITIES, STEP_GATE_MAP, STEP_TO_PHASE, WORKFLOW_DEFINITION, WORKFLOW_PATHS } from '../scripts/workflow-definition.mjs';

function orchestrationContract() {
  const text = readFileSync(join(process.cwd(), 'skills/chisel-contracts/orchestration.yaml'), 'utf8');
  const result = {};
  let current = null;
  for (const line of text.split('\n')) {
    const step = line.match(/^  - id:\s*(.+)$/)?.[1]?.trim();
    if (step) {
      current = step;
      result[current] = null;
      continue;
    }
    const gate = line.match(/^      check:\s*(.+)$/)?.[1]?.trim();
    if (current && gate) result[current] = gate;
  }
  return result;
}

describe('canonical workflow definition', () => {
  it('only references declared steps from complexity paths', () => {
    for (const complexity of ALL_COMPLEXITIES) {
      assert.ok(WORKFLOW_PATHS[complexity].length > 0);
      for (const entry of WORKFLOW_PATHS[complexity]) assert.ok(WORKFLOW_DEFINITION.steps[entry.step], `${complexity}: ${entry.step}`);
    }
  });

  it('derives phase and gate maps from the same definition', () => {
    for (const [step, config] of Object.entries(WORKFLOW_DEFINITION.steps)) {
      if (config.phase) assert.equal(STEP_TO_PHASE[step], config.phase);
      if (config.gate) assert.equal(STEP_GATE_MAP[step], config.gate);
    }
  });

  it('keeps the human orchestration contract aligned', () => {
    const contract = orchestrationContract();
    for (const [step, config] of Object.entries(WORKFLOW_DEFINITION.steps)) {
      if (!config.gate) continue;
      assert.equal(contract[step], config.gate, `${step} gate drifted from workflow-definition.json`);
    }
  });

  it('documents every canonical complexity in the main skill routing table', () => {
    const skill = readFileSync(join(process.cwd(), 'skills/chisel/SKILL.md'), 'utf8');
    for (const complexity of ALL_COMPLEXITIES) {
      assert.match(skill, new RegExp('^\\| `' + complexity + '` \\|', 'm'), `${complexity} missing from main skill table`);
    }
  });
});
