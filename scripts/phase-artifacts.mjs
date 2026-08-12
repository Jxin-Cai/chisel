#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_STEPS } from './workflow-definition.mjs';

const STEP_OUTPUTS = Object.freeze({
  'receive-requirement': ['requirement.md', 'as-is/ui-snapshot.md'],
  // Report pages are exact files: only advertise a report after generation.
  'understand:explore': ['as-is/', 'reports/as-is-report.html'],
  'understand:confirm': ['clarifications.json', 'clarifications.md', 'confirmations/as-is.json'],
  'clarify:requirement': ['requirement-clarification.json', 'requirement-clarification.md'],
  'classify:requirement': ['requirement-classification.json'],
  'plan:design': ['to-be/', 'reports/to-be-report.html'],
  'plan:adversarial-review': ['to-be/adversarial-review.json', 'to-be/adversarial-review.md'],
  'plan:confirm': ['confirmations/to-be.json'],
  'worktree:setup': ['worktree-decision.json'],
  'quick-dev:init': ['tasks/', 'task-workflow-state.yaml', 'worktree-decision.json', 'quick-dev-scope.json', 'to-be/traceability-matrix.json'],
  'tasks:init': ['tasks/', 'task-workflow-state.yaml'],
  'implement:code': ['task-reports/', 'verification-contract.json', 'verify-result.json'],
  'repair:code': ['task-reports/', 'verification-contract.json', 'verify-result.json'],
  'test:unit': ['verify-result.json', 'unit-test-runs.json', 'unit-test-result.json', 'reports/test-report.html', 'confirmations/test-report.json'],
  'review:cr': ['cr/'],
  'review:cr-light': ['cr/'],
  'review:cr-moderate': ['cr/'],
  'review:integration': ['cr/'],
  'review:cr-report': ['cr/review-report.md', 'reports/cr-report.html', 'confirmations/cr-report.json'],
  'final:summary': ['final-summary.md', 'reports/task-time-report.html', 'confirmations/task-time-report.json'],
  'review:merge': [
    'confirmations/merge-review.json',
    'reports/cr-report.html',
  ],
  blocked: [],
  done: ['final-summary.md', 'reports/task-time-report.html', 'confirmations/task-time-report.json'],
});

function filesBelow(path) {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => filesBelow(join(path, entry.name)));
}

export function collectPhaseArtifacts(ideaDir, step) {
  const root = resolve(ideaDir);
  if (!WORKFLOW_STEPS.includes(step)) throw new Error(`unknown workflow step: ${step}`);
  if (!existsSync(root)) throw new Error(`idea-dir not found: ${root}`);
  const seen = new Set();
  return (STEP_OUTPUTS[step] || []).flatMap(item => filesBelow(join(root, item)))
    .map(path => ({
      label: relative(root, path).split('\\').join('/'),
      path: resolve(path),
    }))
    .filter(artifact => {
      if (seen.has(artifact.path)) return false;
      seen.add(artifact.path);
      return true;
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function escapeLabel(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function markdownTarget(path) {
  // Codex resolves plain absolute Markdown destinations as local files. Angle
  // brackets are only needed when whitespace would otherwise terminate the
  // destination; wrapping every path prevents some clients from recognizing
  // the target as a local absolute path.
  const target = path.replaceAll('>', '%3E');
  return /\s/.test(target) ? `<${target}>` : target;
}

export function formatPhaseArtifacts(ideaDir, step, artifacts = collectPhaseArtifacts(ideaDir, step)) {
  const title = `### 阶段产物 · ${step}`;
  if (artifacts.length === 0) return `${title}\n\n- 暂无可交付文件（请先完成 gate 要求的产物）`;
  const links = artifacts.map(({ label, path }) => `- [${escapeLabel(label)}](${markdownTarget(path)})`);
  return [title, '', ...links].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args[0];
  const step = args[1];
  const json = args.includes('--json');
  if (!ideaDir || !step) {
    process.stderr.write('用法: node phase-artifacts.mjs <idea-dir> <step> [--json]\n');
    process.exit(1);
  }
  try {
    const artifacts = collectPhaseArtifacts(ideaDir, step);
    if (json) {
      console.log(JSON.stringify({ idea_dir: resolve(ideaDir), step, artifacts }, null, 2));
      return;
    }
    console.log(formatPhaseArtifacts(ideaDir, step, artifacts));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message, idea_dir: resolve(ideaDir), step })}\n`);
    process.exit(2);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main();

export { STEP_OUTPUTS };
