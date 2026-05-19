#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOG_FILE = 'audit-log.jsonl';

export function auditLogFile(ideaDir) {
  return join(ideaDir, LOG_FILE);
}

export function appendAuditLog(ideaDir, entry) {
  if (!ideaDir || ideaDir === 'none') return;
  mkdirSync(ideaDir, { recursive: true });
  const record = { ts: new Date().toISOString(), ...entry };
  appendFileSync(auditLogFile(ideaDir), JSON.stringify(record) + '\n');
}

export function readAuditLog(ideaDir, tail = 0) {
  const file = auditLogFile(ideaDir);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map(line => JSON.parse(line));
  return tail > 0 ? entries.slice(-tail) : entries;
}

export function lastStepTransition(ideaDir) {
  const entries = readAuditLog(ideaDir);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'step_transition') return entries[i];
  }
  return null;
}

export function knowledgeLoadedEntries(ideaDir) {
  return readAuditLog(ideaDir).filter(e => e.type === 'knowledge_loaded');
}

export function knowledgeHitRate(ideaDir) {
  const loaded = knowledgeLoadedEntries(ideaDir);
  const allIds = new Set(loaded.map(e => e.entry_id));
  const usedIds = new Set(loaded.filter(e => e.used).map(e => e.entry_id));
  return { loaded: allIds.size, used: usedIds.size, rate: allIds.size > 0 ? usedIds.size / allIds.size : 0 };
}

function main() {
  const [ideaDir, command, ...rest] = process.argv.slice(2);
  if (!ideaDir || !command) {
    process.stderr.write('用法: audit-log.mjs <idea-dir> <tail|last-step> [--tail N]\n');
    process.exit(1);
  }

  switch (command) {
    case 'tail': {
      const n = Number(rest[0] || 10);
      const entries = readAuditLog(ideaDir, n);
      console.log(JSON.stringify(entries, null, 2));
      break;
    }
    case 'last-step': {
      const entry = lastStepTransition(ideaDir);
      console.log(JSON.stringify(entry));
      break;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
