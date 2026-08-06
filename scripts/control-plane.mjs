#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export function gitCommonRoot(projectRoot = '.') {
  const root = resolve(projectRoot);
  try {
    const raw = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const commonDir = isAbsolute(raw) ? raw : resolve(root, raw);
    return dirname(commonDir);
  } catch {
    return root;
  }
}

export function controlRoot(projectRoot = '.', env = process.env) {
  return env.CHISEL_CONTROL_ROOT ? resolve(env.CHISEL_CONTROL_ROOT) : join(gitCommonRoot(projectRoot), '.chisel');
}

export function ideaDirectory(projectRoot, ideaName, env = process.env) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(ideaName || '')) throw new Error('idea-name must be kebab-case');
  return join(controlRoot(projectRoot, env), ideaName);
}

function main() {
  const args = process.argv.slice(2);
  const projectIndex = args.indexOf('--project-root');
  const projectRoot = projectIndex >= 0 ? args[projectIndex + 1] : '.';
  const ideaIndex = args.indexOf('--idea');
  const ideaName = ideaIndex >= 0 ? args[ideaIndex + 1] : '';
  try {
    console.log(ideaName ? ideaDirectory(projectRoot, ideaName) : controlRoot(projectRoot));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
