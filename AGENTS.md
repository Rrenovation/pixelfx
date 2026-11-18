# PixelFX Studio — AI Agent Workspace Guide

本仓库包含两个核心空间：
- **`src/fx/`**：只读内置特效库（21 大类、244 个代码驱动像素特效）。
- **`workspace/`**：可实时热同步的 AI 创作工作区（与 Web UI 保持 `fs.watch + SSE` 毫秒级双向联动）。

在开展工作前，请直接阅读并使用工作区技能与规则：
- 像素视觉特效技能：[`workspace/.agents/skills/pixelfx-studio/SKILL.md`](./workspace/.agents/skills/pixelfx-studio/SKILL.md)
- 专属特效配音技能（纯 JS 合成 + 可选动态音效参考库）：[`workspace/.agents/skills/pixelfx-sfx/SKILL.md`](./workspace/.agents/skills/pixelfx-sfx/SKILL.md)
- 工作区只读保护规则：[`workspace/.agents/rules/pixelfx-workspace.md`](./workspace/.agents/rules/pixelfx-workspace.md)
- 实时状态与控制 CLI：`node workspace/.agents/skills/pixelfx-studio/scripts/studio.mjs status`
