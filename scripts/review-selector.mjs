#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planReview } from './review-budget.mjs';
import { resolveExistingIdeaDirectory } from './control-plane.mjs';
import { commitFileTransaction } from './file-transaction.mjs';

export const REVIEW_DIMENSIONS = Object.freeze(['spec', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9']);
const RISK_RULES = Object.freeze([
  { name: 'auth/security', regex: /(^|[\/_-])(auth|authentication|authorization|oauth|jwt|acl|permission|security|secret|password|credential)([\/.\s_-]|$)|登录|鉴权|权限|密钥|密码/i, dimensions: ['d9'], reason: 'authentication/authorization or secret boundary' },
  { name: 'payment', regex: /(^|[\/_-])(pay|payment|billing|invoice|refund|checkout|order)([\/.\s_-]|$)|支付|计费|退款|订单/i, dimensions: ['d9', 'd8'], reason: 'payment or money movement' },
  { name: 'migration', regex: /(^|[\/_-])(migrat|schema|database|db|sql|ddl|index)([\/.\s_-]|$)|迁移|数据库|表结构|索引/i, dimensions: ['d2', 'd8'], reason: 'migration/schema/data compatibility' },
  { name: 'concurrency', regex: /(^|[\/_-])(thread|lock|mutex|atomic|concurr|parallel|worker|queue|async)([\/.\s_-]|$)|并发|锁|竞态|异步/i, dimensions: ['d2'], reason: 'concurrency/shared state' },
  { name: 'external-boundary', regex: /(^|[\/_-])(api|http|grpc|rpc|webhook|client|gateway|adapter|integration)([\/.\s_-]|$)|外部接口|第三方|边界/i, dimensions: ['d8', 'd9'], reason: 'external boundary/contract' },
  { name: 'verification-mechanism', regex: /(^|[\/_-])(test|tests|verify|verification|ci|gate|validator|workflow|hook)([\/.\s_-]|$)|验证机制|门禁|校验/i, dimensions: ['d4', 'd8'], reason: 'verification mechanism changed' },
]);

function git(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { return ''; }
}

function diffStats(diffText = '') {
  const additions = diffText.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
  const deletions = diffText.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length;
  return { additions, deletions, lines: additions + deletions };
}

export function readDiff({ projectRoot = '.', baseRef = null, diffText = null, paths = null } = {}) {
  const text = diffText ?? git(baseRef ? ['diff', `${baseRef}...HEAD`] : ['diff', 'HEAD'], projectRoot);
  const changedPaths = paths || git(baseRef ? ['diff', '--name-only', `${baseRef}...HEAD`] : ['diff', '--name-only', 'HEAD'], projectRoot).split('\n').filter(Boolean);
  return { text, paths: [...new Set(changedPaths)], stats: diffStats(text) };
}

export function selectReview({ projectRoot = '.', baseRef = null, diffText = null, paths = null, complexity = null } = {}) {
  const diff = readDiff({ projectRoot, baseRef, diffText, paths });
  const haystack = `${diff.paths.join('\n')}\n${diff.text}`;
  const matches = RISK_RULES.filter(rule => rule.regex.test(haystack));
  const forced = [...new Set(matches.flatMap(match => match.dimensions))];
  const reasons = matches.map(match => ({ rule: match.name, reason: match.reason, dimensions: match.dimensions }));
  const smallLowRisk = !forced.length && diff.paths.length <= 2 && diff.stats.lines <= 80 && !['standard', 'complex'].includes(complexity);
  const riskLevel = smallLowRisk ? 'low' : forced.length || ['standard', 'complex'].includes(complexity) ? 'high' : 'medium';
  const dimensions = smallLowRisk
    ? ['spec']
    : [...new Set(['spec', ...(forced.length ? forced : ['d3', 'd4', 'd5']), ...(riskLevel === 'high' && !forced.length ? ['d2', 'd6', 'd7', 'd8', 'd9'] : [])])];
  const skipped = REVIEW_DIMENSIONS.filter(dimension => !dimensions.includes(dimension));
  // Spec is a dedicated hard-gate phase in chisel-review.js. Only quality
  // dimensions belong in the parallel CR batches; including spec here runs it
  // twice and lets a quality-review prompt overwrite dim-spec-cr.md.
  const activeDimensions = dimensions.filter(dimension => dimension !== 'spec');
  const budget = planReview({ dimensions: activeDimensions, findingCount: 0, riskLevel });
  return {
    schema_version: 1,
    mode: smallLowRisk ? 'lite' : 'dynamic',
    risk_level: riskLevel,
    dimensions,
    active_dimensions: activeDimensions,
    skipped_dimensions: skipped,
    reasons: smallLowRisk ? [{ rule: 'small-low-risk-diff', reason: 'at most 2 changed paths and 80 changed lines with no forced-risk signal', dimensions: ['spec'] }] : reasons.length ? reasons : [{ rule: 'default-moderate', reason: 'diff exceeds lite threshold', dimensions }],
    forced_signals: matches.map(match => match.name),
    diff,
    dimension_batches: budget.dimension_batches,
    aggregate_assessment_agents: budget.aggregate_assessment_agents,
    review_policy: budget.policy,
    compatibility_projection: Object.fromEntries(skipped.filter(d => d !== 'spec').map(d => [d, { status: 'skipped', result: 'auto-pass', reason: 'not selected by dynamic risk policy' }])),
  };
}

export { RISK_RULES };

function option(args, name, fallback = '') { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; }

function positionalIdeaDir(args) {
  const optionsWithValues = new Set(['--project-root', '--base-ref', '--diff-file', '--paths', '--complexity', '--idea-dir']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (optionsWithValues.has(arg)) { index += 1; continue; }
    if (!arg.startsWith('-')) return arg;
  }
  return option(args, '--idea-dir', '');
}

function fail(message) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

export function writeReviewSelection(ideaDir, selection, {
  projectRoot = '.',
  baseRef = null,
  complexity = null,
  pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
} = {}) {
  const resolvedIdeaDir = resolveExistingIdeaDirectory(ideaDir, projectRoot);
  const contextPath = join(resolvedIdeaDir, 'cr', 'cr-context.json');
  if (!existsSync(contextPath)) throw new Error(`cr/cr-context.json missing: ${contextPath}`);
  const context = JSON.parse(readFileSync(contextPath, 'utf8'));
  if (!Array.isArray(context.task_ids) || context.task_ids.length === 0) throw new Error('cr-context.json task_ids must be a non-empty array');

  const selectionPath = join(resolvedIdeaDir, 'cr', 'review-selection.json');
  const workflowInputPath = join(resolvedIdeaDir, 'cr', 'review-workflow-input.json');
  const workflowArgs = {
    pluginRoot: resolve(pluginRoot),
    ideaDir: resolvedIdeaDir,
    baseRef: baseRef || context.base_ref || '',
    projectRoot: resolve(projectRoot),
    complexity: complexity || null,
    riskLevel: selection.risk_level,
    taskIds: context.task_ids,
    reworkCycle: Number(context.rework_cycle || 0),
    activeDimensions: selection.active_dimensions,
    dimensionBatches: selection.dimension_batches,
    reviewPolicy: selection.review_policy,
  };
  commitFileTransaction(resolvedIdeaDir, [
    { path: selectionPath, content: `${JSON.stringify(selection, null, 2)}\n` },
    { path: workflowInputPath, content: `${JSON.stringify(workflowArgs, null, 2)}\n` },
  ], { id: `review-selection-${process.pid}` });
  return { idea_dir: resolvedIdeaDir, selection_file: selectionPath, workflow_input_file: workflowInputPath, workflow_args: workflowArgs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const projectRoot = option(args, '--project-root', '.');
  const baseRef = option(args, '--base-ref', null);
  const diffText = args.includes('--diff-file') ? readFileSync(option(args, '--diff-file'), 'utf8') : null;
  const paths = option(args, '--paths', '').split(',').filter(Boolean);
  const complexity = option(args, '--complexity', null);
  const selection = selectReview({ projectRoot, baseRef, diffText, paths: paths.length ? paths : null, complexity });
  if (args.includes('--write')) {
    const ideaDir = positionalIdeaDir(args);
    if (!ideaDir) fail('--write requires <idea-dir> or --idea-dir <idea-dir>');
    try {
      console.log(JSON.stringify({ ...selection, ...writeReviewSelection(ideaDir, selection, { projectRoot, baseRef, complexity }) }, null, 2));
    } catch (error) {
      fail(error.message);
    }
  } else {
    console.log(JSON.stringify(selection, null, 2));
  }
}
