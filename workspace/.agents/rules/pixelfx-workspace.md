---
trigger: always_on
description: PixelFX 创作工作区目录规范、只读基础设施保护与全局 UI 实时联动规则
---

# PixelFX Workspace Rules

当前目录是 **PixelFX 像素特效创作工作区**（全栈纯 JavaScript ES Module），与前端 UI 界面保持 `fs.watch + SSE` 毫秒级双向实时绑定：

1. **只读基础设施保护（严禁修改技能规范与参考库）**：
   - 严禁修改、覆盖或删除 `.agents/`、`AGENTS.md`、`core/`、`sfx-core/`、`sfx-refs/`（用户挂载的只读音效参考库）、`../tools/` 与 `../src/` 下的任何文件。
   - 生成新特效或新配音时，**禁止在现成模板上小修小补套改**；应在 `fx/<cat>/<name>.js` 与 `sfx/<cat>/<name>.js` 中针对目标视觉与声学需求从零独立编排。
2. **双技能协同与动态可选参考库**：
   - 调整特效参数、控制 UI 舞台、改造或创造像素视觉特效时，遵循 `.agents/skills/pixelfx-studio/SKILL.md`；
   - 为特效生成专属配音或新增音效变种时，遵循 `.agents/skills/pixelfx-sfx/SKILL.md`：先通过 `studio.mjs status` 检查用户是否启用了音效参考库（启用时结合 `studio.mjs search-sfx` 检索分层混音 + AI 合成；未启用时使用 `sfx-core` 纯程序化 DSP 独立合成）。
3. **实时感知与驱动 UI**：
   - 读取 `state/ui-context.json`（或运行 `node .agents/skills/pixelfx-studio/scripts/studio.mjs status`）获知当前前端选中特效、音效变种、参考库开关状态与参数；
   - 编写 `sfx/<cat>/<name>.js` 后运行 `studio.mjs build-sfx <cat>/<name>` 实时编译并刷新前端变种下拉框；
   - 运行 `studio.mjs ui` / `studio.mjs tune` 实时操控全局 UI 状态。
4. **像素确定性铁律**：源码严禁使用 `Math.random()` 或 `Date`，必须使用确定性随机源 `new Rng(o.seed)` / `sfxRng(seed)`；一次性特效在 `t >= meta.duration` 时必须清空像素。
