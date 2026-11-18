---
name: pixelfx-sfx
description: 使用纯 JavaScript (ES Module) 为每个像素特效独立编排专属配音与多个音效变种 (.ogg)，支持按用户配置动态启用音效参考库混音或纯程序化 DSP 合成。
---

# PixelFX 专属特效配音技能 (Pure JS · 动态可选参考库 + AI 合成)

本工作区的配音管线采用 **100% 纯 JavaScript (Node.js ES Module + WebAssembly Ogg Vorbis)**，实现「一特效一配音集（下拉切换当前特效的多个听感变种）」，并且**将音效参考库与技能解耦**：不内置任何固定音频包，完全根据用户在工作台中是否启用音效参考库动态切换合成策略。

---

## 0. 绝对红线（严禁违反）
1. **严禁修改任何预设基础设施与用户参考库**：`.agents/`、`AGENTS.md`、`sfx-core/`、`sfx-refs/`、`../tools/` 与 `../src/` 下的所有文件均为**只读保护资产**，严禁修改、覆盖或删除。
2. **严禁在固定模板上套改**：系统不提供可套改的通用白噪声模板。每个特效 `<category>/<name>` 必须先分析其自身的视觉动作帧节奏，在 `workspace/sfx/<category>/<name>.js` 中**从零独立编排**。

---

## 1. 第一步：检查当前音效参考库启用状态（动态解耦，非内置）
音效参考库由用户在前端「专属特效配音 -> 启用参考库 / 参考库管理」中动态挂载和开关。编写配音前，**必须先检查当前参考库是否启用**：

```bash
node workspace/.agents/skills/pixelfx-studio/scripts/studio.mjs status
```

根据输出中的 `音效参考库状态 (sfxRefs)` 选择对应模式：

- **模式 A：参考库未启用 (`active: false`) —— 纯程序化 DSP 合成模式**
  - **严禁调用 `refLayer()` 或 `refSample()`**。
  - 直接使用 `sfx-core` 提供的纯 JS 声学原语（确定性随机源 `sfxRng`、零相位巴特沃斯滤波 `band` / `lowpass` / `highpass`、`resonate` 多模态窄带物理共鸣腔、包络扫频调制、`pixelTick` 奇次谐波瞬态触点、`place` 毫秒级对位），按「低频冲击体 + 中频物理共鸣/主体 + 高频纹理颗粒」独立构建多层声学结构。
- **模式 B：参考库已启用 (`active: true`) —— 参考库采样分层 + AI 合成混合模式**
  - 先检索用户已启用参考库中的匹配采样 ID（观察 `duration` 与 `peak@...s` 瞬态位置）：
    ```bash
    node workspace/.agents/skills/pixelfx-studio/scripts/studio.mjs search-sfx "water splash"
    node workspace/.agents/skills/pixelfx-studio/scripts/studio.mjs search-sfx "impact" --limit 15
    ```
  - 在配音脚本中通过 `await refLayer(refId, begin, end, { low, high, semitones })` 截取参考音频片段、错开音高并分离频段，再叠加 AI 程序化合成层（如 `resonate` 共鸣泛音、`pixelTick` 命中触点与动态调制包络），避免直接原样照搬单条素材。

---

## 2. 第二步：读取视觉关键帧并编写 `workspace/sfx/<category>/<name>.js`

1. 查看 `workspace/fx/<category>/<name>.js`（或 `src/fx/<category>/<name>.js`），提取 `meta.duration` 总时长、`act.hits` 命中时刻与视觉爆发阶段，确保起音与画面关键帧严丝合缝。
2. 从只读桥接 `../../sfx-core/index.js` 导入原语并在顶层调用 `await compileEffectVariants("<category>/<name>", variants)` 构建 3 个左右听感侧重鲜明的变种。
3. 运行编译并实时通知前端：
```bash
node workspace/.agents/skills/pixelfx-studio/scripts/studio.mjs build-sfx <category>/<name> --select default
```
