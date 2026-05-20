#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AS_IS_MAIN_FILES = [
  'as-is/repo-map.json',
  'as-is/overview.md',
  'as-is/core-walkthrough.md',
  'as-is/evidence-index.md',
  'as-is/evidence-ledger.json',
  'as-is/coverage-matrix.json',
  'as-is/knowledge-candidates.md',
  'as-is/context-budget.md',
];

const BRANCH_FILES = [
  'as-is/details/entrypoints.md',
  'as-is/details/data-model.md',
  'as-is/details/api-contracts.md',
  'as-is/details/data-flow.md',
];

const COVERAGE_DIMENSIONS = ['entrypoints', 'links', 'data', 'side_effects'];

const DIMENSION_WEIGHTS = {
  coverage: 0.30,
  evidence_density: 0.25,
  uncertainty: 0.15,
  diagram: 0.10,
  structure: 0.10,
  risk_awareness: 0.10,
};

function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function sectionText(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^#{2,3}\\s+${escaped}[^\\n]*\\n`, 'm');
  const headMatch = re.exec(text);
  if (!headMatch) return '';
  const start = headMatch.index + headMatch[0].length;
  const rest = text.slice(start);
  const nextHeading = rest.match(/^#{2,3}\s+/m);
  return nextHeading ? rest.slice(0, nextHeading.index).trim() : rest.trim();
}

function dataRows(text) {
  return text.split('\n')
    .filter(l => /^\|.*\|$/.test(l.trim()))
    .filter(l => {
      const cells = l.split('|').map(c => c.trim()).filter(Boolean);
      return cells.length >= 2 && !cells.every(c => /^-+$/.test(c));
    })
    .filter(l => !/^\|\s*(风险|容易误解为|如果你想了解|文件|维度)\s*\|/.test(l));
}

function countMermaid(text) {
  return (text.match(/```mermaid/g) || []).length;
}

// --- Dimension scorers ---

function scoreCoverage(ideaDir) {
  const matrix = readJson(join(ideaDir, 'as-is/coverage-matrix.json'));
  let coveredDimensions = 0;
  if (matrix) {
    for (const dim of COVERAGE_DIMENSIONS) {
      const items = matrix[dim];
      if (Array.isArray(items) && items.length > 0) coveredDimensions++;
    }
  }
  const matrixScore = coveredDimensions / COVERAGE_DIMENSIONS.length;

  const budget = readText(join(ideaDir, 'as-is/context-budget.md'));
  let lineCoverageRate = 0;
  const totalSection = sectionText(budget, '总计');
  const rateMatch = totalSection.match(/行覆盖率[：:]\s*([\d.]+)\s*%?/);
  if (rateMatch) {
    const val = parseFloat(rateMatch[1]);
    lineCoverageRate = val > 1 ? val / 100 : val;
  }

  const score = matrixScore * 0.5 + Math.min(lineCoverageRate, 1.0) * 0.5;
  return {
    score: round(score),
    detail: {
      matrix_dimensions: COVERAGE_DIMENSIONS.length,
      covered_dimensions: coveredDimensions,
      line_coverage_rate: round(lineCoverageRate),
    },
  };
}

function scoreEvidenceDensity(ideaDir) {
  const ledger = readJson(join(ideaDir, 'as-is/evidence-ledger.json'));
  const facts = ledger?.facts || [];
  const factsWithEvidence = facts.filter(f =>
    Array.isArray(f.evidence) && f.evidence.some(e => e.file && e.line_start > 0)
  ).length;

  let score;
  if (facts.length >= 10) score = 1.0;
  else if (facts.length >= 5) score = 0.7;
  else if (facts.length >= 3) score = 0.5;
  else score = 0.3;

  if (factsWithEvidence < facts.length && facts.length > 0) {
    score *= (factsWithEvidence / facts.length);
  }

  return {
    score: round(score),
    detail: { fact_count: facts.length, facts_with_evidence: factsWithEvidence },
  };
}

function scoreUncertainty(ideaDir) {
  const overview = readText(join(ideaDir, 'as-is/overview.md'));
  let score = 0;

  const uncertaintySection = sectionText(overview, '不确定点');
  if (uncertaintySection && uncertaintySection.split('\n').filter(l => l.trim()).length > 0) score += 0.3;

  const checklist = sectionText(overview, '用户确认清单');
  const cItems = (checklist.match(/C-\d{3}/g) || []).length;
  if (cItems > 0) score += 0.4;

  if (overview.includes('阅读充分性声明')) score += 0.3;

  return {
    score: round(score),
    detail: {
      has_uncertainty_section: score >= 0.3,
      confirmation_items: cItems,
      has_sufficiency_statement: overview.includes('阅读充分性声明'),
    },
  };
}

function scoreDiagram(ideaDir) {
  let total = 0;
  const filesWithMermaid = [];

  const candidates = [
    'as-is/overview.md',
    'as-is/core-walkthrough.md',
    'as-is/details/entrypoints.md',
    'as-is/details/data-model.md',
    'as-is/details/api-contracts.md',
    'as-is/details/data-flow.md',
  ];

  for (const rel of candidates) {
    const text = readText(join(ideaDir, rel));
    const count = countMermaid(text);
    if (count > 0) {
      total += count;
      filesWithMermaid.push(rel);
    }
  }

  let score;
  if (total >= 3) score = 1.0;
  else if (total === 2) score = 0.7;
  else if (total === 1) score = 0.4;
  else score = 0.0;

  return {
    score: round(score),
    detail: { mermaid_count: total, files_with_mermaid: filesWithMermaid },
  };
}

function scoreStructure(ideaDir) {
  const mainPresent = AS_IS_MAIN_FILES.filter(f => existsSync(join(ideaDir, f))).length;
  const mainScore = mainPresent / AS_IS_MAIN_FILES.length;

  const matrix = readJson(join(ideaDir, 'as-is/coverage-matrix.json'));
  let branchExpected = 0;
  let branchPresent = 0;

  if (matrix) {
    if (Array.isArray(matrix.entrypoints) && matrix.entrypoints.length > 2) {
      branchExpected++;
      if (existsSync(join(ideaDir, BRANCH_FILES[0]))) branchPresent++;
    }
    if (Array.isArray(matrix.data) && matrix.data.length > 3) {
      branchExpected++;
      if (existsSync(join(ideaDir, BRANCH_FILES[1]))) branchPresent++;
    }
    if (Array.isArray(matrix.side_effects) && matrix.side_effects.some(s => s.kind === 'external_call')) {
      branchExpected++;
      if (existsSync(join(ideaDir, BRANCH_FILES[2]))) branchPresent++;
    }
    if (Array.isArray(matrix.links) && (matrix.links.length > 5 || matrix.links.some(l => l.type === 'async'))) {
      branchExpected++;
      if (existsSync(join(ideaDir, BRANCH_FILES[3]))) branchPresent++;
    }
  }

  const branchScore = branchExpected > 0 ? branchPresent / branchExpected : 1.0;
  const score = mainScore * 0.7 + branchScore * 0.3;

  return {
    score: round(score),
    detail: {
      main_files: AS_IS_MAIN_FILES.length,
      main_present: mainPresent,
      branch_expected: branchExpected,
      branch_present: branchPresent,
    },
  };
}

function scoreRiskAwareness(ideaDir) {
  const overview = readText(join(ideaDir, 'as-is/overview.md'));
  let score = 0;

  const riskRows = dataRows(sectionText(overview, '风险地图'));
  if (riskRows.length > 0) score += 0.4;

  const misconceptionRows = dataRows(sectionText(overview, '常见误解点'));
  if (misconceptionRows.length > 0) score += 0.3;

  const kcText = readText(join(ideaDir, 'as-is/knowledge-candidates.md'));
  const kcLines = kcText.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
  if (kcLines >= 3) score += 0.3;

  return {
    score: round(score),
    detail: {
      risk_map_rows: riskRows.length,
      misconception_rows: misconceptionRows.length,
      has_knowledge_candidates: kcLines >= 3,
    },
  };
}

// --- Weakness generation ---

function generateWeaknesses(dimensions) {
  const weaknesses = [];
  for (const [dim, data] of Object.entries(dimensions)) {
    if (data.score >= 0.7) continue;
    switch (dim) {
      case 'coverage': {
        const d = data.detail;
        if (d.covered_dimensions < d.matrix_dimensions) {
          const missing = COVERAGE_DIMENSIONS.length - d.covered_dimensions;
          weaknesses.push(`coverage: ${missing} 个 coverage-matrix 维度缺少覆盖项`);
        }
        if (d.line_coverage_rate < 0.3) weaknesses.push(`coverage: 行覆盖率仅 ${(d.line_coverage_rate * 100).toFixed(0)}%`);
        break;
      }
      case 'evidence_density':
        weaknesses.push(`evidence_density: 仅 ${data.detail.fact_count} 条事实证据（建议 ≥5）`);
        break;
      case 'uncertainty':
        if (!data.detail.has_uncertainty_section) weaknesses.push('uncertainty: overview 缺少"不确定点"章节');
        if (data.detail.confirmation_items === 0) weaknesses.push('uncertainty: 用户确认清单无 C-xxx 条目');
        if (!data.detail.has_sufficiency_statement) weaknesses.push('uncertainty: 缺少"阅读充分性声明"');
        break;
      case 'diagram':
        weaknesses.push(`diagram: 仅 ${data.detail.mermaid_count} 个 Mermaid 图（建议 ≥3）`);
        break;
      case 'structure':
        if (data.detail.main_present < data.detail.main_files)
          weaknesses.push(`structure: 缺少 ${data.detail.main_files - data.detail.main_present} 个主干文件`);
        if (data.detail.branch_expected > data.detail.branch_present)
          weaknesses.push(`structure: 缺少 ${data.detail.branch_expected - data.detail.branch_present} 个应产出的枝干文件`);
        break;
      case 'risk_awareness':
        if (data.detail.risk_map_rows === 0) weaknesses.push('risk_awareness: 风险地图为空');
        if (data.detail.misconception_rows === 0) weaknesses.push('risk_awareness: 常见误解点为空');
        if (!data.detail.has_knowledge_candidates) weaknesses.push('risk_awareness: knowledge-candidates 内容不足');
        break;
    }
  }
  return weaknesses;
}

// --- Main ---

function round(n) {
  return Math.round(n * 100) / 100;
}

function bar(score) {
  const filled = Math.round(score * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

export function computeScore(ideaDir) {
  const dimensions = {
    coverage: scoreCoverage(ideaDir),
    evidence_density: scoreEvidenceDensity(ideaDir),
    uncertainty: scoreUncertainty(ideaDir),
    diagram: scoreDiagram(ideaDir),
    structure: scoreStructure(ideaDir),
    risk_awareness: scoreRiskAwareness(ideaDir),
  };

  let overall = 0;
  for (const [dim, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    overall += dimensions[dim].score * weight;
  }

  const weaknesses = generateWeaknesses(dimensions);

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    overall: round(overall),
    dimensions,
    weaknesses,
  };
}

function printSummary(result) {
  console.log(`as-is quality score: ${result.overall.toFixed(2)} / 1.0`);
  for (const [dim, data] of Object.entries(result.dimensions)) {
    const label = dim.padEnd(20);
    console.log(`  ${label} ${data.score.toFixed(2)}  ${bar(data.score)}`);
  }
  if (result.weaknesses.length > 0) {
    console.log('weaknesses:');
    for (const w of result.weaknesses) {
      console.log(`  - ${w}`);
    }
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  const ideaDir = process.argv[2];
  if (!ideaDir) {
    process.stderr.write('用法: node as-is-score.mjs <idea-dir>\n');
    process.exit(1);
  }
  if (!existsSync(ideaDir)) {
    process.stderr.write(`错误: idea-dir 不存在: ${ideaDir}\n`);
    process.exit(1);
  }

  const result = computeScore(ideaDir);
  const outPath = join(ideaDir, 'as-is/quality-score.json');
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  printSummary(result);
}
