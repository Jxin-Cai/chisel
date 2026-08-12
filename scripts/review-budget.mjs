#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const policy = JSON.parse(readFileSync(new URL('../skills/chisel-contracts/review-policy.json', import.meta.url), 'utf8'));

export function planReview({ dimensions = [], findingCount = 0, riskLevel = 'low' } = {}) {
  const unique = [...new Set(dimensions)].slice(0, policy.max_dimension_agents);
  const batches = [];
  for (let index = 0; index < unique.length; index += policy.max_concurrency) {
    batches.push(unique.slice(index, index + policy.max_concurrency));
  }
  return {
    policy,
    dimension_batches: batches,
    dimension_agent_count: unique.length,
    aggregate_assessment_agents: Number(findingCount) > 0 ? policy.max_aggregate_assessment_agents : 0,
    findings_in_single_assessment: Math.max(0, Number(findingCount) || 0),
    targeted_skeptic_finding_budget: Math.min(Math.max(0, Number(findingCount) || 0), policy.targeted_skeptic.max_findings),
    targeted_skeptic_max_concurrency: policy.max_concurrency,
    risk_level: riskLevel,
  };
}

function option(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  const dimensions = option(args, '--dimensions').split(',').filter(Boolean);
  const findingCount = Number(option(args, '--finding-count', '0'));
  const riskLevel = option(args, '--risk-level', 'low');
  if (!['low', 'medium', 'high'].includes(riskLevel)) {
    process.stderr.write(`${JSON.stringify({ error: '--risk-level must be low, medium, or high' })}\n`);
    process.exit(1);
  }
  console.log(JSON.stringify(planReview({ dimensions, findingCount, riskLevel }), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
