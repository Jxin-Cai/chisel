#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile, ensureDir } from './workflow-lib.mjs';

const RULE_DESCRIPTION = 'Chisel Wiki: 项目领域知识';
const RULE_CONTENT = '本项目有领域知识库 .chisel/wiki/。在修改代码或回答架构问题前，先检查 .chisel/wiki/index.md 找到相关的禁区、包袱、术语、坏味道。只按需加载当前任务相关的 wiki 文件。';

function main() {
  const projectRoot = process.argv[2] || '.';
  const wikiIndex = join(projectRoot, '.chisel', 'wiki', 'index.md');

  if (!existsSync(wikiIndex)) {
    process.exit(0);
  }

  const content = readFileSync(wikiIndex, 'utf8').trim();
  if (!content) {
    process.exit(0);
  }

  const settingsDir = join(projectRoot, '.claude');
  const settingsFile = join(settingsDir, 'settings.local.json');

  let settings = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    } catch {
      settings = {};
    }
  }

  if (!Array.isArray(settings.rules)) {
    settings.rules = [];
  }

  const existingIndex = settings.rules.findIndex(r => r.description === RULE_DESCRIPTION);
  const rule = {
    description: RULE_DESCRIPTION,
    content: RULE_CONTENT,
    path_match: ['**']
  };

  if (existingIndex >= 0) {
    settings.rules[existingIndex] = rule;
  } else {
    settings.rules.push(rule);
  }

  ensureDir(settingsDir);
  atomicWriteFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'rule_injected', file: settingsFile }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
