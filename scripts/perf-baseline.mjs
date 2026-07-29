#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, extname } from 'node:path';

function countLoc(dir, extensions = ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.py', '.java', '.go', '.rs']) {
  let total = 0;
  const exclude = ['node_modules', '.git', 'dist', 'build', '.chisel', 'vendor'];
  function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (exclude.includes(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) { walk(full); }
      else if (extensions.includes(extname(e.name))) {
        try { total += readFileSync(full, 'utf8').split('\n').length; } catch { /* skip */ }
      }
    }
  }
  walk(dir);
  return total;
}

function measureBuildTime() {
  const pkg = existsSync('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')) : {};
  const scripts = pkg.scripts || {};
  if (!scripts.build) return null;
  try {
    const start = Date.now();
    execSync('npm run build', { stdio: 'pipe', timeout: 120000 });
    return Date.now() - start;
  } catch { return null; }
}

function measureTestTime() {
  const pkg = existsSync('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')) : {};
  const scripts = pkg.scripts || {};
  if (!scripts.test) return null;
  try {
    const start = Date.now();
    execSync('npm test', { stdio: 'pipe', timeout: 120000 });
    return Date.now() - start;
  } catch (e) { return e.status !== undefined ? Date.now() - Date.now() : null; }
}

function getBundleSize() {
  for (const dir of ['dist', 'build', '.next']) {
    if (!existsSync(dir)) continue;
    let total = 0;
    function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else total += statSync(full).size;
      }
    }
    try { walk(dir); return { dir, bytes: total }; } catch { /* skip */ }
  }
  return null;
}

export function captureBaseline(ideaDir, phase) {
  const projectRoot = process.cwd();
  const baseline = {
    phase,
    timestamp: new Date().toISOString(),
    loc: countLoc(projectRoot),
    build_time_ms: phase === 'after' ? measureBuildTime() : null,
    test_time_ms: null,
    bundle_size: getBundleSize(),
    file_count: (() => {
      try {
        return execSync('git ls-files | wc -l', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      } catch { return null; }
    })(),
  };

  const outFile = join(ideaDir, `perf-${phase}.json`);
  writeFileSync(outFile, JSON.stringify(baseline, null, 2));
  return baseline;
}

export function compareBaselines(ideaDir) {
  const beforePath = join(ideaDir, 'perf-before.json');
  const afterPath = join(ideaDir, 'perf-after.json');
  if (!existsSync(beforePath) || !existsSync(afterPath)) return { error: 'missing baseline files' };

  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(readFileSync(afterPath, 'utf8'));

  const warnings = [];
  const locDelta = after.loc - before.loc;
  if (locDelta > 500) warnings.push(`LOC increased by ${locDelta} lines`);

  if (before.build_time_ms && after.build_time_ms) {
    const pct = ((after.build_time_ms - before.build_time_ms) / before.build_time_ms * 100).toFixed(1);
    if (parseFloat(pct) > 20) warnings.push(`Build time increased by ${pct}%`);
  }

  if (before.bundle_size && after.bundle_size) {
    const pct = ((after.bundle_size.bytes - before.bundle_size.bytes) / before.bundle_size.bytes * 100).toFixed(1);
    if (parseFloat(pct) > 10) warnings.push(`Bundle size increased by ${pct}%`);
  }

  return { before, after, loc_delta: locDelta, warnings, has_regression: warnings.length > 0 };
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args.find(a => !a.startsWith('--'));
  const phaseIdx = args.indexOf('--phase');
  const phase = phaseIdx !== -1 ? args[phaseIdx + 1] : null;

  if (!ideaDir || args.includes('--help')) {
    console.log('用法: node perf-baseline.mjs <idea-dir> --phase <before|after|compare>');
    process.exit(0);
  }

  if (phase === 'compare') {
    console.log(JSON.stringify(compareBaselines(ideaDir), null, 2));
  } else if (phase === 'before' || phase === 'after') {
    console.log(JSON.stringify(captureBaseline(ideaDir, phase), null, 2));
  } else {
    console.log(JSON.stringify(captureBaseline(ideaDir, 'before'), null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
