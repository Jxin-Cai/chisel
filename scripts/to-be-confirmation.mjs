import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TO_BE_CONFIRMATION_SOURCES = Object.freeze([
  'requirement-classification.json',
  'to-be/implementation-plan.md',
  'to-be/design-notes.json',
  'to-be/tasks.json',
  'to-be/traceability-matrix.json',
  'to-be/impact-risk-report.json',
  'to-be/data-change-plan.json',
  'to-be/api-change-plan.json',
  'to-be/adversarial-review.json',
  'to-be/adversarial-review.md',
  'document-jobs/to-be.json',
]);

const MANDATORY_FINGERPRINT_SOURCES = Object.freeze([
  'requirement-classification.json',
  'to-be/implementation-plan.md',
  'to-be/design-notes.json',
  'to-be/tasks.json',
  'to-be/traceability-matrix.json',
  'to-be/impact-risk-report.json',
  'to-be/adversarial-review.json',
  'to-be/adversarial-review.md',
  'document-jobs/to-be.json',
]);

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function toBePlanFingerprint(ideaDir) {
  if (MANDATORY_FINGERPRINT_SOURCES.some(rel => !existsSync(join(ideaDir, rel)))) return null;
  const hash = createHash('sha256');
  for (const rel of TO_BE_CONFIRMATION_SOURCES.filter(path => existsSync(join(ideaDir, path)))) {
    hash.update(rel).update('\0').update(readFileSync(join(ideaDir, rel))).update('\0');
  }
  return hash.digest('hex');
}

export function toBeDecisionConfirmation(ideaDir) {
  const tasksDocument = readJson(join(ideaDir, 'to-be/tasks.json'), {});
  const tasks = Array.isArray(tasksDocument?.tasks) ? tasksDocument.tasks : [];
  if (tasks.length === 0) throw new Error('to-be/tasks.json has no tasks to acknowledge');
  const risk = readJson(join(ideaDir, 'to-be/impact-risk-report.json'), {});
  const planFingerprint = toBePlanFingerprint(ideaDir);
  if (existsSync(join(ideaDir, 'requirement-classification.json')) && !planFingerprint) {
    throw new Error('cannot fingerprint incomplete classified to-be artifacts');
  }
  return {
    plan_fingerprint: planFingerprint,
    source_files: TO_BE_CONFIRMATION_SOURCES.filter(path => existsSync(join(ideaDir, path))),
    task_acknowledgement: {
      task_ids: tasks.map(task => task?.task_id).filter(Boolean),
      dependencies_reviewed: true,
    },
    risk_acknowledgement: {
      reviewed: true,
      risk_level: risk?.summary?.risk_level || 'not_assessed',
      risk_count: Array.isArray(risk?.risk_matrix) ? risk.risk_matrix.length : 0,
    },
  };
}
