#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile, allTasksApproved, readTaskState, taskStateFile } from './workflow-lib.mjs';
import { collectDimResults } from './cr-report.mjs';
import { validateVerificationResult, workspaceIdentity } from './verification-lib.mjs';
import { reportSourceFingerprint } from './report-confirm.mjs';

const REPORT_JSON = 'cr/current-change-report.json';
const REPORT_MD = 'cr/current-change-report.md';
const CONFIRMATION = 'confirmations/merge-review.json';
const HTML_REPORT = 'reports/cr-report.html';

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileSha256(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : '';
}

function validateHtmlReportFreshness(ideaDir) {
  const path = join(ideaDir, HTML_REPORT);
  if (!existsSync(path)) return `${HTML_REPORT} missing`;
  const embedded = readFileSync(path, 'utf8').match(/<!-- report-source:([a-f0-9]{64}) -->/)?.[1] || '';
  return embedded === reportSourceFingerprint(ideaDir, 'cr') ? '' : `${HTML_REPORT} is stale: source artifacts changed`;
}

function git(root, args, fallback = '') {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
    }).trim();
  } catch {
    return fallback;
  }
}

function repositoryRoots(ideaDir, fallbackRoot) {
  const verification = readJson(join(ideaDir, 'verify-result.json'), {});
  const verified = (verification.repositories || []).map(repo => repo.project_root).filter(Boolean);
  if (verified.length > 0) return [...new Set(verified.map(path => resolve(path)))];
  const decision = readJson(join(ideaDir, 'worktree-decision.json'), {});
  const configured = (decision.repos || []).map(repo => repo.worktree_path || repo.path).filter(Boolean)
    .map(path => isAbsolute(path) ? path : resolve(fallbackRoot, path));
  return configured.length > 0 ? [...new Set(configured.map(path => resolve(path)))] : [resolve(fallbackRoot)];
}

function taskBaseline(ideaDir, root) {
  const runsDir = join(ideaDir, 'task-runs');
  if (!existsSync(runsDir)) return '';
  const candidates = [];
  for (const file of readdirSync(runsDir).filter(name => name.endsWith('.json')).sort()) {
    const run = readJson(join(runsDir, file), {});
    for (const attempt of run.attempts || []) {
      for (const repo of attempt.baseline || []) {
        if (resolve(repo.project_root || '') === resolve(root) && repo.head) {
          candidates.push({ at: attempt.started_at || '', head: repo.head });
        }
      }
    }
  }
  candidates.sort((left, right) => left.at.localeCompare(right.at));
  return candidates[0]?.head || '';
}

function decisionBaseline(ideaDir, root) {
  const decision = readJson(join(ideaDir, 'worktree-decision.json'), {});
  if (decision.base_commit) return decision.base_commit;
  for (const repo of decision.repos || []) {
    const candidate = repo.worktree_path || repo.path;
    if (candidate && resolve(candidate) === resolve(root) && repo.base_commit) return repo.base_commit;
  }
  return '';
}

function inferBaseline(root) {
  const remoteHead = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const refs = [remoteHead, 'origin/main', 'main', 'origin/master', 'master'].filter(Boolean);
  for (const ref of refs) {
    const commit = git(root, ['merge-base', 'HEAD', ref]);
    if (commit) return commit;
  }
  return git(root, ['rev-parse', 'HEAD']);
}

function resolveBaseline(ideaDir, root) {
  const candidates = [decisionBaseline(ideaDir, root), taskBaseline(ideaDir, root), inferBaseline(root)].filter(Boolean);
  for (const candidate of candidates) {
    if (git(root, ['rev-parse', '--verify', `${candidate}^{commit}`])) return candidate;
  }
  return git(root, ['rev-parse', 'HEAD']);
}

function lineCount(path) {
  if (!existsSync(path)) return 0;
  try { return readFileSync(path, 'utf8').split('\n').length; } catch { return 0; }
}

function parseNameStatus(text) {
  return String(text || '').split('\n').filter(Boolean).map(line => {
    const cells = line.split('\t');
    const code = cells[0];
    return { status: code, path: cells.at(-1), previous_path: cells.length > 2 ? cells[1] : undefined };
  });
}

function parseNumstat(text) {
  const result = new Map();
  for (const line of String(text || '').split('\n').filter(Boolean)) {
    const [added, deleted, ...pathParts] = line.split('\t');
    const path = pathParts.at(-1);
    result.set(path, {
      additions: added === '-' ? 0 : Number(added || 0),
      deletions: deleted === '-' ? 0 : Number(deleted || 0),
      binary: added === '-' || deleted === '-',
    });
  }
  return result;
}

function changeCategories(files) {
  const paths = files.map(file => file.path.toLowerCase());
  const any = pattern => paths.some(path => pattern.test(path));
  return {
    api: any(/(^|\/)(api|routes?|controllers?|handlers?|openapi|swagger)(\/|\.|$)/),
    database: any(/(^|\/)(migrations?|schema|models?|entities|ddl)(\/|\.|$)/),
    dependencies: any(/(^|\/)(package-lock\.json|package\.json|pnpm-lock\.yaml|yarn\.lock|requirements.*\.txt|poetry\.lock|go\.(mod|sum)|cargo\.lock)$/),
    security_sensitive: any(/auth|permission|policy|secret|crypto|token|session|cookie|filesystem|network/),
    configuration: any(/(^|\/)(config|settings|\.github|docker|deploy|infra)(\/|\.|$)/),
    tests: any(/(^|\/)(test|tests|spec|__tests__)(\/|\.|$)|\.(test|spec)\./),
    documentation: any(/(^|\/)(docs?|readme)(\/|\.|$)|\.md$/),
  };
}

function collectRepository(ideaDir, root) {
  const identity = workspaceIdentity(root);
  if (identity.error) return { project_root: root, error: identity.error };
  const base = resolveBaseline(ideaDir, root);
  const nameStatus = parseNameStatus(git(root, ['diff', '--name-status', '-M', base, '--']));
  const numstat = parseNumstat(git(root, ['diff', '--numstat', base, '--']));
  const known = new Set(nameStatus.map(file => file.path));
  for (const path of identity.untracked_files || []) {
    if (!known.has(path)) nameStatus.push({ status: 'A?', path });
  }
  const files = nameStatus.map(file => ({
    ...file,
    ...(numstat.get(file.path) || {
      additions: file.status === 'A?' ? lineCount(join(root, file.path)) : 0,
      deletions: 0,
      binary: false,
    }),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const commits = git(root, ['log', '--format=%H%x09%s', `${base}..HEAD`]).split('\n').filter(Boolean).map(line => {
    const [sha, ...subject] = line.split('\t');
    return { sha, subject: subject.join('\t') };
  });
  return {
    project_root: resolve(root),
    repository: basename(root),
    branch: git(root, ['branch', '--show-current']),
    base_commit: base,
    head_commit: identity.head,
    workspace_fingerprint: identity.fingerprint,
    dirty: Boolean(git(root, ['status', '--porcelain'])),
    commits,
    files,
    totals: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
    categories: changeCategories(files),
  };
}

function collectVerification(ideaDir) {
  const result = readJson(join(ideaDir, 'verify-result.json'), {});
  const repositories = Array.isArray(result.repositories) && result.repositories.length > 0
    ? result.repositories
    : (Array.isArray(result.checks) ? [{
        project_root: result.project_root || '',
        status: result.status,
        checks: result.checks,
      }] : []);
  return {
    status: result.status || 'missing',
    generated_at: result.generated_at || '',
    repositories: repositories.map(repo => ({
      project_root: repo.project_root,
      status: repo.status,
      checks: (repo.checks || []).map(check => ({
        id: check.id,
        command: [check.command, ...(check.args || [])].filter(Boolean).join(' '),
        status: check.status,
        exit_code: check.exit_code,
        duration_ms: check.duration_ms,
      })),
    })),
  };
}

function collectMachineReview(ideaDir) {
  const dimensions = collectDimResults(ideaDir);
  const failed = dimensions.filter(item => item.result === 'fail');
  const findings = dimensions.flatMap(item => item.reworkItems.map(finding => ({
    dimension: item.dimension,
    id: finding.id || '',
    task_id: finding.affected_task_id || '',
    description: finding['问题描述'] || finding.description || '',
    recommendation: finding['修复建议'] || finding.recommendation || '',
    severity: finding['严重度'] || finding.severity || 'unknown',
    confidence: Number(finding['置信度'] || finding.confidence || 0),
  })));
  const observations = dimensions.flatMap(item => item.observations.map(observation => ({
    dimension: item.dimension,
    id: observation.id || '',
    task_id: observation.affected_task_id || '',
    description: observation['描述'] || observation.description || '',
    confidence: Number(observation['置信度'] || observation.confidence || 0),
  })));
  return {
    verdict: failed.length > 0 ? 'needs_rework' : 'approved',
    dimensions: dimensions.map(item => ({
      dimension: item.dimension,
      name: item.name,
      result: item.result,
      rework_items: item.reworkItems.length,
      observations: item.observations.length,
    })),
    blocking_findings: failed.reduce((sum, item) => sum + item.reworkItems.length, 0),
    observation_count: observations.length,
    findings,
    observations,
  };
}

function collectTasks(ideaDir) {
  const file = taskStateFile(ideaDir);
  if (!existsSync(file)) return [];
  const state = readTaskState(file);
  return Object.entries(state.tasks || {}).map(([taskId, task]) => ({
    task_id: taskId,
    status: task.status,
    description: task.description || '',
    changed_files: task.changed_files || [],
    rework_count: Number(task.rework_count || 0),
  }));
}

function collectRisk(ideaDir) {
  const risk = readJson(join(ideaDir, 'to-be/impact-risk-report.json'), {});
  return {
    level: risk.summary?.risk_level || 'not_assessed',
    highest_risk: risk.summary?.highest_risk || '',
    items: (risk.risk_matrix || []).map(item => ({
      id: item.id || '',
      category: item.category || '',
      severity: item.severity || '',
      description: item.description || '',
      mitigation: item.mitigation || '',
    })),
  };
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderMarkdown(report) {
  const repoTotals = report.repositories.reduce((totals, repo) => ({
    files: totals.files + Number(repo.totals?.files || 0),
    additions: totals.additions + Number(repo.totals?.additions || 0),
    deletions: totals.deletions + Number(repo.totals?.deletions || 0),
  }), { files: 0, additions: 0, deletions: 0 });
  const lines = [
    '# Current Change Report', '',
    '> Merge decision packet. This report is bound to the exact Git HEAD and working-tree fingerprint shown below.', '',
    '## Executive Summary', '',
    '| Item | Result |', '|---|---|',
    `| Merge readiness | ${report.readiness.status} |`,
    `| Repositories | ${report.repositories.length} |`,
    `| Changed files | ${repoTotals.files} |`,
    `| Diff size | +${repoTotals.additions} / -${repoTotals.deletions} |`,
    `| Verification | ${report.verification.status} |`,
    `| Machine CR | ${report.machine_review.verdict} |`,
    `| Risk | ${report.risk.level} |`, '',
  ];
  if (report.readiness.blockers.length > 0) {
    lines.push('### Blocking Conditions', '', ...report.readiness.blockers.map(item => `- ${item}`), '');
  }
  lines.push('## Review Scope', '', '| Repository | Branch | Base | Head | Workspace | Dirty |', '|---|---|---|---|---|---|');
  for (const repo of report.repositories) {
    lines.push(`| ${markdownCell(repo.repository)} | ${markdownCell(repo.branch)} | ${repo.base_commit.slice(0, 12)} | ${repo.head_commit.slice(0, 12)} | ${repo.workspace_fingerprint.slice(0, 12)} | ${repo.dirty ? 'yes' : 'no'} |`);
  }
  lines.push('', '## Commits in Scope', '');
  for (const repo of report.repositories) {
    lines.push(`### ${repo.repository}`, '', '| Commit | Subject |', '|---|---|');
    for (const commit of repo.commits || []) lines.push(`| ${commit.sha.slice(0, 12)} | ${markdownCell(commit.subject)} |`);
    if ((repo.commits || []).length === 0) lines.push('| — | No commits after base; report includes staged, unstaged, and untracked changes. |');
    lines.push('');
  }
  lines.push('', '## Changed Files', '');
  for (const repo of report.repositories) {
    lines.push(`### ${repo.repository}`, '', '| Status | File | + | - |', '|---|---|---:|---:|');
    for (const file of repo.files) lines.push(`| ${file.status} | ${markdownCell(file.path)} | ${file.binary ? 'binary' : file.additions} | ${file.binary ? 'binary' : file.deletions} |`);
    if (repo.files.length === 0) lines.push('| — | No changed files | 0 | 0 |');
    lines.push('');
  }
  lines.push('## Behavioral and Task Coverage', '', '| Task | Status | Rework | Description |', '|---|---|---:|---|');
  for (const task of report.tasks) lines.push(`| ${task.task_id} | ${task.status} | ${task.rework_count} | ${markdownCell(task.description)} |`);
  lines.push('', '## Automated Checks', '', '| Repository | Check | Command | Result | Duration |', '|---|---|---|---|---:|');
  for (const repo of report.verification.repositories) {
    for (const check of repo.checks) lines.push(`| ${markdownCell(basename(repo.project_root || ''))} | ${markdownCell(check.id)} | \`${markdownCell(check.command)}\` | ${check.status} | ${check.duration_ms ?? 0} ms |`);
  }
  lines.push('', '## Machine CR Results', '', '| Dimension | Result | Blocking | Observations |', '|---|---|---:|---:|');
  for (const dim of report.machine_review.dimensions) lines.push(`| ${dim.dimension.toUpperCase()} · ${markdownCell(dim.name)} | ${dim.result} | ${dim.rework_items} | ${dim.observations} |`);
  if (report.machine_review.dimensions.length === 0) lines.push('| Requirement-level review | approved by task state | 0 | 0 |');
  lines.push('', '### Blocking Findings', '', '| Severity | Finding | Task | Description | Recommendation | Confidence |', '|---|---|---|---|---|---:|');
  for (const finding of report.machine_review.findings || []) {
    lines.push(`| ${markdownCell(finding.severity)} | ${markdownCell(finding.id)} | ${markdownCell(finding.task_id)} | ${markdownCell(finding.description)} | ${markdownCell(finding.recommendation)} | ${finding.confidence} |`);
  }
  if ((report.machine_review.findings || []).length === 0) lines.push('| — | None | — | No blocking findings remain after self-repair. | — | — |');
  lines.push('', '### Non-blocking Observations', '', '| Observation | Dimension | Task | Description | Confidence |', '|---|---|---|---|---:|');
  for (const observation of report.machine_review.observations || []) {
    lines.push(`| ${markdownCell(observation.id)} | ${markdownCell(observation.dimension)} | ${markdownCell(observation.task_id)} | ${markdownCell(observation.description)} | ${observation.confidence} |`);
  }
  if ((report.machine_review.observations || []).length === 0) lines.push('| None | — | — | No non-blocking observations were recorded. | — |');
  lines.push('', '## Reviewer Focus', '');
  const focus = new Set();
  for (const repo of report.repositories) {
    for (const [category, active] of Object.entries(repo.categories || {})) if (active) focus.add(category);
  }
  if (focus.size === 0) lines.push('- No sensitive category was inferred; review the complete diff.');
  else for (const item of [...focus].sort()) lines.push(`- ${item}`);
  lines.push('', '## Risk and Compatibility', '', `- Risk level: ${report.risk.level}`, `- Highest risk: ${report.risk.highest_risk || 'none recorded'}`);
  for (const item of report.risk.items) lines.push(`- ${item.id || 'RISK'} [${item.severity || 'unknown'}] ${item.description}${item.mitigation ? ` — mitigation: ${item.mitigation}` : ''}`);
  lines.push('', '## Human Review Decision', '', '- **Approve**: the exact snapshot above may proceed to merge.', '- **Request changes**: return to repair; a new report and approval are required.', '- **Comment / hold**: record feedback without authorizing merge.', '', `Generated at: ${report.generated_at}`, '');
  return lines.join('\n');
}

export function generateMergeReview(ideaDir, projectRoot = '.') {
  const root = resolve(ideaDir);
  const repositories = repositoryRoots(root, projectRoot).map(repo => collectRepository(root, repo));
  const verification = collectVerification(root);
  const machineReview = collectMachineReview(root);
  const tasks = collectTasks(root);
  const finalSummaryPath = join(root, 'final-summary.md');
  const blockers = [];
  const verificationReason = validateVerificationResult(root, projectRoot);
  if (verificationReason) blockers.push(`Verification is missing, failed, or stale: ${verificationReason}`);
  if (!allTasksApproved(root)) blockers.push('Not all tasks are machine-approved.');
  if (machineReview.verdict !== 'approved') blockers.push('Machine CR still has blocking findings.');
  if (!existsSync(finalSummaryPath)) blockers.push('final-summary.md is missing.');
  for (const repo of repositories) if (repo.error) blockers.push(`${repo.project_root}: ${repo.error}`);
  const report = {
    schema_version: 1,
    report_type: 'current-change',
    idea: basename(root),
    generated_at: new Date().toISOString(),
    final_summary_sha256: fileSha256(finalSummaryPath),
    repositories,
    tasks,
    verification,
    machine_review: machineReview,
    risk: collectRisk(root),
    readiness: { status: blockers.length === 0 ? 'ready_for_human_review' : 'action_required', blockers },
  };
  atomicWriteFile(join(root, REPORT_JSON), `${JSON.stringify(report, null, 2)}\n`);
  atomicWriteFile(join(root, REPORT_MD), `${renderMarkdown(report)}\n`);
  return report;
}

export function validateMergeReviewReport(ideaDir) {
  const jsonPath = join(ideaDir, REPORT_JSON);
  const mdPath = join(ideaDir, REPORT_MD);
  if (!existsSync(jsonPath)) return `${REPORT_JSON} missing`;
  if (!existsSync(mdPath)) return `${REPORT_MD} missing`;
  const report = readJson(jsonPath);
  if (!report || report.schema_version !== 1 || report.report_type !== 'current-change') return `${REPORT_JSON} invalid schema`;
  if (readFileSync(mdPath, 'utf8') !== `${renderMarkdown(report)}\n`) return `${REPORT_MD} does not match the structured report`;
  if (report.readiness?.status !== 'ready_for_human_review') return `merge review is not ready: ${(report.readiness?.blockers || []).join('; ')}`;
  if (report.final_summary_sha256 !== fileSha256(join(ideaDir, 'final-summary.md'))) return 'merge review is stale: final-summary.md changed';
  if (!Array.isArray(report.repositories) || report.repositories.length === 0) return 'merge review repositories must be non-empty';
  for (const repo of report.repositories) {
    const current = workspaceIdentity(repo.project_root);
    if (current.error) return current.error;
    if (repo.head_commit !== current.head) return `merge review is stale: Git HEAD changed for ${repo.project_root}`;
    if (repo.workspace_fingerprint !== current.fingerprint) return `merge review is stale: working tree changed for ${repo.project_root}`;
  }
  return '';
}

export function recordMergeReviewDecision(ideaDir, decision, comment = '') {
  if (!['approve', 'request_changes', 'comment'].includes(decision)) throw new Error('decision must be approve, request_changes, or comment');
  const reason = validateMergeReviewReport(ideaDir);
  if (reason) throw new Error(reason);
  const reportPath = join(ideaDir, REPORT_JSON);
  const htmlReportPath = join(ideaDir, HTML_REPORT);
  if (!existsSync(htmlReportPath)) throw new Error(`${HTML_REPORT} missing; generate and show the CR report before asking for a decision`);
  const htmlReason = validateHtmlReportFreshness(ideaDir);
  if (htmlReason) throw new Error(htmlReason);
  const report = readJson(reportPath);
  const confirmation = {
    schema_version: 1,
    phase: 'merge-review',
    decision,
    confirmed_by: 'user',
    confirmed_at: new Date().toISOString(),
    report_file: REPORT_JSON,
    report_sha256: fileSha256(reportPath),
    html_report_file: HTML_REPORT,
    html_report_sha256: fileSha256(htmlReportPath),
    source_snapshot: report.repositories.map(repo => ({
      project_root: repo.project_root,
      head_commit: repo.head_commit,
      workspace_fingerprint: repo.workspace_fingerprint,
    })),
    comment: String(comment || ''),
  };
  atomicWriteFile(join(ideaDir, CONFIRMATION), `${JSON.stringify(confirmation, null, 2)}\n`);
  return confirmation;
}

export function validateMergeReviewConfirmation(ideaDir) {
  const reportReason = validateMergeReviewReport(ideaDir);
  if (reportReason) return reportReason;
  const path = join(ideaDir, CONFIRMATION);
  if (!existsSync(path)) return `${CONFIRMATION} missing`;
  const confirmation = readJson(path);
  if (!confirmation || confirmation.schema_version !== 1 || confirmation.phase !== 'merge-review') return `${CONFIRMATION} invalid schema`;
  const htmlReason = validateHtmlReportFreshness(ideaDir);
  if (htmlReason) return htmlReason;
  if (confirmation.decision !== 'approve') return `merge review decision is ${confirmation.decision || 'missing'}`;
  if (confirmation.confirmed_by !== 'user') return 'merge review confirmed_by must be user';
  if (!Number.isFinite(Date.parse(confirmation.confirmed_at))) return 'merge review confirmed_at must be ISO-8601';
  if (confirmation.report_sha256 !== fileSha256(join(ideaDir, REPORT_JSON))) return 'merge review approval is stale: report changed';
  if (confirmation.html_report_file !== HTML_REPORT) return `merge review html_report_file must be ${HTML_REPORT}`;
  if (confirmation.html_report_sha256 !== fileSha256(join(ideaDir, HTML_REPORT))) return 'merge review approval is stale: CR HTML report changed';
  const report = readJson(join(ideaDir, REPORT_JSON));
  const expected = JSON.stringify(report.repositories.map(repo => ({ project_root: repo.project_root, head_commit: repo.head_commit, workspace_fingerprint: repo.workspace_fingerprint })));
  if (JSON.stringify(confirmation.source_snapshot) !== expected) return 'merge review approval source snapshot mismatch';
  return '';
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args[0];
  if (!ideaDir || !existsSync(ideaDir)) {
    process.stderr.write('Usage: merge-review.mjs <idea-dir> [project-root] [--confirm approve|request_changes|comment] [--comment text]\n');
    process.exit(1);
  }
  try {
    const decision = option(args, '--confirm');
    const result = decision
      ? recordMergeReviewDecision(resolve(ideaDir), decision, option(args, '--comment') || '')
      : generateMergeReview(resolve(ideaDir), args[1] && !args[1].startsWith('--') ? args[1] : '.');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(2);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main();

export { CONFIRMATION, HTML_REPORT, REPORT_JSON, REPORT_MD, fileSha256, repositoryRoots };
