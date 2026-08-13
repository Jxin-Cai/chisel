import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { SOURCE_EXTENSIONS, discoverRelatedFiles, listRepositoryFiles, unique } from './source-discovery.mjs';

const MAX_SCAN_FILES = 2_000;
const MAX_CANDIDATES = 30;

function safeRead(path) {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return '';
    const content = readFileSync(path, 'utf8');
    return content.length <= 400_000 ? content : '';
  } catch { return ''; }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function flattenStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(flattenStrings);
  return [];
}

function searchTerms(requirement, dimensions) {
  const scoped = flattenStrings(dimensions.functional_scope || {});
  const text = `${requirement}\n${scoped.join('\n')}`;
  const identifiers = [...text.matchAll(/[A-Za-z_$][\w$]{2,}/g)].map(match => match[0]);
  const pathParts = scoped.flatMap(value => String(value).split(/[/\\.\s]+/));
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'src', 'test', 'tests', 'file', 'files', 'requirement', 'works']);
  return unique([...identifiers, ...pathParts]).filter(term => term.length >= 3 && !stop.has(term.toLowerCase())).slice(0, 60);
}

function moduleOf(file) {
  const parts = dirname(file).split('/').filter(Boolean);
  while (['src', 'lib', 'app', 'apps', 'packages', 'services', 'internal', 'cmd', 'test', 'tests'].includes(parts[0])) parts.shift();
  return parts.slice(0, 2).join('/') || '<root>';
}

function explicitFileHints(projectRoot, dimensions, repositoryFiles) {
  const values = flattenStrings(dimensions.functional_scope || {});
  const matches = [];
  for (const value of values) {
    const normalized = String(value).trim().replace(/^\.\//, '');
    if (!normalized || /[*?{}]/.test(normalized)) continue;
    if (repositoryFiles.includes(normalized)) matches.push(normalized);
    else if (normalized.endsWith('/')) matches.push(...repositoryFiles.filter(file => file.startsWith(normalized)));
    else if (existsSync(join(projectRoot, normalized))) matches.push(...repositoryFiles.filter(file => file === normalized || file.startsWith(`${normalized}/`)));
  }
  return unique(matches);
}

function languageSummary(files) {
  const counts = {};
  for (const file of files) {
    const extension = extname(file).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(extension)) continue;
    counts[extension] = (counts[extension] || 0) + 1;
  }
  return counts;
}

export function collectRepositoryEvidence(projectRoot, requirement, dimensions = {}) {
  const root = resolve(projectRoot || '.');
  const repositoryFiles = listRepositoryFiles(root);
  const sourceFiles = repositoryFiles.filter(file => SOURCE_EXTENSIONS.has(extname(file).toLowerCase()));
  const explicit = explicitFileHints(root, dimensions, repositoryFiles);
  const terms = searchTerms(requirement, dimensions);
  const scored = [];
  for (const file of sourceFiles.slice(0, MAX_SCAN_FILES)) {
    const lowerPath = file.toLowerCase();
    const content = safeRead(join(root, file));
    if (!content) continue;
    const lowerContent = content.toLowerCase();
    let score = explicit.includes(file) ? 100 : 0;
    const matchedTerms = [];
    for (const term of terms) {
      const needle = term.toLowerCase();
      if (lowerPath.includes(needle)) { score += 8; matchedTerms.push(term); }
      else if (lowerContent.includes(needle)) { score += 2; matchedTerms.push(term); }
    }
    if (score > 0) scored.push({ file, score, matched_terms: unique(matchedTerms) });
  }
  const ranked = scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const discovered = explicit.length > 0 ? ranked.filter(item => item.score >= 8).map(item => item.file) : ranked.map(item => item.file);
  const primary = unique([...explicit, ...discovered]).slice(0, 12);
  const related = discoverRelatedFiles(root, primary, terms.join(' '), primary);
  const candidates = unique([...primary, ...related.tests, ...related.dependencies, ...related.callers]).slice(0, MAX_CANDIDATES);
  const modules = unique(candidates.map(moduleOf));
  const files = candidates.map(file => {
    const content = safeRead(join(root, file));
    return { path: file, sha256: sha256(content), module: moduleOf(file), bytes: Buffer.byteLength(content) };
  });
  const evidence = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    project_root: root,
    repository_files: repositoryFiles.length,
    source_files: sourceFiles.length,
    repository_inventory_sha256: sha256(sourceFiles.slice().sort().join('\n')),
    scanned_source_files: Math.min(sourceFiles.length, MAX_SCAN_FILES),
    search_terms: terms,
    explicit_files: explicit,
    candidate_files: files,
    candidate_modules: modules,
    related_tests: related.tests.filter(file => candidates.includes(file)),
    languages: languageSummary(sourceFiles),
    signals: {
      candidate_file_count: files.length,
      candidate_module_count: modules.length,
      has_repository_evidence: files.length > 0,
      has_migration_files: files.some(entry => /(?:^|\/)(?:migrations?|schema|ddl)(?:\/|\.)/i.test(entry.path)),
      has_security_files: files.some(entry => /auth|permission|security|token|credential/i.test(entry.path)),
      has_external_boundary_files: files.some(entry => /client|gateway|adapter|integration|webhook|controller|route|api/i.test(entry.path)),
    },
  };
  evidence.snapshot_sha256 = sha256(JSON.stringify({ files: evidence.candidate_files, terms: evidence.search_terms }));
  return evidence;
}

export function writeRepositoryEvidence(ideaDir, projectRoot, requirement, dimensions) {
  const evidence = collectRepositoryEvidence(projectRoot, requirement, dimensions);
  writeFileSync(join(ideaDir, 'requirement-repository-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

export function readRepositoryEvidence(ideaDir) {
  try { return JSON.parse(readFileSync(join(ideaDir, 'requirement-repository-evidence.json'), 'utf8')); } catch { return null; }
}
