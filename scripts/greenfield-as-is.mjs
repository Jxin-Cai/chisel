#!/usr/bin/env node
import { basename, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { computeScore } from './as-is-score.mjs';
import { completeDocumentJob, prepareDocumentJob } from './document-job.mjs';
import { PROJECT_MODES, readProjectProfile } from './project-profile.mjs';
import { atomicWriteFile } from './workflow-lib.mjs';
import { resolveExistingIdeaDirectory } from './control-plane.mjs';

function write(ideaDir, relativePath, content) {
  if (relativePath === 'as-is/overview.md') {
    content = content.replace(/\n### 风险地图[\s\S]*?(?=\n### 用户确认清单)/, '');
  }
  atomicWriteFile(join(ideaDir, relativePath), content.endsWith('\n') ? content : `${content}\n`);
}

function writeJson(ideaDir, relativePath, value) {
  write(ideaDir, relativePath, JSON.stringify(value, null, 2));
}

function requirementSummary(requirement) {
  const section = requirement.match(/^##\s+需求目标\s*\n([\s\S]*?)(?=^##\s+|$(?![\s\S]))/m)?.[1]?.trim();
  const summary = section || requirement.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#')) || '需求目标见 requirement.md。';
  return summary.replaceAll('<', '‹').replaceAll('>', '›').replaceAll('```', "'''");
}

export function generateGreenfieldAsIs(ideaDir) {
  const profile = readProjectProfile(ideaDir);
  if (profile.mode !== PROJECT_MODES.GREENFIELD) {
    throw new Error(`greenfield fast path requires zero historical source files (${profile.reason})`);
  }
  const requirementPath = join(ideaDir, 'requirement.md');
  if (!existsSync(requirementPath)) throw new Error('requirement.md missing');

  const requirement = readFileSync(requirementPath, 'utf8');
  const ideaName = basename(ideaDir);
  const summary = requirementSummary(requirement);
  const generatedAt = new Date().toISOString();
  const na = 'greenfield repository: no historical implementation exists to inspect';

  writeJson(ideaDir, 'as-is/evidence-ledger.json', {
    schema_version: 1,
    project_mode: PROJECT_MODES.GREENFIELD,
    facts: [
      {
        id: 'F-001',
        claim: '仓库中没有历史源代码，as-is 代码侦察不适用',
        status: 'confirmed',
        evidence: [{ file: 'as-is/repo-map.json', line_start: 1, kind: 'generated-repo-map' }],
      },
      {
        id: 'F-002',
        claim: '当前可确认的业务目标来自 requirement.md，而不是既有实现',
        status: 'confirmed',
        evidence: [{ file: 'requirement.md', line_start: 1, kind: 'requirement' }],
      },
    ],
  });

  writeJson(ideaDir, 'as-is/coverage-matrix.json', {
    schema_version: 2,
    project_mode: PROJECT_MODES.GREENFIELD,
    entrypoints: [],
    links: [],
    data: [],
    side_effects: [],
    not_applicable: { entrypoints: na, links: na, data: na, side_effects: na },
  });

  writeJson(ideaDir, 'as-is/context-budget.json', {
    schema_version: 1,
    project_mode: PROJECT_MODES.GREENFIELD,
    generated_at: generatedAt,
    source_files: 0,
    source_lines: 0,
    read_files: ['requirement.md', 'as-is/repo-map.json'],
    unread_relevant_files: [],
    coverage: { applicable: false, reason: na },
  });

  write(ideaDir, 'as-is/ai-input/facts.md', `# 已确认事实\n\n- [F-001] 仓库中没有历史源代码；遗留实现分析不适用。证据：as-is/repo-map.json:1\n- [F-002] 业务目标仅来自 requirement.md。证据：requirement.md:1\n`);
  write(ideaDir, 'as-is/ai-input/call-graph.md', `# 调用链\n\n不适用：greenfield 仓库尚无入口、调用链或前端到 API 映射。\n`);
  write(ideaDir, 'as-is/ai-input/data-schema.md', `# 数据模型\n\n不适用：greenfield 仓库尚无既有表、实体或持久化结构。\n`);
  write(ideaDir, 'as-is/ai-input/api-surface.md', `# 接口面\n\n不适用：greenfield 仓库尚无既有 API、消息或 MCP tool。\n`);
  write(ideaDir, 'as-is/ai-input/change-surface.md', `# 变更面\n\n- Safe-to-change：整个新项目空间。\n- 历史实现影响面：不适用。\n- 新架构和范围边界应在 plan 阶段确定，不在 as-is 阶段虚构。\n`);

  if (existsSync(join(ideaDir, 'requirement-classification.json'))) prepareDocumentJob(ideaDir, 'as-is');

  write(ideaDir, 'as-is/overview.md', `# ${ideaName} 现状概览\n\n### 3分钟摘要\n\n这是一个 greenfield 项目：仓库没有历史源代码、既有 API、数据模型或运行链路。as-is 的有效结论就是“无历史实现可盘点”，后续重点应进入需求澄清和方案设计。\n\n### 读者导航\n\n| 想了解 | 结论 |\n|---|---|\n| 历史代码 | 不存在 |\n| 既有能力 | 不存在 |\n| 业务目标 | 见需求摘要 |\n| 后续决策 | 进入 plan 阶段 |\n\n### 需求摘要\n\n${summary}\n\n### 当前能力边界\n\n当前仓库没有可运行的业务能力。不能把计划中的 UI、API、数据库或 MCP tool 记作 as-is 能力。\n\n### 待澄清问题\n\n无新增 as-is 问题。产品和技术选择以已经完成的 requirement clarification 为准。\n\n## 系统现状\n\n\`\`\`mermaid\ngraph LR\n  R["Requirement"] --> P["Plan and implementation"]\n  H["Historical source code: none"] -. no legacy constraints .-> P\n\`\`\`\n\n### 风险地图\n\n| 风险 | 说明 |\n|---|---|\n| 把未来设计写成现状 | 会制造伪造入口、调用链和数据结构；应留到 plan 阶段 |\n\n### 常见误解点\n\n| 容易误解为 | 实际情况 |\n|---|---|\n| standard 项目必须做重型代码侦察 | 交付复杂度与历史代码探索需求是两条独立轴 |\n\n### 用户确认清单\n\n无需用户确认：repo-map 已确定仓库没有历史源代码。\n\n## 阅读充分性声明\n\n已检查 repo-map 和 requirement。源文件为 0，因此不存在未读历史实现；代码覆盖率不适用，而不是 0% 或伪造的 100%。\n`);

  write(ideaDir, 'as-is/core-walkthrough.md', `# ${ideaName} 核心走查\n\n\`\`\`mermaid\nsequenceDiagram\n  participant Req as Requirement\n  participant Repo as Empty repository\n  participant Plan as Planning\n  Req->>Repo: establish greenfield baseline\n  Repo-->>Plan: no legacy behavior or compatibility constraints\n\`\`\`\n\n## 主路径\n\n没有既有运行路径可走查。后续实现链路必须由 plan 阶段定义。\n\n## 状态变化\n\n仓库当前仅从“无实现”进入“待设计”；不存在历史状态机。\n\n## 异常路径\n\n不适用：没有可执行历史代码。\n\n## Safe-to-change area\n\n整个新项目空间均可设计，但仍受 requirement 和 clarification 的范围约束。\n`);

  write(ideaDir, 'as-is/evidence-index.md', `# 证据索引\n\n| 结论 | 证据位置 | 类型 |\n|---|---|---|\n| [F-001] 无历史源代码 | as-is/repo-map.json:1 | 自动代码地图 |\n| [F-002] 目标来自需求 | requirement.md:1 | 用户需求 |\n\n## N/A 说明\n\n入口、调用链、数据和副作用均因 greenfield 而不适用；未用未来设计填充现状证据。\n`);

  write(ideaDir, 'as-is/context-budget.md', `# 上下文预算\n\n## 已读文件清单\n\n| 文件 | 行范围 | 读取原因 |\n|---|---|---|\n| requirement.md | 全文 | 确认业务目标 |\n| as-is/repo-map.json | 全文 | 确认 source_files 为 0 |\n\n## 总计\n\n- 源代码文件数：0\n- 源代码行数：0\n- 行覆盖率：不适用（greenfield，无历史源代码）\n\n## 未读但可能相关的文件\n\n无。\n\n## 上下文覆盖度自评\n\n| 维度 | 状态 | 说明 |\n|---|---|---|\n| 历史实现 | 不适用 | source_files=0 |\n| 需求基线 | 已覆盖 | 已读取 requirement.md |\n\n- 整体置信度：高\n- 局限说明：未来架构不属于 as-is，将在 plan 阶段确定。\n`);

  if (existsSync(join(ideaDir, 'document-jobs/as-is.json'))) completeDocumentJob(ideaDir, 'as-is');

  const score = computeScore(ideaDir);
  writeJson(ideaDir, 'as-is/quality-score.json', score);
  return {
    project_mode: profile.mode,
    fast_path: true,
    generated_files: 13,
    document_receipt: existsSync(join(ideaDir, 'document-jobs/as-is.json')),
    quality_score: score.overall,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rawIdeaDir = process.argv[2];
  if (!rawIdeaDir) {
    process.stderr.write('Usage: node greenfield-as-is.mjs <idea-dir>\n');
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(generateGreenfieldAsIs(resolveExistingIdeaDirectory(rawIdeaDir, process.cwd())), null, 2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
