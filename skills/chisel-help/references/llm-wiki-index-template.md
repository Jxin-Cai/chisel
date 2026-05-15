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

- 先读本文件和当前 task 的 `Context to Load`。
- 只有任务涉及某个模块时，才读取 `modules/<module>.md`。
- 只有任务触碰历史约束、禁区、包袱或坏味道时，才读取对应 wiki 文件和 ADR。
- 不要一次性加载整个 wiki。
- 当前代码事实优先于 wiki；如果 wiki 与代码冲突，在产物中标记为待更新知识。

## 知识更新规则

- 单次迭代只生成 `knowledge-candidates/`，不要自动合入长期 wiki。
- 长期 wiki 的新增或修改需要用户确认，或作为单独 task 处理。
