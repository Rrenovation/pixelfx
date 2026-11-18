---
name: pixelfx-studio
description: 在 PixelFX 工作区中动态调整特效参数、实时操控全局 UI 界面、从内置库克隆改造特效或纯代码创造高品质像素艺术游戏特效（双缓冲像素与发光、粒子物理、角色蓄力顿帧动作编排 act、分帧视觉审阅与规范校验）。
---

# PixelFX Studio 工作区技能指南

本工作区目录与 PixelFX Web UI 实时双向连接。你对本目录下 `fx/`、`workspace.json`、`state/ui-command.json` 的任何写入都会在 **100ms 内实时反映到用户的整体 UI 界面上**。

工具脚本位置：`.agents/skills/pixelfx-studio/scripts/studio.mjs`（无论当前工作目录在 `workspace/` 还是仓库根目录均可直接运行）。

---

## 1. 读取当前 UI 界面状态
在动手前先看用户在界面上正盯着哪个特效与什么参数：
```bash
node .agents/skills/pixelfx-studio/scripts/studio.mjs status
```
也可直接读取 `state/ui-context.json`（包含 `space`, `activeView`, `theme`, `id`, `cfg`）。

---

## 2. 动态调整特效参数与操控全局 UI（无需改源码）
你可以直接通过 `studio.mjs` 实时驱动前端滑块、调色板、视图标签页（`live` 动态预览 / `sheet` 透明图集 / `code` 源码）、背景（`topstone` 俯视石砖 / `dark` / `ground` / `sky` / `checker`）或界面主题（`amber` / `aseprite` / `cyber` / `crt`）：

```bash
# 动态调优指定特效的配色、帧率、时长、画布尺寸、角色显示与专用参数（若目标在只读内置库会自动克隆到工作区）
node .agents/skills/pixelfx-studio/scripts/studio.mjs tune water/water-eruption \
  --name "水攻·寒渊" \
  --json '{"palette":["#091a32","#174978","#3295d6","#9be9ff","#ffffff"],"fps":16,"duration":0.95,"extraOpts":{"height":98,"jets":4}}'

# 控制整体 UI 视图切换并推送一条实时状态反馈到前端面板
node .agents/skills/pixelfx-studio/scripts/studio.mjs ui \
  --select "water/water-eruption" \
  --view "live" \
  --bg "topstone" \
  --message "已为你调高水柱喷涌高度并切换为寒渊冰蓝五阶色板"
```

---

## 3. 创造全新特效或改造现有特效（Draft -> Render -> Look -> Refine）

### 步骤 1：参考或克隆
- 搜索内置 244 个参考特效：`node .agents/skills/pixelfx-studio/scripts/studio.mjs search <关键词>`
- 从内置库或工作区克隆副本到 `fx/<category>/<name>.js`：
  ```bash
  node .agents/skills/pixelfx-studio/scripts/studio.mjs fork ice/frost-nova ice/frost-nova-ex --name "极寒新星"
  ```
- API 速查请阅读同目录下的 [references/painter-and-sim.md](./references/painter-and-sim.md)。

### 步骤 2：编写特效代码 (`fx/<category>/<name>.js`)
每个特效是一个纯代码 ES Module，向双缓冲（`color` 像素层 + `light` 加法发光层）绘制：
- `import { ... } from "../../core/index.js";`（已自动桥接至核心引擎）
- 同分类辅助库 `import { ... } from "./_lib.js";`（已自动桥接至 `src/fx/<category>/_lib.js`）
- 必须导出 `export const meta = { name, desc, tags, size: [w, h], origin: [ox, oy], duration, loop, fps, bg, options: { palette, seed, ... } }`
- **模拟型特效**（爆发/打击/法术/投射物）：导出 `export function create(o)` 返回 `{ update(dt), draw(p), drawBack?(p) }`
- **纯函数型特效**（无缝循环光环/法阵/水流/生物）：导出 `export function draw(p, t, o)`，仅依赖 `t / meta.duration`
- **角色演出编排**（可选）：导出 `export const act = { target: { x: 58 }, poses: [...], hits: [{ t, stop, shake, amp, push, straw, skin }] }`
- 同步在 `workspace.json` 的 `effects["<category>/<name>"]` 中填写 `zhName` 与 `zhDesc`（或通过 `studio.mjs tune` 写入）。

### 步骤 3：质量校验、多模态视觉审阅与专属配音变种生成（关键！）
保存文件后，UI 舞台已实时热重载。请务必执行：
```bash
node .agents/skills/pixelfx-studio/scripts/studio.mjs check <category>/<name>
node .agents/skills/pixelfx-studio/scripts/studio.mjs snapshot <category>/<name>
```
`snapshot` 会生成分帧预览大图 `state/snapshots/<category>__<name>.png`。请用图片查看工具（Read File）亲自观察每一帧的剪影清晰度、受光面层次、首帧爆发感与尾帧消散是否干净，迭代打磨至少 2 轮。

如需同时为该特效创作专属配音及多听感音效变种，请阅读 [../pixelfx-sfx/SKILL.md](../pixelfx-sfx/SKILL.md)，编写 `sfx/<category>/<name>.js` 并运行：
```bash
node .agents/skills/pixelfx-studio/scripts/studio.mjs build-sfx <category>/<name> --select default
```
最后用 `studio.mjs ui --message "..."` 告知用户界面已完成！
