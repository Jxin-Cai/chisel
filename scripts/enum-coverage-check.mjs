#!/usr/bin/env node
// P1 enforcement: verify all enums are covered by their consumers.
// Run manually after adding new steps, complexities, or task states.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { STEP_TO_PHASE, STEP_GATE_MAP, ALL_COMPLEXITIES, TASK_STATES } from './workflow-lib.mjs';

const errors = [];

// Known exceptions: intermediate steps that intentionally have no standalone gate
// (their postconditions are covered by the phase-terminal step's gate).
const STEPS_WITHOUT_GATE = [
  'understand:generate-ai-input',  // covered by as-is-confirmed gate at understand:confirm
  'plan:strategy',                  // intermediate planning steps covered by to-be-exists at plan:design
  'plan:strategy-confirm',
  'plan:decompose',
  'plan:decompose-confirm',
];

// Known exceptions: complexities that intentionally share a branch with 'standard'
const COMPLEXITY_ALIASES = {
  'orchestration-status.mjs': ['complex'],  // complex = standard path (only affects as-is depth)
  'gate-check.mjs': ['complex'],
};

function check(label, expected, actual, source, knownExceptions = []) {
  const missing = expected.filter(v => !actual.includes(v) && !knownExceptions.includes(v));
  if (missing.length > 0) {
    errors.push(`[P1] ${label}: missing ${JSON.stringify(missing)} in ${source}`);
  }
}

// Check 1: All steps in STEP_TO_PHASE are also in STEP_GATE_MAP (excluding known intermediate steps)
const stepsInPhase = Object.keys(STEP_TO_PHASE);
const stepsInGate = Object.keys(STEP_GATE_MAP);
check('STEP_TO_PHASE → STEP_GATE_MAP', stepsInPhase, stepsInGate, 'STEP_GATE_MAP', STEPS_WITHOUT_GATE);
check('STEP_GATE_MAP → STEP_TO_PHASE', stepsInGate, stepsInPhase, 'STEP_TO_PHASE');

// Check 2: ALL_COMPLEXITIES appear in orchestration-status.mjs branch logic
const orchText = readFileSync(join(__dirname, 'orchestration-status.mjs'), 'utf8');
const orchComplexities = ALL_COMPLEXITIES.filter(c => orchText.includes(`'${c}'`) || orchText.includes(`"${c}"`));
check('ALL_COMPLEXITIES in orchestration-status', ALL_COMPLEXITIES, orchComplexities, 'orchestration-status.mjs', COMPLEXITY_ALIASES['orchestration-status.mjs']);

// Check 3: ALL_COMPLEXITIES appear in gate-check.mjs (for done gate complexity-aware logic)
const gateText = readFileSync(join(__dirname, 'gate-check.mjs'), 'utf8');
const gateComplexities = ALL_COMPLEXITIES.filter(c => gateText.includes(`'${c}'`) || gateText.includes(`"${c}"`));
check('ALL_COMPLEXITIES in gate-check', ALL_COMPLEXITIES, gateComplexities, 'gate-check.mjs', COMPLEXITY_ALIASES['gate-check.mjs']);

// Check 4: TASK_STATES coverage in VALID_TRANSITIONS (each state appears at least once as from or to)
const wfText = readFileSync(join(__dirname, 'workflow-lib.mjs'), 'utf8');
const transitionMatches = [...wfText.matchAll(/'([^']+):([^']+)'/g)];
const statesInTransitions = new Set();
for (const m of transitionMatches) {
  if (TASK_STATES.includes(m[1])) statesInTransitions.add(m[1]);
  if (TASK_STATES.includes(m[2])) statesInTransitions.add(m[2]);
}
check('TASK_STATES in VALID_TRANSITIONS', TASK_STATES, [...statesInTransitions], 'VALID_TRANSITIONS');

// Check 5: detectComplexity return values match ALL_COMPLEXITIES
const detectFnText = wfText.slice(wfText.indexOf('export function detectComplexity'));
const returnMatches = [...detectFnText.matchAll(/return\s+'([^']+)'/g)];
const returnedComplexities = [...new Set(returnMatches.map(m => m[1]))];
const invalidReturns = returnedComplexities.filter(c => !ALL_COMPLEXITIES.includes(c));
if (invalidReturns.length > 0) {
  errors.push(`[P1] detectComplexity returns values not in ALL_COMPLEXITIES: ${JSON.stringify(invalidReturns)}`);
}

// Output
if (errors.length === 0) {
  console.log('✓ All enum coverage checks passed.');
  process.exit(0);
} else {
  console.error(`✗ ${errors.length} coverage gap(s) found:\n`);
  for (const e of errors) {
    console.error(`  ${e}`);
  }
  process.exit(1);
}
