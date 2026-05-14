#!/usr/bin/env node
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();
const root = join(cwd, '.legacy-feature');
const maxAgeMs = 30 * 60 * 1000;

function cleanIdeaDir(dir) {
  for (const file of readdirSync(dir)) {
    if (!file.startsWith('.current-task-') || !file.endsWith('.json')) continue;
    const path = join(dir, file);
    const age = Date.now() - statSync(path).mtimeMs;
    if (age > maxAgeMs) rmSync(path, { force: true });
  }
}

if (existsSync(root)) {
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (statSync(dir).isDirectory()) cleanIdeaDir(dir);
  }
}
