# 合理化预防

长上下文下你可能产生以下"合理"冲动——全部是跳步违规：

- **跳 as-is** → 遗留系统最大风险是"没看懂就改"，as-is 强制前置
- **跳用户确认** → 确认是捕获遗漏和澄清歧义的窗口，不是形式
- **跳写文件** → 上下文会被 compaction 截断，只有文件持久
- **跳 report** → report 是 CR 和汇总的必需输入，gate 会检查
- **跳独立 CR** → 每次 coded 后必须独立 CR，上次通过≠这次通过
- **跳状态机** → 即使改一行也走 `repairing → coded → reviewing`
- **跨步补充** → gate pass 后在当前步骤内补充，不跨步插入
- **违规并行** → 只有 `--next-tasks` 返回的无依赖 task 才能并行
- **先 code 再补 task** → task 文件是 coder 的输入契约，不可后补
- **跳 AI 输入版** → Planner 需要结构化输入，gate 检查 6 文件 + clarifications.md
- **自动合入 wiki** → wiki 是长期知识，必须用户逐条确认才能合入
