export const meta = {
  name: 'chisel-review-cr-phase',
  description: 'Batched parallel dimension review with sequential batch execution (max 3 concurrent per batch).',
  phases: [
    { title: 'CR', detail: 'batched parallel quality dimension review' },
  ],
}

const {
  pluginRoot,
  ideaDir,
  baseRef,
  projectRoot,
  taskIds,
  reworkCycle,
  activeDimensions,
  dimensionBatches,
  riskLevel,
  schemas,
} = args

const DIM_CR_SCHEMA = schemas.dim

function buildDimPrompt(dim) {
  const isReReview = reworkCycle > 0
  const dimFile = isReReview
    ? `${pluginRoot}/skills/chisel-review/references/dim-re-review.md`
    : `${pluginRoot}/skills/chisel-review/references/dim-${dim}.md`

  return `You are a code review expert performing a single-dimension quality review.

## Information boundary (STRICT)
- CAN read: ${dimFile}, ${pluginRoot}/skills/chisel-review/references/dim-shared-footer.md, ${ideaDir}/cr/cr-context.json, target source files referenced in the diff
- CANNOT read: other dimension CR reports in ${ideaDir}/cr/, other reviewer outputs
- CANNOT write: anything outside ${ideaDir}/cr/dim-${dim}-cr.md

## Task
Read the dimension definition at ${dimFile}.
Read the shared CR footer at ${pluginRoot}/skills/chisel-review/references/dim-shared-footer.md.
Read the CR context at ${ideaDir}/cr/cr-context.json for the unified diff and task information.
${isReReview ? `This is a RE-REVIEW (rework_cycle=${reworkCycle}). Focus on verifying the fix and checking for new issues introduced by the repair diff. Read repair_diff_files from cr-context.json.` : ''}

Review dimension: ${dim}
Base ref: ${baseRef || 'use git merge-base main HEAD'}
Task IDs: ${taskIds.join(', ')}
Project root: ${projectRoot}

Write your full CR report to ${ideaDir}/cr/dim-${dim}-cr.md with YAML frontmatter:
- dimension: ${dim}
- result: pass or fail
- affected_tasks: array of task IDs with issues (empty if pass)
- rework_count: ${reworkCycle}

Include Rework Items table (if fail) and Observations table (non-blocking notes).
Each finding must have: id, affected_task_id, description, severity (critical/high/medium/low), confidence (0-100), suggestion.

Then return your structured result via the schema. Include all findings with confidence >= 60 in the findings array.`
}

phase('CR')

const allResults = []
for (const batch of dimensionBatches) {
  const batchResults = await parallel(batch.map(dim => () => agent(
    buildDimPrompt(dim),
    { label: `reviewer:${dim}`, phase: 'CR', schema: DIM_CR_SCHEMA, model: 'opus' },
  )))
  allResults.push(...batchResults.filter(Boolean))
  log(`batch [${batch.join(',')}] complete: ${batchResults.filter(Boolean).length}/${batch.length} returned`)
}

log(`CR phase complete: ${allResults.length}/${activeDimensions.length} dimensions reviewed, ${allResults.filter(r => r.result === 'fail').length} fail(s)`)

return { allResults }
