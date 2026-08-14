import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_COMPLEXITIES, STEP_GATE_MAP, STEP_TO_PHASE, WORKFLOW_DEFINITION, WORKFLOW_PATHS } from '../scripts/workflow-definition.mjs';
import { renderOrchestrationProjection } from '../scripts/workflow-projector.mjs';

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
    assert.equal(
      readFileSync(join(process.cwd(), 'skills/chisel-contracts/orchestration.yaml'), 'utf8'),
      renderOrchestrationProjection(),
      'compatibility projection must be generated from workflow-definition.json',
    );
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

  it('starts isolated requirements by default and reserves resume for an explicit target', () => {
    const skill = readFileSync(join(process.cwd(), 'skills/chisel/SKILL.md'), 'utf8');
    assert.match(skill, /control-plane\.mjs --new --project-root/);
    assert.match(skill, /只有用户明确说“恢复\/继续”并指定具体 idea-name 或需求目录/);
    assert.doesNotMatch(skill, /workflow-snapshot\.mjs/);
    assert.match(skill, /不得定位、读取、恢复或复用其/);
  });

  it('gates CR behind the unit-test report and emits the CR report only after review', () => {
    for (const complexity of ALL_COMPLEXITIES) {
      const steps = WORKFLOW_PATHS[complexity].map(entry => entry.step);
      const testIndex = steps.indexOf('test:unit');
      const crIndex = steps.findIndex(step => step.startsWith('review:cr') && step !== 'review:cr-report');
      const reportIndex = steps.indexOf('review:cr-report');
      assert.ok(testIndex > steps.indexOf('implement:code'), `${complexity}: unit tests must follow implementation`);
      assert.ok(crIndex > testIndex, `${complexity}: CR must follow the confirmed unit-test report`);
      assert.ok(reportIndex > crIndex, `${complexity}: final CR report must follow multi-dimensional CR`);
      if (steps.includes('review:integration')) assert.ok(reportIndex > steps.indexOf('review:integration'), `${complexity}: CR report must include integration review`);
    }
  });
});
