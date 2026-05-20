#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { extname, join, relative, dirname, sep } from 'node:path';

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

const ENTRY_PATTERNS = {
  http: [
    '@RestController', '@Controller', '@RequestMapping',
    '@GetMapping', '@PostMapping', '@PutMapping', '@DeleteMapping', '@PatchMapping',
    'router.get(', 'router.post(', 'router.put(', 'router.delete(', 'router.patch(',
    'app.get(', 'app.post(', 'app.put(', 'app.delete(',
    '@app.route', '@api_view', '@app.get(', '@app.post(',
    'HandleFunc(', 'r.GET(', 'r.POST(', 'r.PUT(', 'r.DELETE(',
    '@ApiOperation', '@Path',
  ],
  rpc: ['@GrpcService', 'ServiceImpl', 'bindService('],
  message: [
    '@KafkaListener', '@RabbitListener', '@EventListener',
    '@SqsListener', 'consumer.subscribe(', 'channel.consume(',
    '@StreamListener', '@JmsListener',
  ],
  job: [
    '@Scheduled', 'CronJob', 'scheduler.', 'setInterval(',
    'cron.schedule(', '@Cron',
  ],
  cli: [
    'public static void main(', 'func main()',
    "if __name__ == '__main__'", "if __name__ == \"__main__\"",
    'program.command(', 'process.argv',
  ],
};

const IMPORT_PATTERNS = [
  /from\s+['"]([^'"]+)['"]/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^import\s+(?:[\w.*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/gm,
  /^import\s+([\w.]+)/gm,
  /^from\s+([\w.]+)\s+import/gm,
];

const FRAMEWORK_DETECTORS = [
  {
    config: 'package.json', field: 'dependencies', patterns: [
      { match: /express/, name: 'Express' },
      { match: /"react"/, name: 'React' },
      { match: /next/, name: 'Next.js' },
      { match: /"vue"/, name: 'Vue.js' },
      { match: /@angular\/core/, name: 'Angular' },
      { match: /@nestjs/, name: 'NestJS' },
      { match: /fastify/, name: 'Fastify' },
      { match: /koa/, name: 'Koa' },
      { match: /hono/, name: 'Hono' },
    ]
  },
  {
    config: 'pom.xml', patterns: [
      { match: /spring-boot/, name: 'Spring Boot' },
      { match: /spring-cloud/, name: 'Spring Cloud' },
      { match: /mybatis/, name: 'MyBatis' },
      { match: /hibernate/, name: 'Hibernate' },
    ]
  },
  {
    config: 'build.gradle', patterns: [
      { match: /spring-boot/, name: 'Spring Boot' },
      { match: /spring-cloud/, name: 'Spring Cloud' },
    ]
  },
  {
    config: 'build.gradle.kts', patterns: [
      { match: /spring-boot/, name: 'Spring Boot' },
    ]
  },
  {
    config: 'requirements.txt', patterns: [
      { match: /django/i, name: 'Django' },
      { match: /flask/i, name: 'Flask' },
      { match: /fastapi/i, name: 'FastAPI' },
      { match: /sqlalchemy/i, name: 'SQLAlchemy' },
    ]
  },
  {
    config: 'pyproject.toml', patterns: [
      { match: /django/i, name: 'Django' },
      { match: /flask/i, name: 'Flask' },
      { match: /fastapi/i, name: 'FastAPI' },
    ]
  },
  {
    config: 'go.mod', patterns: [
      { match: /gin-gonic/, name: 'Gin' },
      { match: /gorilla\/mux/, name: 'Gorilla Mux' },
      { match: /labstack\/echo/, name: 'Echo' },
      { match: /gofiber\/fiber/, name: 'Fiber' },
    ]
  },
  {
    config: 'Gemfile', patterns: [
      { match: /rails/, name: 'Rails' },
      { match: /sinatra/, name: 'Sinatra' },
    ]
  },
  {
    config: 'Cargo.toml', patterns: [
      { match: /actix-web/, name: 'Actix Web' },
      { match: /axum/, name: 'Axum' },
      { match: /rocket/, name: 'Rocket' },
    ]
  },
];

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'can', 'could', 'not', 'no', 'if', 'then',
  'else', 'when', 'while', 'as', 'so', 'than', 'that', 'this', 'it',
  'all', 'each', 'every', 'any', 'some', 'such', 'only', 'own', 'same',
  'too', 'very', 'just', 'about', 'above', 'after', 'before', 'between',
  'into', 'through', 'during', 'under', 'over', 'out', 'up', 'down',
  '的', '了', '和', '是', '在', '有', '为', '与', '或', '等', '及',
  '将', '对', '中', '个', '被', '把', '从', '到', '要', '这', '那',
  '需要', '使用', '进行', '可以', '通过', '实现', '功能', '系统',
  'null', 'undefined', 'true', 'false', 'return', 'function', 'class',
  'import', 'export', 'const', 'let', 'var', 'new', 'public', 'private',
]);

function listFiles(projectRoot) {
  try {
    const output = execSync('git ls-files', { cwd: projectRoot, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
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

function detectFrameworks(projectRoot) {
  const found = [];
  for (const detector of FRAMEWORK_DETECTORS) {
    const configPath = join(projectRoot, detector.config);
    if (!existsSync(configPath)) continue;
    try {
      const content = readFileSync(configPath, 'utf8');
      for (const { match, name } of detector.patterns) {
        if (match.test(content)) {
          const line = content.split('\n').find(l => match.test(l));
          found.push({ name, evidence: `${detector.config}: ${(line || '').trim().slice(0, 80)}` });
        }
      }
    } catch { /* skip unreadable */ }
  }
  const seen = new Set();
  return found.filter(f => {
    if (seen.has(f.name)) return false;
    seen.add(f.name);
    return true;
  });
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

function findEntryCandidates(projectRoot, sourceFiles) {
  const candidates = [];
  const maxFiles = 5000;
  const filesToScan = sourceFiles.slice(0, maxFiles);

  for (const [type, patterns] of Object.entries(ENTRY_PATTERNS)) {
    for (const pattern of patterns) {
      try {
        const escaped = pattern.replace(/[[\]{}()*+?.\\^$|]/g, '\\$&');
        const output = execSync(
          `grep -rnl --include='*' -- '${escaped}' . 2>/dev/null || true`,
          { cwd: projectRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 15000 }
        );
        for (const line of output.split('\n').filter(Boolean)) {
          const file = line.replace(/^\.\//, '');
          if (!filesToScan.includes(file)) continue;
          if (candidates.some(c => c.file === file && c.type === type)) continue;
          try {
            const lineOutput = execSync(
              `grep -n -- '${escaped}' '${file}' 2>/dev/null | head -1`,
              { cwd: projectRoot, encoding: 'utf8', timeout: 5000 }
            );
            const lineNum = parseInt(lineOutput.split(':')[0], 10) || 0;
            candidates.push({ file, type, evidence: pattern, line: lineNum });
          } catch {
            candidates.push({ file, type, evidence: pattern, line: 0 });
          }
        }
      } catch { /* grep failure or timeout */ }
    }
    if (candidates.length >= 50) break;
  }

  const seen = new Set();
  return candidates
    .filter(c => {
      const key = `${c.file}:${c.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 50);
}

function analyzeImports(projectRoot, sourceFiles) {
  const importCounts = new Map();
  const maxFiles = 3000;
  const filesToAnalyze = sourceFiles.slice(0, maxFiles);

  for (const file of filesToAnalyze) {
    const fullPath = join(projectRoot, file);
    let content;
    try {
      const stat = statSync(fullPath);
      if (stat.size > 512 * 1024) continue;
      content = readFileSync(fullPath, 'utf8');
    } catch { continue; }

    for (const pattern of IMPORT_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(content)) !== null) {
        const target = match[1];
        if (!target) continue;
        if (target.startsWith('.') || target.startsWith('/')) {
          const resolved = resolveRelativeImport(file, target);
          if (resolved) {
            importCounts.set(resolved, (importCounts.get(resolved) || 0) + 1);
          }
        } else {
          importCounts.set(target, (importCounts.get(target) || 0) + 1);
        }
      }
    }
  }

  const internalModules = [...importCounts.entries()]
    .filter(([mod]) => {
      if (mod.startsWith('.') || mod.startsWith('/') || mod.includes('/')) {
        return sourceFiles.some(f => f.includes(mod.replace(/\.[^.]+$/, '')));
      }
      return false;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([file, count]) => ({ file, imported_by_count: count }));

  if (internalModules.length > 0) return internalModules;

  return [...importCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([file, count]) => ({ file, imported_by_count: count }));
}

function resolveRelativeImport(fromFile, target) {
  const dir = dirname(fromFile);
  let resolved = join(dir, target).replace(/\\/g, '/');
  resolved = resolved.replace(/^\.\//, '');
  return resolved;
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

function extractRequirementKeywords(requirementPath) {
  if (!requirementPath || !existsSync(requirementPath)) return [];
  const text = readFileSync(requirementPath, 'utf8');
  const cleaned = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[.*?\]\(.*?\)/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/[|*_~>-]/g, ' ');

  const words = [];
  const cnMatches = cleaned.match(/[一-鿿]{2,}/g) || [];
  words.push(...cnMatches);
  const enMatches = cleaned.match(/[a-zA-Z_][a-zA-Z0-9_]{2,}/g) || [];
  words.push(...enMatches.map(w => w.toLowerCase()));

  const freq = new Map();
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([word]) => word);
}

function findRequirementHints(keywords, sourceFiles) {
  if (keywords.length === 0) return [];
  const results = [];
  for (const file of sourceFiles) {
    const fileLower = file.toLowerCase();
    const matched = keywords.filter(kw => fileLower.includes(kw.toLowerCase()));
    if (matched.length > 0) {
      results.push({ file, matched_keywords: matched });
    }
  }
  return results
    .sort((a, b) => b.matched_keywords.length - a.matched_keywords.length)
    .slice(0, 30);
}

export function generateRepoMap(projectRoot, requirementPath) {
  const allFiles = listFiles(projectRoot);
  const nonBinaryFiles = allFiles.filter(f => !isBinaryFile(f));

  const classified = { source: [], test: [], config: [], docs: [], build: [], generated: [], other: [] };
  for (const file of nonBinaryFiles) {
    const role = classifyFile(file);
    (classified[role] || classified.other).push(file);
  }
  const sourceFiles = classified.source;
  const totalLines = countLines(projectRoot, sourceFiles);

  const keywords = extractRequirementKeywords(requirementPath);

  return {
    schema_version: 1,
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
    frameworks: detectFrameworks(projectRoot),
    directory_summary: buildDirectorySummary(nonBinaryFiles),
    entry_candidates: findEntryCandidates(projectRoot, sourceFiles),
    core_modules: analyzeImports(projectRoot, sourceFiles),
    requirement_hints: findRequirementHints(keywords, sourceFiles),
  };
}

function parseArgs(argv) {
  const args = { projectRoot: null, requirement: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-root' && argv[i + 1]) { args.projectRoot = argv[++i]; continue; }
    if (argv[i] === '--requirement' && argv[i + 1]) { args.requirement = argv[++i]; continue; }
    if (argv[i] === '--output' && argv[i + 1]) { args.output = argv[++i]; continue; }
  }
  if (!args.projectRoot) {
    process.stderr.write('用法: repo-map.mjs --project-root <path> [--requirement <file>] [--output <file>]\n');
    process.exit(1);
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const result = generateRepoMap(args.projectRoot, args.requirement);
  const json = JSON.stringify(result, null, 2);
  if (args.output) {
    writeFileSync(args.output, json + '\n');
    process.stderr.write(`repo-map written to ${args.output} (${result.stats.total_files} files, ${result.stats.source_files} source)\n`);
  } else {
    console.log(json);
  }
}
