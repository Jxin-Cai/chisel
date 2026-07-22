#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

function detectProjectType(ideaDir, projectRoot) {
  const repoMapPath = join(ideaDir, 'as-is/repo-map.json');
  if (existsSync(repoMapPath)) {
    try {
      const repoMap = JSON.parse(readFileSync(repoMapPath, 'utf8'));
      const lang = (repoMap.primary_language || '').toLowerCase();
      if (['typescript', 'javascript'].includes(lang)) return 'node';
      if (lang === 'python') return 'python';
      if (['java', 'kotlin'].includes(lang)) return 'jvm';
    } catch { /* fallthrough */ }
  }
  if (existsSync(join(projectRoot, 'package.json'))) return 'node';
  if (existsSync(join(projectRoot, 'pyproject.toml')) || existsSync(join(projectRoot, 'setup.py'))) return 'python';
  if (existsSync(join(projectRoot, 'build.gradle')) || existsSync(join(projectRoot, 'build.gradle.kts'))) return 'jvm';
  if (existsSync(join(projectRoot, 'pom.xml'))) return 'jvm';
  return 'unknown';
}

function detectBuildCommand(projectRoot, projectType) {
  if (projectType === 'node') {
    const pkgPath = join(projectRoot, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts?.build) return 'npm run build';
        if (pkg.scripts?.compile) return 'npm run compile';
        if (pkg.scripts?.check) return 'npm run check';
      } catch { /* fallthrough */ }
    }
    if (existsSync(join(projectRoot, 'tsconfig.json'))) return 'npx tsc --noEmit';
    return null;
  }
  if (projectType === 'python') {
    if (existsSync(join(projectRoot, 'mypy.ini')) || existsSync(join(projectRoot, 'pyproject.toml'))) {
      return 'python -m mypy . --ignore-missing-imports 2>&1 | head -50';
    }
    return 'python -m py_compile $(find . -name "*.py" -not -path "./.venv/*" | head -20)';
  }
  if (projectType === 'jvm') {
    if (existsSync(join(projectRoot, 'gradlew'))) return './gradlew compileJava --no-daemon';
    if (existsSync(join(projectRoot, 'mvnw'))) return './mvnw compile -q';
    if (existsSync(join(projectRoot, 'pom.xml'))) return 'mvn compile -q';
    return './gradlew compileJava --no-daemon';
  }
  return null;
}

function main() {
  const ideaDir = process.argv[2];
  const projectRoot = process.argv[3] || '.';

  if (!ideaDir) {
    console.error(JSON.stringify({ error: '用法: verify-run.mjs <idea-dir> [project-root]' }));
    process.exit(1);
  }

  const projectType = detectProjectType(ideaDir, projectRoot);
  const command = detectBuildCommand(projectRoot, projectType);

  if (!command) {
    const result = { schema_version: 1, status: 'skip', reason: `no build command detected for project type: ${projectType}`, project_type: projectType, duration_ms: 0 };
    writeFileSync(join(ideaDir, 'verify-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    return;
  }

  const start = Date.now();
  let output = '';
  let status = 'pass';

  try {
    output = execSync(command, { cwd: projectRoot, encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024 });
  } catch (err) {
    status = 'fail';
    output = (err.stdout || '') + '\n' + (err.stderr || '');
    output = output.slice(-3000);
  }

  const duration = Date.now() - start;
  const result = { schema_version: 1, status, command, project_type: projectType, output: output.slice(-2000), duration_ms: duration };
  writeFileSync(join(ideaDir, 'verify-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status, command, project_type: projectType, duration_ms: duration }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
