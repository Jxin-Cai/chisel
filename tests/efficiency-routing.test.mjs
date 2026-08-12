import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeRequirementClassification } from '../scripts/requirement-classify.mjs';
import { checkGate, toBePlanFingerprint } from '../scripts/gate-check.mjs';
import { checkDocumentJob, completeDocumentJob, prepareDocumentJob } from '../scripts/document-job.mjs';
import { computeStatus } from '../scripts/orchestration-status.mjs';

const dirs = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), 'chisel-efficiency-')); dirs.push(dir); return dir; }
function seedClarified(dir, { scope = ['src/a.js'], ac = ['AC-001 works'], extra = '' } = {}) {
  writeFileSync(join(dir, 'requirement.md'), `# Requirement\n## 涉及范围\n${scope.map(x => `- ${x}`).join('\n')}\n${extra}\n`);
  writeFileSync(join(dir, 'requirement-clarification.json'), JSON.stringify({
    schema_version: 1, source_step: 'clarify:requirement', clarified_at: '2026-08-10T00:00:00Z',
    dimensions: { functional_scope: scope, acceptance_criteria: ac },
  }));
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('post-clarification efficiency routing', () => {
  it('classifies a small clarified request as direct with no discovery/planning agents', () => {
    const dir = temp(); seedClarified(dir);
    const result = writeRequirementClassification(dir);
    assert.equal(result.difficulty, 'simple');
    assert.equal(result.execution_profile, 'direct');
    assert.equal(result.subagent_budget.discovery, 0);
    assert.equal(result.subagent_budget.planning, 0);
    assert.equal(checkGate(dir, 'requirement-classified').pass, true);
  });

  it('invalidates classification when clarified requirements change', () => {
    const dir = temp(); seedClarified(dir); writeRequirementClassification(dir);
    const clarification = JSON.parse(readFileSync(join(dir, 'requirement-clarification.json')));
    clarification.dimensions.acceptance_criteria.push('AC-002 changed');
    writeFileSync(join(dir, 'requirement-clarification.json'), JSON.stringify(clarification));
    const gate = checkGate(dir, 'requirement-classified');
    assert.equal(gate.pass, false);
    assert.match(gate.reason, /stale/);
  });

  it('promotes security work to the full route', () => {
    const dir = temp(); seedClarified(dir, { extra: '修改 auth token 和权限校验' });
    const result = writeRequirementClassification(dir);
    assert.equal(result.routing_complexity, 'standard');
    assert.equal(result.execution_profile, 'full');
  });

  it('promotes explicit medium risk and recognizes Chinese risk levels consistently', () => {
    const medium = temp(); seedClarified(medium, { extra: '## 风险: 中风险' });
    assert.equal(writeRequirementClassification(medium).routing_complexity, 'moderate');
    const highHotfix = temp();
    writeFileSync(join(highHotfix, 'requirement.md'), '# Fix\n## 复杂度: hotfix\n## 风险: 高风险\n## 涉及范围\n- src/auth.js\n');
    assert.equal(computeStatus(highHotfix).resume_step, 'clarify:requirement');
  });

  it('records document shape without inflating complexity when repository evidence is unavailable', () => {
    const dir = temp(); seedClarified(dir);
    const clarification = JSON.parse(readFileSync(join(dir, 'requirement-clarification.json')));
    clarification.dimensions.functional_scope = { in_scope: ['a', 'b', 'c'], allowed_files: ['d', 'e'], expected_files: ['f', 'g'] };
    writeFileSync(join(dir, 'requirement-clarification.json'), JSON.stringify(clarification));
    const result = writeRequirementClassification(dir);
    assert.equal(result.signals.scope_items, 7);
    assert.equal(result.routing_complexity, 'moderate');
    assert.match(result.reasons.at(-1), /diagnostic only/);
  });

  it('routes from verified candidate files and modules, not acceptance-criteria count', () => {
    const dir = temp();
    mkdirSync(join(dir, 'src', 'users'), { recursive: true });
    writeFileSync(join(dir, 'src/users/profile.js'), 'export function profile() { return true; }\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    seedClarified(dir, { scope: ['src/users/profile.js'], ac: Array.from({ length: 8 }, (_, index) => `AC-${index + 1} profile works`) });
    const result = writeRequirementClassification(dir, dir);
    assert.equal(result.signals.acceptance_criteria, 8);
    assert.equal(result.signals.candidate_files, 1);
    assert.equal(result.routing_complexity, 'trivial');
  });

  it('does not treat a negated security term as an active high-risk change', () => {
    const dir = temp();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/profile.js'), 'export const profile = () => true;\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    seedClarified(dir, { scope: ['src/profile.js'], extra: 'Do not change auth token behavior.' });
    const result = writeRequirementClassification(dir, dir);
    assert.equal(result.signals.high_risk_domain, false);
    assert.equal(result.routing_complexity, 'trivial');
  });

  it('lets core clarification reach classification before progressively requiring promoted dimensions', () => {
    const dir = temp(); seedClarified(dir, { extra: '跨服务新增 API migration' });
    assert.equal(checkGate(dir, 'clarification-complete').pass, true);
    writeRequirementClassification(dir);
    const promoted = checkGate(dir, 'clarification-complete');
    assert.equal(promoted.pass, false);
    assert.match(promoted.reason, /impact_analysis|risk_tolerance/);
  });

  it('blocks canonical unresolved questions and classifies them as high uncertainty/full', () => {
    const dir = temp(); seedClarified(dir);
    const file = join(dir, 'requirement-clarification.json');
    const clarification = JSON.parse(readFileSync(file));
    clarification.unresolved = ['Which compatibility behavior should win?'];
    writeFileSync(file, JSON.stringify(clarification));
    assert.match(checkGate(dir, 'clarification-complete').reason, /unresolved questions/);
    assert.equal(computeStatus(dir).resume_step, 'clarify:requirement');
    const result = writeRequirementClassification(dir);
    assert.equal(result.uncertainty_level, 'high');
    assert.equal(result.routing_complexity, 'standard');
    assert.equal(result.execution_profile, 'full');
  });

  it('does not treat explicit empty or resolved open-question records as uncertainty', () => {
    for (const value of [[], '无', [{ status: 'resolved', question: 'done' }]]) {
      const dir = temp(); seedClarified(dir);
      const file = join(dir, 'requirement-clarification.json');
      const clarification = JSON.parse(readFileSync(file));
      clarification.open_questions = value;
      writeFileSync(file, JSON.stringify(clarification));
      assert.equal(checkGate(dir, 'clarification-complete').pass, true);
      assert.equal(writeRequirementClassification(dir).uncertainty_level, 'low');
    }
  });

  it('treats explicit moderate as a conservative floor after clarification', () => {
    const dir = temp(); seedClarified(dir, { extra: '## 复杂度: moderate' });
    const clarification = JSON.parse(readFileSync(join(dir, 'requirement-clarification.json')));
    clarification.dimensions.compatibility_constraints = ['backward compatible'];
    clarification.dimensions.priority = 'normal';
    writeFileSync(join(dir, 'requirement-clarification.json'), JSON.stringify(clarification));
    const result = writeRequirementClassification(dir);
    assert.equal(result.routing_complexity, 'moderate');
    assert.equal(result.execution_profile, 'lightweight');
    assert.equal(computeStatus(dir).resume_step, 'plan:design');
    assert.equal(existsSync(join(dir, 'as-is')), false);
  });

  it('rejects a tampered profile even when the input fingerprint is current', () => {
    const dir = temp(); seedClarified(dir); writeRequirementClassification(dir);
    const file = join(dir, 'requirement-classification.json');
    const doc = JSON.parse(readFileSync(file));
    doc.subagent_budget.discovery = 9;
    writeFileSync(file, JSON.stringify(doc));
    assert.match(checkGate(dir, 'requirement-classified').reason, /mismatch|tampered/);
  });

  it('escalates an oversized quick-dev scope before creating implementation state', () => {
    const dir = temp(); seedClarified(dir); writeRequirementClassification(dir);
    writeFileSync(join(dir, 'quick-dev-scope.json'), JSON.stringify({
      schema_version: 1, source_step: 'quick-dev:init', scope_mode: 'explicit', task_id: 'task-001',
      allowed_files: ['src/a.js', 'src/b.js', 'web/c.js'], expected_files: ['src/a.js', 'src/b.js', 'web/c.js'],
      forbidden_files: [], acceptance_criteria: ['AC-001'],
    }));
    const run = spawnSync(process.execPath, ['scripts/quick-dev-init.mjs', dir, '--current-branch'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.equal(JSON.parse(readFileSync(join(dir, 'scope-escalation.json'))).required, true);
    assert.equal(existsSync(join(dir, 'task-workflow-state.yaml')), false);
    assert.equal(checkGate(dir, 'requirement-classified').pass, false);
  });

  it('prioritizes scope escalation over an explicit hotfix and stabilizes on the minimum route', () => {
    const dir = temp();
    writeFileSync(join(dir, 'requirement.md'), '# Fix\n## 复杂度: hotfix\n## 涉及范围\n- broad behavior\n');
    writeFileSync(join(dir, 'scope-escalation.json'), JSON.stringify({ required: true, minimum_complexity: 'moderate', reason: 'no bounded files' }));
    assert.equal(computeStatus(dir).resume_step, 'clarify:requirement');
    writeFileSync(join(dir, 'requirement-clarification.json'), JSON.stringify({ schema_version: 1, source_step: 'clarify:requirement', clarified_at: '2026-08-10T00:00:00Z', dimensions: { functional_scope: ['behavior'], acceptance_criteria: ['AC-001 works'] } }));
    assert.equal(computeStatus(dir).resume_step, 'classify:requirement');
    assert.equal(writeRequirementClassification(dir).routing_complexity, 'moderate');
    assert.equal(computeStatus(dir).resume_step, 'clarify:requirement');
    const clarification = JSON.parse(readFileSync(join(dir, 'requirement-clarification.json')));
    clarification.dimensions.compatibility_constraints = ['preserve behavior'];
    clarification.dimensions.priority = 'normal';
    writeFileSync(join(dir, 'requirement-clarification.json'), JSON.stringify(clarification));
    assert.equal(computeStatus(dir).resume_step, 'classify:requirement');
    writeRequirementClassification(dir);
    assert.equal(computeStatus(dir).resume_step, 'plan:design');
  });

  it('fails safe to standard for an invalid scope-escalation minimum', () => {
    const dir = temp(); seedClarified(dir);
    writeFileSync(join(dir, 'scope-escalation.json'), JSON.stringify({ required: true, minimum_complexity: 'banana', reason: 'bad producer' }));
    const result = writeRequirementClassification(dir);
    assert.equal(result.routing_complexity, 'standard');
    assert.equal(result.execution_profile, 'full');
    assert.match(result.reasons.join('\n'), /invalid scope escalation.*fail-safe floor standard/);
  });
});

describe('asynchronous human-document receipts', () => {
  function seedAsIs(dir) {
    seedClarified(dir);
    writeRequirementClassification(dir);
    const files = {
      'as-is/repo-map.json': '{}', 'as-is/evidence-ledger.json': '{}', 'as-is/coverage-matrix.json': '{}',
      'as-is/context-budget.json': '{}',
      'as-is/ai-input/facts.md': 'facts', 'as-is/ai-input/call-graph.md': 'call graph',
      'as-is/ai-input/data-schema.md': 'schema', 'as-is/ai-input/api-surface.md': 'api',
      'as-is/ai-input/constraints.md': 'constraints', 'as-is/ai-input/change-surface.md': 'surface',
      'as-is/ai-input/field-flow.md': 'field flow',
      'as-is/debt-signals/nested/debt.json': 'debt',
    };
    for (const [rel, value] of Object.entries(files)) { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), value); }
  }
  it('moves pending to complete and detects stale sources', () => {
    const dir = temp(); seedAsIs(dir);
    prepareDocumentJob(dir, 'as-is');
    assert.equal(checkDocumentJob(dir, 'as-is').status, 'pending');
    for (const rel of ['overview.md', 'core-walkthrough.md', 'evidence-index.md', 'context-budget.md']) writeFileSync(join(dir, 'as-is', rel), rel);
    completeDocumentJob(dir, 'as-is');
    assert.equal(checkDocumentJob(dir, 'as-is').valid, true);
    writeFileSync(join(dir, 'as-is/ai-input/facts.md'), 'changed');
    assert.equal(checkDocumentJob(dir, 'as-is').status, 'stale');
  });

  it('fails closed when a classified as-is flow has no writer receipt', () => {
    const dir = temp(); seedAsIs(dir);
    assert.match(checkGate(dir, 'as-is-complete').reason, /document-jobs\/as-is\.json missing/);
  });

  it('invalidates receipts for structural, context-budget, and optional writer inputs', () => {
    for (const source of ['as-is/repo-map.json', 'as-is/context-budget.json', 'as-is/ai-input/field-flow.md', 'as-is/debt-signals/nested/debt.json']) {
      const dir = temp(); seedAsIs(dir); prepareDocumentJob(dir, 'as-is');
      for (const rel of ['overview.md', 'core-walkthrough.md', 'evidence-index.md', 'context-budget.md']) writeFileSync(join(dir, 'as-is', rel), rel);
      completeDocumentJob(dir, 'as-is');
      writeFileSync(join(dir, source), `${readFileSync(join(dir, source), 'utf8')} changed`);
      assert.equal(checkDocumentJob(dir, 'as-is').status, 'stale', source);
    }
  });

  it('tracks the conditional knowledge-candidates writer output', () => {
    const dir = temp(); seedAsIs(dir); prepareDocumentJob(dir, 'as-is');
    for (const rel of ['overview.md', 'core-walkthrough.md', 'evidence-index.md', 'context-budget.md', 'knowledge-candidates.md']) writeFileSync(join(dir, 'as-is', rel), rel);
    completeDocumentJob(dir, 'as-is');
    assert.equal(checkDocumentJob(dir, 'as-is').valid, true);
    writeFileSync(join(dir, 'as-is/knowledge-candidates.md'), 'changed');
    assert.equal(checkDocumentJob(dir, 'as-is').status, 'stale');
  });
});

describe('classified to-be confirmation identity', () => {
  it('changes the unified fingerprint for every plan/review/document source and rejects legacy markers', () => {
    const dir = temp(); seedClarified(dir); writeRequirementClassification(dir);
    const sources = [
      'to-be/implementation-plan.md', 'to-be/design-notes.json', 'to-be/tasks.json',
      'to-be/traceability-matrix.json', 'to-be/impact-risk-report.json',
      'to-be/adversarial-review.json', 'to-be/adversarial-review.md', 'document-jobs/to-be.json',
    ];
    for (const rel of sources) { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), `${rel}\n`); }
    const original = toBePlanFingerprint(dir);
    assert.match(original, /^[a-f0-9]{64}$/);
    for (const rel of sources) {
      const file = join(dir, rel); const before = readFileSync(file, 'utf8');
      writeFileSync(file, `${before}changed`);
      assert.notEqual(toBePlanFingerprint(dir), original, rel);
      writeFileSync(file, before);
    }
    writeFileSync(join(dir, '.to-be-confirmed'), 'legacy');
    assert.match(checkGate(dir, 'to-be-confirmed').reason, /legacy.*forbidden/);
  });

  it('rejects legacy markers for document-receipt and adversarial-v2 traces even without classification', () => {
    for (const trace of ['receipt', 'adversarial']) {
      const dir = temp(); mkdirSync(join(dir, 'to-be'), { recursive: true });
      writeFileSync(join(dir, 'to-be/implementation-plan.md'), '# plan');
      writeFileSync(join(dir, '.to-be-confirmed'), 'legacy');
      if (trace === 'receipt') {
        mkdirSync(join(dir, 'document-jobs'), { recursive: true });
        writeFileSync(join(dir, 'document-jobs/to-be.json'), '{}');
      } else writeFileSync(join(dir, 'to-be/adversarial-review.json'), JSON.stringify({ schema_version: 2 }));
      assert.match(checkGate(dir, 'to-be-confirmed').reason, /new-workflow artifacts/);
    }
  });
});
