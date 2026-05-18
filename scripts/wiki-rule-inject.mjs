#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile, ensureDir, resolveProjectName } from './workflow-lib.mjs';

function main() {
  const projectRoot = process.argv[2] || '.';
  const projectName = resolveProjectName(projectRoot);
  const newWikiIndex = join(projectRoot, '.chisel', 'wiki', projectName, 'index.md');
  const legacyWikiIndex = join(projectRoot, '.chisel', 'wiki', 'index.md');

  const wikiIndex = existsSync(newWikiIndex) ? newWikiIndex :
    existsSync(legacyWikiIndex) ? legacyWikiIndex : null;

  if (!wikiIndex) {
    process.exit(0);
  }

  const content = readFileSync(wikiIndex, 'utf8').trim();
  if (!content) {
    process.exit(0);
  }

  const wikiPath = existsSync(newWikiIndex) ? `.chisel/wiki/${projectName}/` : '.chisel/wiki/';
  const ruleContent = `本项目有领域知识库 ${wikiPath}。在修改代码或回答架构问题前，先检查 ${wikiPath}index.md 找到相关的禁区、包袱、术语、坏味道。只按需加载当前任务相关的 wiki 文件。`;

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

  const RULE_DESCRIPTION = 'Chisel Wiki: 项目领域知识';
  const existingIndex = settings.rules.findIndex(r => r.description === RULE_DESCRIPTION);
  const rule = {
    description: RULE_DESCRIPTION,
    content: ruleContent,
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
