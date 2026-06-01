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
  '.chisel', '.claude',
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

const FRONTEND_PAGE_EXTS = new Set(['.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte']);

function detectFrontendFramework(projectRoot, allFiles) {
  const hasFile = name => allFiles.some(f => f === name || f.endsWith('/' + name));
  const hasDir = prefix => allFiles.some(f => f.startsWith(prefix + '/') || f.startsWith(prefix + '\\'));

  if (hasFile('next.config.js') || hasFile('next.config.ts') || hasFile('next.config.mjs'))
    return hasDir('app') && allFiles.some(f => /^app\/.*page\.\w+$/.test(f)) ? 'nextjs-app' : 'nextjs-pages';
  if (hasFile('nuxt.config.js') || hasFile('nuxt.config.ts')) return 'nuxt';
  if (hasDir('src/router') || allFiles.some(f => /^src\/router\.\w+$/.test(f))) return 'vue-router';
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['react-router-dom'] || deps['react-router']) return 'react-router';
    if (deps['@angular/router']) return 'angular';
  } catch { /* no package.json */ }
  return null;
}

function findFrontendRoutes(projectRoot, allFiles, framework) {
  if (!framework) return [];
  const routes = [];
  const pageExts = [...FRONTEND_PAGE_EXTS];

  if (framework === 'nextjs-app') {
    for (const f of allFiles) {
      const m = f.match(/^app\/(.+)\/page\.(tsx|jsx|ts|js)$/);
      if (m) {
        const routePath = '/' + m[1].replace(/\([^)]+\)\//g, '').replace(/\[([^\]]+)\]/g, ':$1');
        routes.push({ path: routePath, component_file: f, api_calls: extractApiCalls(projectRoot, f) });
      }
    }
  } else if (framework === 'nextjs-pages') {
    for (const f of allFiles) {
      const m = f.match(/^pages\/(.+)\.(tsx|jsx|ts|js)$/);
      if (m && !m[1].startsWith('_') && !m[1].startsWith('api/')) {
        const routePath = '/' + m[1].replace(/\[([^\]]+)\]/g, ':$1').replace(/\/index$/, '');
        routes.push({ path: routePath || '/', component_file: f, api_calls: extractApiCalls(projectRoot, f) });
      }
    }
  } else if (framework === 'nuxt') {
    for (const f of allFiles) {
      const m = f.match(/^pages\/(.+)\.vue$/);
      if (m) {
        const routePath = '/' + m[1].replace(/\[([^\]]+)\]/g, ':$1').replace(/\/index$/, '');
        routes.push({ path: routePath || '/', component_file: f, api_calls: extractApiCalls(projectRoot, f) });
      }
    }
  } else if (framework === 'vue-router' || framework === 'react-router' || framework === 'angular') {
    const routerFiles = allFiles.filter(f =>
      /router/i.test(f) && pageExts.some(ext => f.endsWith(ext))
    ).slice(0, 5);
    for (const rf of routerFiles) {
      try {
        const content = readFileSync(join(projectRoot, rf), 'utf8');
        const pathMatches = content.matchAll(/path:\s*['"`]([^'"`]+)['"`]/g);
        for (const pm of pathMatches) {
          const componentMatch = content.slice(Math.max(0, pm.index - 200), pm.index + 300)
            .match(/component:\s*(?:lazy\(\s*\(\)\s*=>\s*import\(['"`]([^'"`]+)['"`]\))?|element:\s*<(\w+)/);
          routes.push({
            path: pm[1],
            component_file: componentMatch?.[1] || null,
            api_calls: [],
          });
        }
      } catch { /* unreadable */ }
    }
  }
  return routes.slice(0, 30);
}

const API_CALL_PATTERNS = [
  /fetch\s*\(\s*['"`]([^'"`\s]+)['"`]/g,
  /axios\.\w+\s*\(\s*['"`]([^'"`\s]+)['"`]/g,
  /\.\$?(?:get|post|put|patch|delete|request)\s*\(\s*['"`]([^'"`\s]+)['"`]/g,
  /useSWR\s*\(\s*['"`]([^'"`\s]+)['"`]/g,
  /useQuery\s*\([^)]*['"`]([^'"`\s]+)['"`]/g,
];

function extractApiCalls(projectRoot, filePath) {
  try {
    const content = readFileSync(join(projectRoot, filePath), 'utf8');
    const calls = new Set();
    for (const pattern of API_CALL_PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(content)) !== null) {
        const url = m[1];
        if (url.startsWith('/') || url.startsWith('http')) calls.add(url);
      }
    }
    return [...calls].slice(0, 10);
  } catch { return []; }
}

function classifyEntryType(file, frontendRoutes) {
  if (frontendRoutes.some(r => r.component_file === file)) return 'frontend-page';
  const lower = file.toLowerCase();
  if (/\bcomponent/.test(lower) && FRONTEND_PAGE_EXTS.has(extname(file).toLowerCase())) return 'frontend-component';
  if (/\b(controller|handler|endpoint|resource)\b/i.test(lower)) return 'backend-controller';
  if (/\bapi\b/.test(lower) && /\broute/.test(lower)) return 'api-route';
  return 'unknown';
}

export function generateRepoMap(projectRoot, options = {}) {
  const allFiles = listFiles(projectRoot);
  const nonBinaryFiles = allFiles.filter(f => !isBinaryFile(f));

  const classified = { source: [], test: [], config: [], docs: [], build: [], generated: [], other: [] };
  for (const file of nonBinaryFiles) {
    const role = classifyFile(file);
    (classified[role] || classified.other).push(file);
  }
  const sourceFiles = classified.source;
  const totalLines = countLines(projectRoot, sourceFiles);
  const entryCandidates = findEntryCandidates(projectRoot, sourceFiles, options.requirement);

  const framework = detectFrontendFramework(projectRoot, allFiles);
  const frontendRoutes = findFrontendRoutes(projectRoot, allFiles, framework);

  for (const c of entryCandidates) {
    c.type = classifyEntryType(c.file, frontendRoutes);
  }

  return {
    schema_version: 4,
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
    entry_candidates: entryCandidates,
    frontend: {
      framework,
      routes: frontendRoutes,
    },
  };
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must',
  'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while',
  'of', 'at', 'by', 'for', 'with', 'about', 'from', 'to', 'in', 'on',
  'this', 'that', 'these', 'those', 'it', 'its',
  'not', 'no', 'nor', 'so', 'as', 'up', 'out',
  '需要', '实现', '功能', '支持', '添加', '修改', '新增', '删除', '使用', '通过',
  '进行', '处理', '完成', '包括', '相关', '目前', '当前', '系统', '项目',
]);

function extractKeywords(text) {
  const identifiers = text.match(/[A-Z][a-z]+(?:[A-Z][a-z]+)*/g) || [];
  const camelParts = [];
  for (const id of identifiers) {
    const parts = id.replace(/([A-Z])/g, ' $1').trim().split(/\s+/).filter(p => p.length >= 3);
    camelParts.push(...parts.map(p => p.toLowerCase()));
  }
  const words = text.match(/[a-zA-Z_][\w-]{2,}/g) || [];
  const chinese = text.match(/[一-鿿]{2,}/g) || [];
  const all = [...new Set([...camelParts, ...words.map(w => w.toLowerCase()), ...chinese])];
  return all.filter(w => !STOP_WORDS.has(w) && w.length >= 3).slice(0, 30);
}

function findEntryCandidates(projectRoot, sourceFiles, requirementPath) {
  if (!requirementPath || !existsSync(requirementPath)) return [];
  const reqText = readFileSync(requirementPath, 'utf8');
  const keywords = extractKeywords(reqText);
  if (keywords.length === 0) return [];

  const candidates = [];
  for (const file of sourceFiles.slice(0, 3000)) {
    const fileLower = file.toLowerCase();
    const baseName = file.split(/[/\\]/).pop().replace(/\.\w+$/, '').toLowerCase();
    const matched = keywords.filter(kw => fileLower.includes(kw.toLowerCase()));
    const baseMatched = keywords.filter(kw => baseName.includes(kw.toLowerCase()));
    if (matched.length > 0) {
      const confidence = baseMatched.length >= 2 ? 'high' : baseMatched.length === 1 ? 'medium' : 'low';
      candidates.push({ file, matched_keywords: [...new Set(matched)], confidence });
    }
  }
  return candidates
    .sort((a, b) => {
      const confOrder = { high: 0, medium: 1, low: 2 };
      if (confOrder[a.confidence] !== confOrder[b.confidence]) return confOrder[a.confidence] - confOrder[b.confidence];
      return b.matched_keywords.length - a.matched_keywords.length;
    })
    .slice(0, 15);
}

function parseArgs(argv) {
  const args = { projectRoot: null, output: null, requirement: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-root' && argv[i + 1]) { args.projectRoot = argv[++i]; continue; }
    if (argv[i] === '--output' && argv[i + 1]) { args.output = argv[++i]; continue; }
    if (argv[i] === '--requirement' && argv[i + 1]) { args.requirement = argv[++i]; continue; }
  }
  if (!args.projectRoot) {
    process.stderr.write('用法: repo-map.mjs --project-root <path> [--output <file>] [--requirement <file>]\n');
    process.exit(1);
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const result = generateRepoMap(args.projectRoot, { requirement: args.requirement });
  const json = JSON.stringify(result, null, 2);
  if (args.output) {
    writeFileSync(args.output, json + '\n');
    const fwk = result.frontend.framework ? `, frontend: ${result.frontend.framework}, ${result.frontend.routes.length} routes` : '';
    process.stderr.write(`repo-map written to ${args.output} (${result.stats.total_files} files, ${result.stats.source_files} source, ${result.entry_candidates.length} entry candidates${fwk})\n`);
  } else {
    console.log(json);
  }
}
