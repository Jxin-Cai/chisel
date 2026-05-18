# 铁律

以下规则不可违反、不可变通、不可因"合理理由"跳过。

## 1. 状态文件是唯一真相

`orchestration-status.mjs` 的输出是唯一的恢复点判定。  
`task-workflow-state.yaml` 是 task 状态的唯一权威来源。  
不要依据上下文记忆、对话长度或自身推断来决定下一步。

## 2. 禁止跳步

| 阶段 | 前置条件 |
|------|---------|
| to-be 方案 | as-is 已确认（`confirmations/as-is.json` 通过 gate）且 AI 输入版已生成（`as-is/ai-input/` 6 个文件存在）且澄清完成（`clarifications.json` 通过 gate） |
| AI 输入版生成 | as-is 已确认（`confirmations/as-is.json` 通过 gate）且澄清完成（`clarifications.json` 通过 gate） |
| task 拆分 | to-be 已确认（`confirmations/to-be.json` 通过 gate） |
| coding | task 初始化且 `--next-tasks` 返回该 task |
| CR | task 状态为 `coded` 且 report 文件存在 |
| 返修 | CR 结论为 `needs_rework` 且返修次数 < 3 |

## 3. 用户确认不可跳过

`understand:confirm` 和 `plan:confirm` 必须等用户明确确认后才能创建结构化确认文件。  
旧 `.as-is-confirmed` / `.to-be-confirmed` marker 仅用于历史运行目录兼容，新流程不得只创建 marker。  
不要因"需求描述很清楚"而绕过确认。

## 4. 每轮循环必须调用恢复点脚本

```
node ${SCRIPTS}/orchestration-status.mjs <idea-dir|none>
```

只执行脚本返回的 `resume_step`。

## 5. 每步完成后必须验证 gate

```
node ${SCRIPTS}/gate-check.mjs {IDEA_DIR} <gate-id>
```

gate 不通过时不能继续。

## 6. 返修上限

同一 task 最多返修 3 次。超过后脚本会标记为 `blocked`，不得继续重试。

## 7. 冲突优先级

当多个指令来源冲突时，优先级从高到低：

1. 铁律（本文件）
2. 脚本输出（orchestration-status / gate-check）
3. 当前 skill 指令
4. agent 默认行为

## 8. 合理化预防

长上下文下你可能产生以下"合理"冲动——全部是跳步违规：

- 跳 as-is / 用户确认 / AI 输入版 / 独立 CR / report / 状态机步骤
- 先 code 再补 task（task 文件是 coder 的输入契约）
- gate pass 后跨步插入额外工作
- 文件不写只靠上下文（compaction 会截断）
- 违规并行（只有 `--next-tasks` 返回的无依赖 task 才能并行）
- 自动合入 wiki（必须用户逐条确认）
