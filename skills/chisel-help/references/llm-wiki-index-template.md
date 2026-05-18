# LLM Wiki Index 模板

本文件作为 `.chisel/wiki/` 的根入口，只做导航和渐进加载指引，不承载大段项目知识。

## 必读顺序

1. `project-overview.md` — 项目一句话说明、核心能力、主要模块
2. `system-map.md` — 顶层目录、关键链路、状态文件、命令
3. `glossary.md` — 项目术语与容易误解的词
4. `forbidden-zones.md` — 当前不能动或必须确认后才能动的区域
5. `weird-but-intentional.md` — 看起来奇怪但有意保留的设计
6. `do-not-refactor-yet.md` — 有坏味道但当前不要顺手重构的区域
7. `hotspot-register.md` — 高频改动或高风险区域
8. `adr-index.md` — 架构决策索引

## 渐进加载规则

按 agent-shared-rules §1 按需查询加载。当前代码事实优先于 wiki；冲突时在产物中标记待更新。

## 知识更新规则

- 单次迭代只生成 `knowledge-candidates/`，不要自动合入长期 wiki。
- 长期 wiki 的新增或修改需要用户确认，或作为单独 task 处理。
- 使用 `wiki-manage.mjs --merge` 合入已确认的候选。
- 使用 `wiki-manage.mjs --link` 添加条目间的关联关系。

## 关联关系要求

每个 wiki 文件（forbidden-zones.md、weird-but-intentional.md、do-not-refactor-yet.md、glossary.md）底部必须包含 `## 关联关系` 章节：

```markdown
## 关联关系

| 关联条目 | 关系类型 | 说明 |
|---------|---------|------|
| glossary.md#OrderStatus | 术语解释 | 该禁区涉及的业务概念 |
| weird-but-intentional.md#WBI-003 | 因果关系 | 该包袱是本禁区形成的原因 |
```

关系类型包括：术语解释、因果关系、约束传递、同源问题、互斥、依赖。
