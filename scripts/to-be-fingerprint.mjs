#!/usr/bin/env node
import { resolve } from 'node:path';
import { toBePlanFingerprint } from './to-be-confirmation.mjs';
import { resolveExistingIdeaDirectory } from './control-plane.mjs';

const ideaDir = process.argv[2] ? resolveExistingIdeaDirectory(process.argv[2], process.cwd()) : '';
if (!ideaDir) {
  process.stderr.write('Usage: node to-be-fingerprint.mjs <idea-dir>\n');
  process.exit(1);
}
const fingerprint = toBePlanFingerprint(resolve(ideaDir));
if (!fingerprint) {
  process.stderr.write('cannot fingerprint incomplete to-be artifacts\n');
  process.exit(2);
}
process.stdout.write(`${fingerprint}\n`);
