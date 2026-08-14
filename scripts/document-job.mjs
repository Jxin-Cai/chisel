#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteFile } from './workflow-lib.mjs';

const JOBS = Object.freeze({
  'as-is': {
    sources: ['requirement.md', 'requirement-classification.json', 'as-is/repo-map.json', 'as-is/evidence-ledger.json', 'as-is/coverage-matrix.json', 'as-is/context-budget.json', 'as-is/ai-input/facts.md', 'as-is/ai-input/call-graph.md', 'as-is/ai-input/data-schema.md', 'as-is/ai-input/api-surface.md', 'as-is/ai-input/change-surface.md'],
    optionalSources: ['as-is/ai-input/field-flow.md'],
    outputs: ['as-is/overview.md', 'as-is/core-walkthrough.md', 'as-is/evidence-index.md', 'as-is/context-budget.md'],
    optionalOutputDirs: ['as-is/details'],
  },
  'to-be': {
    sources: ['requirement.md', 'requirement-clarification.json', 'requirement-classification.json', 'to-be/design-notes.json', 'to-be/tasks.json', 'to-be/traceability-matrix.json', 'to-be/impact-risk-report.json'],
    optionalSources: ['requirement-original.md', 'requirement-inputs.json', 'confirmations/requirement.json', 'to-be/data-change-plan.json', 'to-be/api-change-plan.json', 'as-is/ai-input/call-graph.md', 'document-jobs/as-is.json'],
    outputs: ['to-be/implementation-plan.md'],
  },
});

function sha(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function manifest(ideaDir, files) {
  return files.map(path => {
    const file = join(ideaDir, path);
    if (!existsSync(file)) throw new Error(`document job file missing: ${path}`);
    return { path, sha256: sha(file) };
  });
}
function receiptPath(ideaDir, kind) { return join(ideaDir, 'document-jobs', `${kind}.json`); }
function optionalFiles(ideaDir, contract) {
  return [
    ...(contract.optionalSources || []).filter(path => existsSync(join(ideaDir, path))),
    ...(contract.optionalSourceDirs || []).flatMap(dir => recursiveFiles(ideaDir, dir)),
  ].sort();
}
function recursiveFiles(ideaDir, relDir) {
  const absolute = join(ideaDir, relDir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const rel = `${relDir}/${entry.name}`;
    return entry.isDirectory() ? recursiveFiles(ideaDir, rel) : entry.isFile() ? [rel] : [];
  }).sort();
}
function optionalOutputs(ideaDir, contract) {
  return [
    ...(contract.optionalOutputs || []).filter(path => existsSync(join(ideaDir, path))),
    ...(contract.optionalOutputDirs || []).flatMap(dir => {
    const absolute = join(ideaDir, dir);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => `${dir}/${entry.name}`);
    }),
  ].sort();
}
function samePaths(entries, paths) {
  return JSON.stringify((entries || []).map(entry => entry.path).sort()) === JSON.stringify([...paths].sort());
}

export function prepareDocumentJob(ideaDir, kind) {
  const contract = JOBS[kind];
  if (!contract) throw new Error(`unknown document job kind: ${kind}`);
  const now = new Date().toISOString();
  const receipt = {
    schema_version: 1, kind, status: 'pending', prepared_at: now,
    sources: manifest(ideaDir, [...contract.sources, ...optionalFiles(ideaDir, contract)]),
    outputs: [...contract.outputs, ...optionalOutputs(ideaDir, contract)].map(path => ({ path })),
  };
  atomicWriteFile(receiptPath(ideaDir, kind), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function checkDocumentJob(ideaDir, kind) {
  const contract = JOBS[kind];
  const file = receiptPath(ideaDir, kind);
  if (!contract || !existsSync(file)) return { valid: false, status: 'missing', reason: `document-jobs/${kind}.json missing` };
  try {
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    const allowedKeys = new Set(['schema_version', 'kind', 'status', 'prepared_at', 'completed_at', 'sources', 'outputs']);
    if (receipt.schema_version !== 1 || receipt.kind !== kind || Object.keys(receipt).some(key => !allowedKeys.has(key))) return { valid: false, status: 'invalid', reason: 'invalid document job receipt' };
    const expectedSources = [...contract.sources, ...optionalFiles(ideaDir, contract)];
    const expectedOutputs = [...contract.outputs, ...optionalOutputs(ideaDir, contract)];
    if (!samePaths(receipt.sources, expectedSources)) return { valid: false, status: 'stale', reason: 'document job source manifest does not match the complete writer contract' };
    if (!samePaths(receipt.outputs, expectedOutputs)) return { valid: false, status: 'stale', reason: 'document job output manifest does not match generated human documents' };
    if (receipt.status !== 'complete') return { valid: false, status: receipt.status || 'invalid', reason: `document job is ${receipt.status || 'invalid'}` };
    if (!Number.isFinite(Date.parse(receipt.prepared_at)) || !Number.isFinite(Date.parse(receipt.completed_at))) return { valid: false, status: 'invalid', reason: 'document job timestamps are invalid' };
    if ([...(receipt.sources || []), ...(receipt.outputs || [])].some(entry => !/^[a-f0-9]{64}$/.test(entry.sha256 || ''))) return { valid: false, status: 'invalid', reason: 'document job contains an invalid file hash' };
    for (const entry of receipt.sources || []) {
      const source = join(ideaDir, entry.path);
      if (!existsSync(source) || sha(source) !== entry.sha256) return { valid: false, status: 'stale', reason: `document job is stale: ${entry.path} changed` };
    }
    for (const entry of receipt.outputs || []) {
      const output = join(ideaDir, entry.path);
      if (!existsSync(output) || sha(output) !== entry.sha256) return { valid: false, status: 'stale', reason: `document output missing or changed: ${entry.path}` };
    }
    return { valid: true, status: 'complete', receipt };
  } catch (error) { return { valid: false, status: 'invalid', reason: error.message }; }
}

export function completeDocumentJob(ideaDir, kind) {
  const file = receiptPath(ideaDir, kind);
  if (!existsSync(file)) throw new Error(`prepare ${kind} document job first`);
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  for (const entry of receipt.sources || []) {
    const source = join(ideaDir, entry.path);
    if (!existsSync(source) || sha(source) !== entry.sha256) throw new Error(`cannot complete stale document job: ${entry.path}`);
  }
  receipt.outputs = manifest(ideaDir, [...JOBS[kind].outputs, ...optionalOutputs(ideaDir, JOBS[kind])]);
  receipt.status = 'complete';
  receipt.completed_at = new Date().toISOString();
  atomicWriteFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, rawDir, kind] = process.argv.slice(2);
  if (!command || !rawDir || !kind) {
    process.stderr.write('Usage: node document-job.mjs <prepare|complete|check> <idea-dir> <as-is|to-be>\n'); process.exit(1);
  }
  try {
    const ideaDir = resolve(rawDir);
    const result = command === 'prepare' ? prepareDocumentJob(ideaDir, kind)
      : command === 'complete' ? completeDocumentJob(ideaDir, kind)
        : command === 'check' ? checkDocumentJob(ideaDir, kind) : (() => { throw new Error(`unknown command: ${command}`); })();
    console.log(JSON.stringify(result, null, 2));
    if (command === 'check' && !result.valid) process.exit(2);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
}

export { JOBS as DOCUMENT_JOB_CONTRACTS };
