import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

export const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.go', '.java', '.kt', '.kts', '.rb', '.php', '.rs', '.cs', '.swift', '.dart',
]);

const TEST_PATH = /(?:^|\/)(?:test|tests|spec|specs|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$|(?:Test|Tests)\.(?:java|kt|cs)$|_test\.go$|^test_.*\.py$/i;

export function unique(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

export function listRepositoryFiles(projectRoot, excludedDirectory = null) {
  try {
    const excluded = excludedDirectory ? relative(projectRoot, resolve(excludedDirectory)).replaceAll('\\', '/') : null;
    const excludedPrefix = excluded && excluded !== '..' && !excluded.startsWith('../') ? `${excluded.replace(/\/$/, '')}/` : null;
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: projectRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\n').filter(file => file && !file.startsWith('.chisel/') && (!excludedPrefix || !file.startsWith(excludedPrefix)));
  } catch { return []; }
}

function safeRead(path) {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return '';
    const content = readFileSync(path, 'utf8');
    return content.length <= 500_000 ? content : '';
  } catch { return ''; }
}

function candidateFile(projectRoot, base) {
  const extensions = ['', ...SOURCE_EXTENSIONS];
  for (const extension of extensions) {
    for (const candidate of [`${base}${extension}`, join(base, `index${extension}`), join(base, `__init__${extension}`)]) {
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return relative(projectRoot, candidate).replaceAll('\\', '/');
      } catch { /* continue */ }
    }
  }
  return null;
}

function resolveJs(projectRoot, sourceFile, specifier) {
  if (specifier.startsWith('.')) return candidateFile(projectRoot, resolve(projectRoot, dirname(sourceFile), specifier));
  const config = ['tsconfig.json', 'jsconfig.json'].map(file => {
    try { return JSON.parse(readFileSync(join(projectRoot, file), 'utf8')); } catch { return null; }
  }).find(Boolean);
  const options = config?.compilerOptions || {};
  const baseUrl = resolve(projectRoot, options.baseUrl || '.');
  for (const [alias, targets] of Object.entries(options.paths || {})) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '(.*)');
    const match = specifier.match(new RegExp(`^${escaped}$`));
    if (!match) continue;
    for (const target of targets || []) {
      const mapped = target.replace('*', match[1] || '');
      const found = candidateFile(projectRoot, resolve(baseUrl, mapped));
      if (found) return found;
    }
  }
  return candidateFile(projectRoot, resolve(baseUrl, specifier));
}

function resolvePython(projectRoot, sourceFile, specifier) {
  const dots = specifier.match(/^\.+/)?.[0].length || 0;
  const moduleName = specifier.slice(dots).replaceAll('.', '/');
  let base = projectRoot;
  if (dots > 0) {
    base = dirname(resolve(projectRoot, sourceFile));
    for (let index = 1; index < dots; index++) base = dirname(base);
  }
  const direct = candidateFile(projectRoot, resolve(base, moduleName));
  if (direct) return direct;
  const suffixes = [`/${moduleName}.py`, `/${moduleName}/__init__.py`];
  return listRepositoryFiles(projectRoot).find(file => suffixes.some(suffix => `/${file}`.endsWith(suffix))) || null;
}

function resolveGo(projectRoot, specifier) {
  let moduleName = '';
  try { moduleName = readFileSync(join(projectRoot, 'go.mod'), 'utf8').match(/^module\s+(\S+)/m)?.[1] || ''; } catch { /* optional */ }
  if (!moduleName || (specifier !== moduleName && !specifier.startsWith(`${moduleName}/`))) return null;
  const directory = specifier === moduleName ? '' : specifier.slice(moduleName.length + 1);
  return listRepositoryFiles(projectRoot).find(file => dirname(file) === directory && file.endsWith('.go') && !file.endsWith('_test.go')) || null;
}

function resolveJvm(projectRoot, specifier, repositoryFiles) {
  if (specifier.endsWith('.*')) {
    const directory = specifier.slice(0, -2).replaceAll('.', '/');
    return repositoryFiles.find(file => file.includes(`/${directory}/`) && /\.(?:java|kt)$/.test(file)) || null;
  }
  const path = specifier.replaceAll('.', '/');
  return repositoryFiles.find(file => file.endsWith(`${path}.java`) || file.endsWith(`${path}.kt`)) || null;
}

function resolveRust(projectRoot, sourceFile, specifier) {
  const normalized = specifier.replace(/^(?:crate|self)::/, '').replaceAll('::', '/');
  return candidateFile(projectRoot, resolve(projectRoot, 'src', normalized))
    || candidateFile(projectRoot, resolve(projectRoot, dirname(sourceFile), normalized));
}

export function importDependencies(projectRoot, sourceFile, content, repositoryFiles = listRepositoryFiles(projectRoot)) {
  const extension = extname(sourceFile).toLowerCase();
  const specs = [];
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte'].includes(extension)) {
    for (const pattern of [/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g, /require\(\s*['"]([^'"]+)['"]\s*\)/g, /import\(\s*['"]([^'"]+)['"]\s*\)/g]) {
      for (const match of content.matchAll(pattern)) specs.push(resolveJs(projectRoot, sourceFile, match[1]));
    }
  } else if (extension === '.py') {
    for (const match of content.matchAll(/^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm)) specs.push(resolvePython(projectRoot, sourceFile, match[1] || match[2]));
  } else if (extension === '.go') {
    for (const block of content.matchAll(/import\s*(?:\(([^)]*)\)|(?:[\w.]+\s+)?"([^"]+)")/gs)) {
      for (const match of `${block[1] || ''}\n${block[2] || ''}`.matchAll(/"([^"]+)"|^\s*(\S+)\s*$/gm)) specs.push(resolveGo(projectRoot, match[1] || match[2]));
    }
  } else if (extension === '.java' || extension === '.kt' || extension === '.kts') {
    for (const match of content.matchAll(/^\s*import\s+([\w.*]+)/gm)) specs.push(resolveJvm(projectRoot, match[1], repositoryFiles));
  } else if (extension === '.rb') {
    for (const match of content.matchAll(/require_relative\s+['"]([^'"]+)['"]/g)) specs.push(candidateFile(projectRoot, resolve(projectRoot, dirname(sourceFile), match[1])));
  } else if (extension === '.rs') {
    for (const match of content.matchAll(/^\s*(?:use|mod)\s+([\w:]+)/gm)) specs.push(resolveRust(projectRoot, sourceFile, match[1]));
  }
  return unique(specs.filter(Boolean));
}

function declaredSymbols(file, content) {
  const stem = basename(file).replace(/\.[^.]+$/, '');
  const symbols = [stem];
  const patterns = [
    /\b(?:class|interface|enum|struct|trait|function|func|def|module)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var|type)\s+([A-Za-z_$][\w$]*)\s*(?:[=:])/g,
    /\bpublic\s+(?:static\s+)?[\w<>, ?\[\]]+\s+([A-Za-z_$][\w$]*)\s*\(/g,
  ];
  for (const pattern of patterns) for (const match of content.matchAll(pattern)) symbols.push(match[1]);
  return unique(symbols).filter(symbol => symbol.length >= 3 && !['index', 'main', 'test', 'tests', 'service', 'handler'].includes(symbol.toLowerCase()));
}

function looksLikeRelatedTest(file, startingPoints, symbols) {
  if (!TEST_PATH.test(file)) return false;
  const lower = file.toLowerCase();
  const stems = startingPoints.map(start => basename(start).replace(/\.[^.]+$/, '').toLowerCase()).filter(stem => stem.length >= 3);
  return stems.some(stem => lower.includes(stem)) || symbols.some(symbol => lower.includes(symbol.toLowerCase()));
}

export function discoverRelatedFiles(projectRoot, startingPoints, taskContent = '', startingHints = startingPoints, excludedDirectory = null) {
  const repositoryFiles = listRepositoryFiles(projectRoot, excludedDirectory);
  const contents = Object.fromEntries(startingPoints.map(file => [file, safeRead(join(projectRoot, file))]));
  const dependencies = unique(startingPoints.flatMap(file => importDependencies(projectRoot, file, contents[file], repositoryFiles)));
  const symbols = unique([
    ...startingPoints.flatMap(file => declaredSymbols(file, contents[file])),
    ...[...taskContent.matchAll(/\b[A-Za-z_$][\w$]{2,}\b/g)].map(match => match[0]).filter(value => /[A-Z_$]|[a-z][A-Z]/.test(value)),
  ]).slice(0, 80);
  const hintMatches = repositoryFiles.filter(file => startingHints.some(hint => file === hint || (hint.endsWith('/') && file.startsWith(hint)) || (hint.endsWith('/**') && file.startsWith(hint.slice(0, -2)))) && !startingPoints.includes(file));
  const tests = repositoryFiles.filter(file => looksLikeRelatedTest(file, startingPoints, symbols));
  const callers = [];
  const symbolPattern = symbols.length > 0 ? new RegExp(`\\b(?:${symbols.map(symbol => symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`) : null;
  if (symbolPattern) {
    for (const file of repositoryFiles) {
      if (startingPoints.includes(file) || dependencies.includes(file) || tests.includes(file) || !SOURCE_EXTENSIONS.has(extname(file).toLowerCase())) continue;
      if (symbolPattern.test(safeRead(join(projectRoot, file)))) callers.push(file);
      if (callers.length >= 40) break;
    }
  }
  return { hint_matches: unique(hintMatches), dependencies, tests: unique(tests), callers: unique(callers), symbols };
}

export function preloadSourceContext(projectRoot, startingPoints, related, { maxFiles = 8, maxCharacters = 80_000, perFileMax = 24_000 } = {}) {
  const candidates = unique([...startingPoints, ...related.tests, ...related.dependencies, ...related.callers]);
  const files = [];
  let characters = 0;
  for (const file of candidates) {
    if (files.length >= maxFiles) break;
    const content = safeRead(join(projectRoot, file));
    if (!content) continue;
    const selected = content.slice(0, perFileMax);
    if (files.length > 0 && characters + selected.length > maxCharacters) continue;
    files.push({ path: file, content: selected, truncated: content.length > selected.length, total_characters: content.length });
    characters += selected.length;
  }
  return { files, characters, omitted: candidates.filter(file => !files.some(entry => entry.path === file)) };
}
