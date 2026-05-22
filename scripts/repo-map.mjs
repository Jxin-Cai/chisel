#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { extname, join, dirname } from 'node:path';

const EXTENSION_TO_LANGUAGE = {
  '.java': 'Java', '.kt': 'Kotlin', '.scala': 'Scala', '.groovy': 'Groovy',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.vue': 'Vue', '.svelte': 'Svelte',
  '.py': 'Python', '.pyw': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.rb': 'Ruby', '.erb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.swift': 'Swift',
  '.dart': 'Dart',
  '.c': 'C', '.h': 'C',
  '.cpp': 'C++', '.hpp': 'C++', '.cc': 'C++', '.cxx': 'C++',
  '.lua': 'Lua',
  '.r': 'R', '.R': 'R',
  '.sql': 'SQL',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell',
  '.xml': 'XML', '.xsl': 'XML',
  '.yaml': 'YAML', '.yml': 'YAML',
  '.json': 'JSON',
  '.md': 'Markdown',
  '.html': 'HTML', '.htm': 'HTML',
  '.css': 'CSS', '.scss': 'SCSS', '.less': 'LESS',
  '.proto': 'Protobuf',
};

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.jar', '.class', '.war', '.ear',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.db', '.sqlite', '.mdb',
  '.pyc', '.pyo',
  '.min.js', '.min.css',
  '.lock',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '__pycache__',
  '.next', '.nuxt', '.output', '.cache', '.idea', '.vscode',
  'vendor', 'venv', '.venv', 'env', '.env',
  'coverage', '.nyc_output', '.pytest_cache',
  'Pods', '.gradle', '.mvn',
]);

const CLASSIFICATION_RULES = [
  { role: 'test', patterns: [/[/\\]tests?[/\\]/i, /[/\\]__tests__[/\\]/, /\.test\./, /\.spec\./, /Test\.java$/, /_test\.go$/, /test_.*\.py$/] },
  { role: 'config', patterns: [/\.env($|\.)/, /[/\\]config[/\\]/i, /\.config\./, /\.properties$/, /\.ini$/] },
  { role: 'docs', patterns: [/[/\\]docs?[/\\]/i, /README/i, /CHANGELOG/i, /CONTRIBUTING/i, /LICENSE/i] },
  { role: 'build', patterns: [/[/\\]dist[/\\]/, /[/\\]build[/\\]/, /[/\\]out[/\\]/, /webpack\./, /vite\.config/, /rollup\.config/] },
  { role: 'generated', patterns: [/generated/i, /\.g\.dart$/, /\.pb\.go$/, /swagger.*\.json$/, /openapi.*\.json$/] },
];

function listFiles(projectRoot) {
  try {
    const output = execSync('git ls-files', {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.split('\n').filter(Boolean);
  } catch {
    return listFilesWithFind(projectRoot);
  }
}

function listFilesWithFind(root, prefix = '') {
  const results = [];
  try {
    const entries = readdirSync(join(root, prefix), { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        results.push(...listFilesWithFind(root, rel));
      } else {
        results.push(rel);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

function isBinaryFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  if (filePath.endsWith('.min.js') || filePath.endsWith('.min.css')) return true;
  return false;
}

function classifyFile(filePath) {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.patterns.some(p => p.test(filePath))) return rule.role;
  }
  const ext = extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.rst' || ext === '.txt') return 'docs';
  if (ext === '.yaml' || ext === '.yml' || ext === '.toml' || ext === '.ini' || ext === '.properties') return 'config';
  if (ext === '.json' && !filePath.includes('src')) return 'config';
  if (EXTENSION_TO_LANGUAGE[ext]) return 'source';
  return 'other';
}

function detectLanguages(files) {
  const counts = new Map();
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const lang = EXTENSION_TO_LANGUAGE[ext];
    if (!lang) continue;
    const entry = counts.get(lang) || { language: lang, extensions: new Set(), file_count: 0 };
    entry.extensions.add(ext);
    entry.file_count++;
    counts.set(lang, entry);
  }
  const total = files.length || 1;
  return [...counts.values()]
    .sort((a, b) => b.file_count - a.file_count)
    .map(({ language, extensions, file_count }) => ({
      language,
      extensions: [...extensions].sort(),
      file_count,
      percentage: Math.round(file_count / total * 1000) / 10,
    }));
}

function buildDirectorySummary(files) {
  const dirs = new Map();
  for (const file of files) {
    const parts = file.split(/[/\\]/);
    const depth = Math.min(parts.length - 1, 3);
    const dirPath = parts.slice(0, depth).join('/');
    if (!dirPath) continue;
    const entry = dirs.get(dirPath) || { path: dirPath + '/', roles: new Map(), file_count: 0 };
    const role = classifyFile(file);
    entry.roles.set(role, (entry.roles.get(role) || 0) + 1);
    entry.file_count++;
    dirs.set(dirPath, entry);
  }
  return [...dirs.values()]
    .sort((a, b) => b.file_count - a.file_count)
    .slice(0, 40)
    .map(({ path, roles, file_count }) => {
      const dominant = [...roles.entries()].sort((a, b) => b[1] - a[1])[0];
      return { path, role: dominant[0], file_count };
    });
}

function countLines(projectRoot, files) {
  if (files.length === 0) return 0;
  const batch = files.slice(0, 5000);
  try {
    const input = batch.join('\n');
    const output = execSync('xargs wc -l 2>/dev/null | tail -1', {
      cwd: projectRoot,
      encoding: 'utf8',
      input,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });
    const match = output.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

export function generateRepoMap(projectRoot) {
  const allFiles = listFiles(projectRoot);
  const nonBinaryFiles = allFiles.filter(f => !isBinaryFile(f));

  const classified = { source: [], test: [], config: [], docs: [], build: [], generated: [], other: [] };
  for (const file of nonBinaryFiles) {
    const role = classifyFile(file);
    (classified[role] || classified.other).push(file);
  }
  const sourceFiles = classified.source;
  const totalLines = countLines(projectRoot, sourceFiles);

  return {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    project_root: projectRoot,
    stats: {
      total_files: nonBinaryFiles.length,
      total_lines: totalLines,
      source_files: sourceFiles.length,
      test_files: classified.test.length,
      config_files: classified.config.length,
      doc_files: classified.docs.length,
      other_files: classified.build.length + classified.generated.length + classified.other.length,
    },
    languages: detectLanguages(nonBinaryFiles),
    directory_summary: buildDirectorySummary(nonBinaryFiles),
  };
}

function parseArgs(argv) {
  const args = { projectRoot: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-root' && argv[i + 1]) { args.projectRoot = argv[++i]; continue; }
    if (argv[i] === '--output' && argv[i + 1]) { args.output = argv[++i]; continue; }
  }
  if (!args.projectRoot) {
    process.stderr.write('用法: repo-map.mjs --project-root <path> [--output <file>]\n');
    process.exit(1);
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const result = generateRepoMap(args.projectRoot);
  const json = JSON.stringify(result, null, 2);
  if (args.output) {
    writeFileSync(args.output, json + '\n');
    process.stderr.write(`repo-map written to ${args.output} (${result.stats.total_files} files, ${result.stats.source_files} source)\n`);
  } else {
    console.log(json);
  }
}
