#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFrontmatter, readTaskState, resolveProjectName, taskStateFile } from './workflow-lib.mjs';

function parseListSection(text, heading) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex(line => new RegExp(`^#{2,3}\\s+${heading}\\s*$`).test(line.trim()));
  if (start === -1) return [];
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{2,3}\s+/.test(line.trim())) break;
    body.push(line);
  }
  return body
    .map(line => line.replace(/^[-*]\s*(?:\[[ xX]\]\s*)?/, '').trim())
    .filter(line => line && line !== '无' && !line.startsWith('#'));
}

function normalizeList(values) {
  return Array.isArray(values) ? values.map(value => String(value).trim()).filter(Boolean) : [];
}

function patternSource(pattern, source) {
  return { pattern: String(pattern || '').trim(), source };
}

function getTaskScope(ideaDir, taskId) {
  const state = readTaskState(taskStateFile(ideaDir));
  const task = state.tasks[taskId];
  if (!task) return { expected: [], forbidden: [], allowedSymbols: [], forbiddenSymbols: [], behaviorInvariants: [], expectedPatterns: [], forbiddenPatterns: [] };

  const expectedFromState = task.expected_files || [];

  const taskFilePath = join(ideaDir, task.file);
  let expectedFromFile = [];
  let forbidden = [];
  let allowedSymbols = [];
  let forbiddenSymbols = [];
  let behaviorInvariants = [];

  if (existsSync(taskFilePath)) {
    const content = readFileSync(taskFilePath, 'utf8');
    const fm = readFrontmatter(content);
    if (Array.isArray(fm.expected_files) && fm.expected_files.length > 0) {
      expectedFromFile = fm.expected_files;
    }
    forbidden = parseListSection(content, 'Forbidden Files / Areas');
    allowedSymbols = [...normalizeList(fm.allowed_symbols), ...parseListSection(content, 'Allowed Symbols')];
    forbiddenSymbols = [...normalizeList(fm.forbidden_symbols), ...parseListSection(content, 'Forbidden Symbols')];
    behaviorInvariants = parseListSection(content, 'Behavior Invariants');
  }

  const expectedSource = expectedFromFile.length > 0 ? 'task.frontmatter.expected_files' : 'task-state.expected_files';
  const expected = expectedFromFile.length > 0 ? expectedFromFile : expectedFromState;
  return {
    expected,
    forbidden,
    allowedSymbols: [...new Set(allowedSymbols)],
    forbiddenSymbols: [...new Set(forbiddenSymbols)],
    behaviorInvariants: [...new Set(behaviorInvariants)],
    expectedPatterns: expected.map(pattern => patternSource(pattern, expectedSource)).filter(item => item.pattern),
    forbiddenPatterns: forbidden.map(pattern => patternSource(pattern, 'task-file.forbidden-section')).filter(item => item.pattern)
  };
}

function isPathLikeScope(value, explicitPath = false) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (explicitPath) return true;
  return text.includes('.') || text.includes('*') || /\S\/\S/.test(text);
}

function normalizeScopeValue(value) {
  return String(value || '')
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/[。；;，,]$/g, '')
    .trim();
}

function extractScopeFromLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  const inline = raw.match(/^\*\*范围[：:]\*\*\s*(.+)$/);
  if (inline) {
    const value = normalizeScopeValue(inline[1]);
    return isPathLikeScope(value) ? value : null;
  }
  const trimmed = raw.replace(/^[-*]\s*/, '').trim();
  const pathField = trimmed.match(/^(路径|path)[：:]\s*(.+)$/i);
  if (pathField) {
    const value = normalizeScopeValue(pathField[2]);
    return isPathLikeScope(value, true) ? value : null;
  }
  const value = normalizeScopeValue(trimmed);
  return isPathLikeScope(value) ? value : null;
}

function getWikiForbiddenZones(projectRoot) {
  const projectName = resolveProjectName(projectRoot);
  const newPath = join(projectRoot, '.chisel', 'wiki', projectName, 'forbidden-zones.md');
  const legacyPath = join(projectRoot, '.chisel', 'wiki', 'forbidden-zones.md');
  const fzPath = existsSync(newPath) ? newPath : legacyPath;
  if (!existsSync(fzPath)) return [];

  const lines = readFileSync(fzPath, 'utf8').split('\n');
  const zones = [];
  let inScopeBlock = false;

  for (const line of lines) {
    const scopeHeading = line.match(/^\s*\*\*范围[：:]\*\*\s*(.*)$/);
    if (scopeHeading) {
      if (scopeHeading[1].trim()) {
        const value = extractScopeFromLine(line);
        if (value) zones.push(value);
      }
      inScopeBlock = true;
      continue;
    }

    if (inScopeBlock) {
      if (/^\s*###?\s+/.test(line) || /^\s*\*\*[^*]+[：:]\*\*/.test(line)) {
        inScopeBlock = false;
        continue;
      }
      const value = extractScopeFromLine(line);
      if (value) zones.push(value);
    }
  }

  return [...new Set(zones)];
}

function gitNames(projectRoot, args) {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
}

function getChangedFiles(projectRoot = '.') {
  try {
    const all = [
      ...gitNames(projectRoot, ['diff', '--cached', '--name-only']),
      ...gitNames(projectRoot, ['diff', '--name-only']),
      ...gitNames(projectRoot, ['ls-files', '--others', '--exclude-standard'])
    ];
    return [...new Set(all)].filter(f => f && !f.startsWith('.chisel/'));
  } catch {
    return [];
  }
}

function changedText(projectRoot, file) {
  try {
    const diff = execFileSync('git', ['diff', '--cached', '--', file], { cwd: projectRoot, encoding: 'utf8' })
      + execFileSync('git', ['diff', '--', file], { cwd: projectRoot, encoding: 'utf8' });
    if (diff.trim()) return diff;
    return existsSync(join(projectRoot, file)) ? readFileSync(join(projectRoot, file), 'utf8') : '';
  } catch {
    return existsSync(join(projectRoot, file)) ? readFileSync(join(projectRoot, file), 'utf8') : '';
  }
}

function matchOne(file, item) {
  const pattern = typeof item === 'string' ? item : item.pattern;
  const source = typeof item === 'string' ? 'unknown' : item.source;
  if (!pattern) return null;
  if (file === pattern) return { pattern, source, match_type: 'exact' };
  if (pattern.endsWith('/') && file.startsWith(pattern)) return { pattern, source, match_type: 'prefix_slash' };
  if (pattern.endsWith('/*') && file.startsWith(pattern.slice(0, -1))) return { pattern, source, match_type: 'glob_star' };
  if (pattern.endsWith('/**') && file.startsWith(pattern.slice(0, -2))) return { pattern, source, match_type: 'glob_double_star' };
  return null;
}

function matchScopeProofs(file, patterns) {
  return patterns.map(pattern => matchOne(file, pattern)).filter(Boolean);
}

function proofStatus(expectedProofs, forbiddenProofs, hasExpectedScope) {
  const forbidden = forbiddenProofs.length > 0;
  const unexpected = hasExpectedScope && expectedProofs.length === 0;
  if (forbidden && unexpected) return 'forbidden_and_unexpected';
  if (forbidden) return 'forbidden';
  if (unexpected) return 'unexpected';
  if (!hasExpectedScope) return 'unchecked_no_expected_scope';
  return 'within_expected';
}

function symbolHits(text, symbols = []) {
  return symbols.filter(symbol => symbol && text.includes(symbol));
}

function getOtherTasksExpectedPatterns(ideaDir, currentTaskId) {
  const state = readTaskState(taskStateFile(ideaDir));
  const patterns = [];
  for (const [id, task] of Object.entries(state.tasks || {})) {
    if (id === currentTaskId) continue;
    const files = task.expected_files || [];
    const taskFilePath = join(ideaDir, task.file);
    let fromFile = [];
    if (existsSync(taskFilePath)) {
      const fm = readFrontmatter(readFileSync(taskFilePath, 'utf8'));
      if (Array.isArray(fm.expected_files) && fm.expected_files.length > 0) fromFile = fm.expected_files;
    }
    const src = fromFile.length > 0 ? fromFile : files;
    for (const p of src) patterns.push(patternSource(p, `other-task:${id}`));
  }
  return patterns;
}

function check(ideaDir, taskId, projectRoot = '.') {
  const { expected, forbidden, allowedSymbols, forbiddenSymbols, behaviorInvariants, expectedPatterns, forbiddenPatterns } = getTaskScope(ideaDir, taskId);
  const wikiForbidden = getWikiForbiddenZones(projectRoot);
  const wikiForbiddenPatterns = wikiForbidden.map(pattern => patternSource(pattern, 'wiki.forbidden-zones'));
  const allForbidden = [...new Set([...forbidden, ...wikiForbidden])];
  const allForbiddenPatterns = [...forbiddenPatterns, ...wikiForbiddenPatterns];
  const otherTasksPatterns = getOtherTasksExpectedPatterns(ideaDir, taskId);
  const changedFiles = getChangedFiles(projectRoot);

  const violations = [];
  const hitProofs = [];
  const symbolHitsByFile = [];
  const scopeWarnings = [];

  for (const file of changedFiles) {
    const expectedProofs = matchScopeProofs(file, expectedPatterns);
    const forbiddenProofs = matchScopeProofs(file, allForbiddenPatterns);
    const text = changedText(projectRoot, file);
    const allowedSymbolHits = symbolHits(text, allowedSymbols);
    const forbiddenSymbolHits = symbolHits(text, forbiddenSymbols);
    const undeclaredSymbolChange = allowedSymbols.length > 0 && allowedSymbolHits.length === 0;
    const status = proofStatus(expectedProofs, forbiddenProofs, expected.length > 0);
    hitProofs.push({ file, expected: expectedProofs, forbidden: forbiddenProofs, status });
    symbolHitsByFile.push({ file, allowed: allowedSymbolHits, forbidden: forbiddenSymbolHits, undeclared_symbol_change: undeclaredSymbolChange });

    for (const proof of forbiddenProofs) {
      violations.push({ file, type: 'forbidden', reason: 'file is in forbidden scope', proof });
    }
    for (const symbol of forbiddenSymbolHits) {
      violations.push({ file, type: 'forbidden_symbol', reason: 'diff touches forbidden symbol', symbol });
    }
    if (expected.length > 0 && expectedProofs.length === 0) {
      const otherProofs = matchScopeProofs(file, otherTasksPatterns);
      if (otherProofs.length > 0) {
        scopeWarnings.push({ file, type: 'belongs_to_other_task', reason: `file is in scope of ${otherProofs[0].source}`, proof: otherProofs[0] });
      } else {
        violations.push({ file, type: 'unexpected', reason: 'file is outside expected scope' });
      }
    }
    if (undeclaredSymbolChange) {
      scopeWarnings.push({ file, type: 'undeclared_symbol_change', reason: 'changed file did not hit any allowed symbol' });
    }
  }

  const EXPORT_PATTERNS = [
    /^\+\s*export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/,
    /^\+\s*export\s*\{\s*([^}]+)\}/,
    /^\+\s*module\.exports\s*[.=]/,
    /^\+\s*(?:public|protected)\s+(?:static\s+)?(?:async\s+)?(\w+)\s*\(/,
  ];
  const taskState = readTaskState(taskStateFile(ideaDir));
  const currentTask = taskState.tasks[taskId];
  const taskExports = currentTask?.exports || [];
  if (taskExports.length > 0) {
    for (const file of changedFiles) {
      const diff = changedText(projectRoot, file);
      for (const line of diff.split('\n')) {
        for (const pattern of EXPORT_PATTERNS) {
          const m = line.match(pattern);
          if (m) {
            const symbols = m[1] ? m[1].split(',').map(s => s.trim().split(/\s+/)[0]) : ['module.exports'];
            for (const sym of symbols) {
              if (sym && !taskExports.includes(sym)) {
                scopeWarnings.push({ file, type: 'undeclared_new_export', reason: `new export '${sym}' not in task.exports`, symbol: sym });
              }
            }
          }
        }
      }
    }
  }

  return {
    schema_version: 3,
    task_id: taskId,
    project_root: projectRoot,
    changed_files: changedFiles,
    expected_scope: expected,
    forbidden_scope: allForbidden,
    symbol_scope: {
      allowed_symbols: allowedSymbols,
      forbidden_symbols: forbiddenSymbols,
      hits: symbolHitsByFile
    },
    invariant_scope: {
      behavior_invariants: behaviorInvariants,
      proof_required: behaviorInvariants.length > 0
    },
    scope_warnings: scopeWarnings,
    hit_proofs: hitProofs,
    violations,
    summary: {
      changed_files_count: changedFiles.length,
      expected_hits_count: hitProofs.reduce((sum, proof) => sum + proof.expected.length, 0),
      forbidden_hits_count: hitProofs.reduce((sum, proof) => sum + proof.forbidden.length, 0),
      forbidden_symbol_hits_count: symbolHitsByFile.reduce((sum, proof) => sum + proof.forbidden.length, 0),
      unexpected_files_count: hitProofs.filter(proof => proof.status === 'unexpected' || proof.status === 'forbidden_and_unexpected').length,
      violations_count: violations.length
    },
    pass: violations.length === 0
  };
}

function main() {
  const ideaDir = process.argv[2];
  const taskId = process.argv[3];
  const projectRoot = process.argv[4] || '.';

  if (!ideaDir || !taskId) {
    process.stderr.write('用法: scope-check.mjs <idea-dir> <task-id> [project-root]\n');
    process.exit(1);
  }

  const result = check(ideaDir, taskId, projectRoot);
  console.log(JSON.stringify(result, null, 2));

  if (!result.pass) {
    process.stderr.write(`scope violations found: ${result.violations.length}\n`);
    for (const v of result.violations) {
      process.stderr.write(`  [${v.type}] ${v.file}: ${v.reason}\n`);
    }
    process.exit(1);
  }
}

export { check as checkScope, getChangedFiles, getTaskScope, getWikiForbiddenZones, matchScopeProofs };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
