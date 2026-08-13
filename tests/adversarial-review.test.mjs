import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeReview } from '../scripts/adversarial-review.mjs';

function fixture() {
  const ideaDir = mkdtempSync(join(tmpdir(), 'chisel-adversarial-'));
  mkdirSync(join(ideaDir, 'to-be'), { recursive: true });
  mkdirSync(join(ideaDir, 'as-is'), { recursive: true });
  mkdirSync(join(ideaDir, 'confirmations'), { recursive: true });
  const files = {
    'requirement-original.md': '# Original\n',
    'requirement-inputs.json': '{"events":[]}\n',
    'requirement.md': '# Requirement\n',
    'requirement-clarification.json': JSON.stringify({
      schema_version: 2,
      dimensions: {
        acceptance_criteria: [
          { id: 'AC-001', verification_conditions: [{ id: 'VC-001' }, { id: 'VC-002' }] },
          { id: 'AC-002', verification_conditions: [] },
        ],
      },
    }),
    'confirmations/requirement.json': '{"status":"confirmed"}\n',
    'as-is/evidence-ledger.json': '{}\n',
    'to-be/implementation-plan.md': '# Plan\n',
    'to-be/tasks.json': '{"tasks":[]}\n',
    'to-be/traceability-matrix.json': '{"items":[]}\n',
  };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(ideaDir, path), content);
  return { ideaDir, paths: Object.keys(files) };
}

describe('adversarial review initialization', () => {
  it('freezes every existing review source and creates every AC/VC coverage slot', () => {
    const { ideaDir, paths } = fixture();
    try {
      const result = initializeReview(ideaDir, { attempt: 2 });
      assert.equal(result.reviewed_file_count, paths.length);
      assert.equal(result.requirement_ref_count, 4);
      const review = JSON.parse(readFileSync(result.json_path, 'utf8'));
      assert.equal(review.schema_version, 2);
      assert.equal(review.attempt, 2);
      assert.deepEqual(review.reviewed_files.map(entry => entry.path), paths);
      assert.ok(review.reviewed_files.every(entry => /^[a-f0-9]{64}$/.test(entry.sha256)));
      assert.deepEqual(review.requirement_coverage.map(entry => entry.source_ref), [
        'AC-001', 'AC-001/VC-001', 'AC-001/VC-002', 'AC-002',
      ]);
      assert.ok(review.requirement_coverage.every(entry => entry.status === 'fail'));
      const markdown = readFileSync(result.markdown_path, 'utf8');
      assert.match(markdown, /^## 审查范围$/m);
      assert.match(markdown, /^## Findings$/m);
      assert.match(markdown, /^## 结论$/m);
    } finally {
      rmSync(ideaDir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an active review unless the next round explicitly uses force', () => {
    const { ideaDir } = fixture();
    try {
      initializeReview(ideaDir);
      assert.throws(() => initializeReview(ideaDir, { attempt: 2 }), /already exists/);
      const refreshed = initializeReview(ideaDir, { attempt: 2, force: true });
      const review = JSON.parse(readFileSync(refreshed.json_path, 'utf8'));
      assert.equal(review.attempt, 2);
    } finally {
      rmSync(ideaDir, { recursive: true, force: true });
    }
  });

  it('fails before dispatching a reviewer when a mandatory source is missing', () => {
    const { ideaDir } = fixture();
    try {
      unlinkSync(join(ideaDir, 'requirement-inputs.json'));
      assert.throws(() => initializeReview(ideaDir), /mandatory sources are missing: requirement-inputs\.json/);
    } finally {
      rmSync(ideaDir, { recursive: true, force: true });
    }
  });
});
