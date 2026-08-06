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
  const requestedVotes = policy.skeptic_votes[riskLevel] || 1;
  const skepticGroups = Math.min(Number(findingCount) || 0, Math.floor(policy.max_skeptic_agents / requestedVotes));
  return {
    policy,
    dimension_batches: batches,
    dimension_agent_count: unique.length,
    skeptic_votes_per_finding: requestedVotes,
    skeptic_finding_budget: skepticGroups,
    overflow_findings: Math.max(0, (Number(findingCount) || 0) - skepticGroups),
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
