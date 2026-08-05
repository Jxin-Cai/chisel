import { readFileSync } from 'node:fs';

const definition = JSON.parse(readFileSync(new URL('../skills/chisel-contracts/workflow-definition.json', import.meta.url), 'utf8'));

if (definition.schema_version !== 1 || !definition.steps || !definition.complexity_paths) {
  throw new Error('invalid workflow-definition.json');
}

export const WORKFLOW_DEFINITION = Object.freeze(definition);
export const ALL_COMPLEXITIES = Object.freeze(Object.keys(definition.complexity_paths));
export const STEP_GATE_MAP = Object.freeze(Object.fromEntries(
  Object.entries(definition.steps).filter(([, value]) => value.gate).map(([step, value]) => [step, value.gate])
));
export const STEP_TO_PHASE = Object.freeze(Object.fromEntries(
  Object.entries(definition.steps).filter(([, value]) => value.phase).map(([step, value]) => [step, value.phase])
));
export const WORKFLOW_PATHS = Object.freeze(Object.fromEntries(
  Object.entries(definition.complexity_paths).map(([complexity, steps]) => [complexity, Object.freeze(steps.map(step => Object.freeze({ step, phase: definition.steps[step]?.phase || null })))])
));
export const WORKFLOW_STEPS = Object.freeze(Object.keys(definition.steps));
