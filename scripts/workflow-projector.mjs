#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableAtomicWrite } from './file-transaction.mjs';
import { WORKFLOW_DEFINITION } from './workflow-definition.mjs';

export function renderOrchestrationProjection() {
  const lines = [
    '# GENERATED COMPATIBILITY PROJECTION. Do not edit workflow structure here.',
    '# Canonical source: ./workflow-definition.json',
    'name: chisel-orchestration',
    'version: 2',
    'canonical_definition: ./workflow-definition.json',
    '',
    'steps:',
  ];
  for (const [step, config] of Object.entries(WORKFLOW_DEFINITION.steps)) {
    if (!config.gate) continue;
    lines.push(`  - id: ${step}`, '    postcondition:', `      check: ${config.gate}`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const path = join(new URL('../skills/chisel-contracts/', import.meta.url).pathname, 'orchestration.yaml');
  const expected = renderOrchestrationProjection();
  if (process.argv.includes('--write')) {
    durableAtomicWrite(path, expected);
    console.log(JSON.stringify({ updated: path }));
    return;
  }
  const actual = readFileSync(path, 'utf8');
  if (actual !== expected) {
    process.stderr.write(`${JSON.stringify({ error: 'orchestration.yaml is stale; run workflow-projector.mjs --write' })}\n`);
    process.exit(1);
  }
  console.log(JSON.stringify({ valid: true }));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
