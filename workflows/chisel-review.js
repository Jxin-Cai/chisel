export const meta = {
  name: 'chisel-review',
  description: 'Multi-dimension code review: spec gate, batched parallel D2-D9, adversarial skeptic verification.',
  phases: [
    { title: 'Spec Gate', detail: 'spec compliance hard gate — fail blocks all quality dimensions' },
    { title: 'CR', detail: 'batched parallel quality dimension review (max 3 concurrent)' },
    { title: 'Verify', detail: 'adversarial skeptic voting on fail findings' },
    { title: 'Aggregate', detail: 'merge results, compute final verdict' },
  ],
}

const SPEC_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dimension: { type: 'string', const: 'spec' },
    result: { type: 'string', enum: ['pass', 'fail'] },
    affected_tasks: { type: 'array', items: { type: 'string' } },
    rework_count: { type: 'integer' },
  },
  required: ['dimension', 'result', 'affected_tasks', 'rework_count'],
}

const DIM_CR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    result: { type: 'string', enum: ['pass', 'fail'] },
    affected_tasks: { type: 'array', items: { type: 'string' } },
    rework_count: { type: 'integer' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          task_id: { type: 'string' },
          description: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          confidence: { type: 'integer' },
        },
        required: ['id', 'task_id', 'description', 'severity', 'confidence'],
      },
    },
  },
  required: ['dimension', 'result', 'affected_tasks', 'rework_count'],
}

const SKEPTIC_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    finding_id: { type: 'string' },
    dimension: { type: 'string' },
    verdict: { type: 'string', enum: ['TRUE_POSITIVE', 'FALSE_POSITIVE', 'UNCERTAIN'] },
    confidence: { type: 'integer' },
    rationale: { type: 'string' },
  },
  required: ['finding_id', 'dimension', 'verdict', 'confidence'],
}

const schemas = { spec: SPEC_RESULT_SCHEMA, dim: DIM_CR_SCHEMA, skeptic: SKEPTIC_VERDICT_SCHEMA }

const {
  pluginRoot,
  ideaDir,
  baseRef,
  projectRoot,
  complexity,
  riskLevel,
  taskIds,
  reworkCycle,
  activeDimensions,
  dimensionBatches,
} = args

if (!pluginRoot || !ideaDir || !taskIds) {
  throw new Error('args.pluginRoot, args.ideaDir, and args.taskIds are required')
}

log(`chisel-review: ${taskIds.length} task(s), complexity=${complexity}, risk=${riskLevel}, rework_cycle=${reworkCycle}`)

// --- Phase 1: Spec Gate ---
phase('Spec Gate')

const specPrompt = `You are a spec compliance reviewer for a legacy system enhancement.

Read the spec dimension definition: ${pluginRoot}/skills/chisel-review/references/dim-spec.md
Read the shared CR footer: ${pluginRoot}/skills/chisel-review/references/dim-shared-footer.md
Read the CR context: ${ideaDir}/cr/cr-context.json

## Task
Review all changes against the spec (acceptance criteria, scope, forbidden files, behavior invariants).
Base ref for diff: ${baseRef || 'use git merge-base main HEAD'}
Task IDs under review: ${taskIds.join(', ')}

## Output
Write your full CR report to ${ideaDir}/cr/dim-spec-cr.md with YAML frontmatter containing:
- dimension: spec
- result: pass or fail
- affected_tasks: array of task IDs that have issues (empty if pass)
- rework_count: ${reworkCycle}

Then return your structured result via the schema.`

const specResult = await agent(specPrompt, {
  label: 'reviewer:spec',
  phase: 'Spec Gate',
  schema: SPEC_RESULT_SCHEMA,
  model: 'opus',
})

if (!specResult || specResult.result === 'fail') {
  log(`spec gate FAILED: affected_tasks=${JSON.stringify(specResult?.affected_tasks || taskIds)}`)
  return {
    status: 'spec_failed',
    affected_tasks: specResult?.affected_tasks || taskIds,
    rework_count: specResult?.rework_count || reworkCycle,
  }
}

log('spec gate passed — proceeding to quality dimensions')

// --- Phase 2: CR (batched parallel) ---
const crResult = await workflow(
  { scriptPath: `${pluginRoot}/workflows/phases/review-cr-phase.js` },
  { pluginRoot, ideaDir, baseRef, projectRoot, taskIds, reworkCycle, activeDimensions, dimensionBatches, riskLevel, schemas },
)

// --- Phase 3: Verify (skeptic voting) ---
const failFindings = (crResult.allResults || [])
  .filter(r => r && r.result === 'fail')
  .flatMap(r => (r.findings || []).filter(f => f.confidence >= 80).map(f => ({ ...f, dimension: r.dimension })))

let verifiedFindings = failFindings
if (failFindings.length > 0) {
  const verifyResult = await workflow(
    { scriptPath: `${pluginRoot}/workflows/phases/review-skeptic-phase.js` },
    { pluginRoot, ideaDir, baseRef, failFindings, riskLevel, schemas },
  )
  verifiedFindings = verifyResult.retained || []
}

// --- Phase 4: Aggregate ---
phase('Aggregate')

const allDimResults = crResult.allResults || []
const failDims = allDimResults.filter(r => r && r.result === 'fail')
const dismissedIds = new Set(failFindings.filter(f => !verifiedFindings.some(v => v.id === f.id)).map(f => f.id))

const stillFailing = failDims.filter(d => {
  const dimFindings = (d.findings || []).filter(f => f.confidence >= 80)
  const retained = dimFindings.filter(f => !dismissedIds.has(f.id))
  return retained.length > 0
})

if (stillFailing.length === 0) {
  log('all dimensions passed (including post-skeptic upgrades)')
  return { status: 'approved', affected_tasks: [] }
}

const affectedTasks = [...new Set(stillFailing.flatMap(d => d.affected_tasks || []))]
log(`CR needs rework: ${stillFailing.length} dimension(s) failed, affected_tasks=${JSON.stringify(affectedTasks)}`)

return {
  status: 'needs_rework',
  affected_tasks: affectedTasks,
  failed_dimensions: stillFailing.map(d => d.dimension),
  rework_count: reworkCycle,
}
