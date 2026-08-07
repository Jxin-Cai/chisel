export const meta = {
  name: 'chisel-review-skeptic-phase',
  description: 'Adversarial verification of CR findings via independent skeptic agents.',
  phases: [
    { title: 'Verify', detail: 'adversarial skeptic voting on fail findings' },
  ],
}

const {
  pluginRoot,
  ideaDir,
  baseRef,
  failFindings,
  riskLevel,
  schemas,
} = args

const SKEPTIC_VERDICT_SCHEMA = schemas.skeptic
const votesPerFinding = riskLevel === 'high' ? 3 : 1
const maxSkepticAgents = 9
const skepticBudget = Math.floor(maxSkepticAgents / votesPerFinding)

const findingsToVerify = failFindings.slice(0, skepticBudget)
const overflowCount = Math.max(0, failFindings.length - skepticBudget)

if (overflowCount > 0) {
  log(`skeptic budget: verifying ${findingsToVerify.length}/${failFindings.length} findings (${overflowCount} overflow retained without verification)`)
}

function buildSkepticPrompt(finding, angle) {
  const angleInstructions = {
    'code-semantics': 'Focus on whether the code semantics actually produce the claimed defect. Check types, control flow, and data transformations.',
    'runtime-behavior': 'Focus on runtime behavior: threading, timing, state mutations, and observable effects under real execution conditions.',
    'design-intent': 'Focus on whether the flagged code violates the stated design intent, or whether the reviewer misunderstood the architectural context.',
    'general': 'Try to refute this finding. Look for indirect calls, framework conventions, test coverage, and configuration-driven behavior that the reviewer may have missed.',
  }

  return `You are an independent skeptic verifier. Your job is to REFUTE the following CR finding if possible. Default to TRUE_POSITIVE if uncertain.

## Finding to verify
- ID: ${finding.id}
- Dimension: ${finding.dimension}
- Description: ${finding.description}
- Severity: ${finding.severity}
- Confidence: ${finding.confidence}

## Verification angle
${angleInstructions[angle] || angleInstructions['general']}

## Information boundary (STRICT)
- CAN read: source files referenced by the finding, the diff (base ref: ${baseRef || 'HEAD~1'})
- CAN read: ${ideaDir}/cr/cr-context.json for context
- CANNOT read: other CR reports, other verification reports
- CANNOT write: any files

## Instructions
1. Read the source code referenced by the finding
2. Look for evidence that REFUTES the finding (framework guarantees, indirect handling, test coverage, config-driven behavior)
3. If you find strong refuting evidence → verdict: FALSE_POSITIVE
4. If the finding holds under scrutiny → verdict: TRUE_POSITIVE
5. If unclear → verdict: UNCERTAIN (conservative, counts as retained)

Return your verdict via the schema.`
}

phase('Verify')

const verdicts = await parallel(findingsToVerify.map(finding => () => {
  if (votesPerFinding === 3) {
    const angles = ['code-semantics', 'runtime-behavior', 'design-intent']
    return parallel(angles.map(angle => () => agent(
      buildSkepticPrompt(finding, angle),
      { label: `skeptic:${finding.id}:${angle}`, phase: 'Verify', schema: SKEPTIC_VERDICT_SCHEMA, model: 'sonnet' },
    ))).then(votes => {
      const validVotes = (votes || []).filter(Boolean)
      const refuted = validVotes.filter(v => v.verdict === 'FALSE_POSITIVE').length
      const retained = refuted < 2
      log(`skeptic:${finding.id} — ${validVotes.length} votes, ${refuted} refuted → ${retained ? 'RETAINED' : 'DISMISSED'}`)
      return retained ? finding : null
    })
  }
  return agent(
    buildSkepticPrompt(finding, 'general'),
    { label: `skeptic:${finding.id}`, phase: 'Verify', schema: SKEPTIC_VERDICT_SCHEMA, model: 'sonnet' },
  ).then(verdict => {
    if (!verdict) return finding
    const retained = verdict.verdict !== 'FALSE_POSITIVE'
    log(`skeptic:${finding.id} — ${verdict.verdict} → ${retained ? 'RETAINED' : 'DISMISSED'}`)
    return retained ? finding : null
  })
}))

const retainedFindings = (verdicts || []).filter(Boolean)
const overflowFindings = failFindings.slice(skepticBudget)
const allRetained = [...retainedFindings, ...overflowFindings]

log(`skeptic verification complete: ${retainedFindings.length}/${findingsToVerify.length} retained, ${overflowFindings.length} overflow (auto-retained)`)

return { retained: allRetained, dismissed: findingsToVerify.length - retainedFindings.length }
