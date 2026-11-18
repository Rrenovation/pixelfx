---
name: pixelfx-sfx
description: 使用纯 JavaScript (ES Module) 为每个像素特效独立编排专属配音与多个音效变种 (.ogg)，支持按用户配置动态启用音效参考库混音或纯程序化 DSP 合成。
---

# PixelFX 专属特效配音技能 (Pure JS · 动态可选参考库 + AI 合成)

本工作区的配音管线采用 **100% 纯 JavaScript (Node.js ES Module + WebAssembly Ogg Vorbis)**，实现「一特效一配音集（下拉切换当前特效的多个听感变种）」，并且**将音效参考库与技能解耦**：不内置任何固定音频包，完全根据用户在工作台中是否启用音效参考库动态切换合成策略。

---

## 0. 绝对红线（严禁违反）
1. **严禁修改任何预设基础设施与用户参考库**：`.agents/`、`AGENTS.md`、`sfx-core/`、`sfx-refs/`、`../tools/` 与 `../src/` 下的所有文件均为**只读保护资产**，严禁修改、覆盖或删除。
2. **严禁在固定模板上套改**：系统不提供可套改的通用白噪声模板。每个特效 `<category>/<name>` 必须先分析其自身的视觉动作帧节奏，在 `sfx/<category>/<name>.js` 中**从零独立编排**。

---

## 1. 第一步：检查当前音效参考库启用状态（动态解耦，非内置）
音效参考库由用户在前端「专属特效配音 -> 启用参考库 / 参考库管理」中动态挂载和开关。编写配音前，**必须先检查当前参考库是否启用**：

```bash
node .agents/skills/pixelfx-studio/scripts/studio.mjs status
```

根据输出中的 `音效参考库状态 (sfxRefs)` 选择对应模式：

- **模式 A：参考库未启用 (`active: false`) —— 纯程序化 DSP 合成模式**
  - **严禁调用 `refLayer()` 或 `refSample()`**。
  - 直接使用 `sfx-core` 提供的纯 JS 声学原语（确定性随机源 `sfxRng`、零相位巴特沃斯滤波 `band` / `lowpass` / `highpass`、`resonate` 多模态窄带物理共鸣腔、包络扫频调制、`pixelTick` 奇次谐波瞬态触点、`place` 毫秒级对位），按「低频冲击体 + 中频物理共鸣/主体 + 高频纹理颗粒」独立构建多层声学结构。
- **模式 B：参考库已启用 (`active: true`) —— 参考库采样分层 + AI 合成混合模式**
  - 先检索用户已启用参考库中的匹配采样 ID（观察 `duration` 与 `peak@...s` 瞬态位置）：
    ```bash
    node .agents/skills/pixelfx-studio/scripts/studio.mjs search-sfx "water splash"
    node .agents/skills/pixelfx-studio/scripts/studio.mjs search-sfx "impact" --limit 15
    ```
  - 在配音脚本中通过 `await refLayer(refId, begin, end, { low, high, semitones })` 截取参考音频片段、错开音高并分离频段，再叠加 AI 程序化合成层（如 `resonate` 共鸣泛音、`pixelTick` 命中触点与动态调制包络），避免直接原样照搬单条素材。

---

## 2. 第二步：读取视觉关键帧并编写 `sfx/<category>/<name>.js`

1. 查看 `fx/<category>/<name>.js`（或 `../src/fx/<category>/<name>.js`），提取：
   - `meta.duration` 总时长
   - `act.hits` 命中时刻（如 `t = 0.12s`）与视觉子阶段（前摇蓄聚、主爆发帧、多段连击或尾帧消散），确保起音与画面关键帧严丝合缝（绝不留前导死静音）。
2. 从只读桥接 `../../sfx-core/index.js` 导入所需原语：
```js
import {
  RATE,          // 22050 Hz 采样率
  sfxRng,        // const R = sfxRng(seed); R.noise(len), R.normal(), R.range(a,b), R.chance(p)
  refLayer,      // 仅当参考库启用 (active: true) 时使用: await refLayer(refId, begin, end, { low, high, semitones })
  refSample,     // 仅当参考库启用 (active: true) 时使用: await refSample(refId) -> 单声道 Float64Array 副本
  band,          // band(samples, lowHz, highHz) 零相位带通
  lowpass,       // lowpass(samples, cutoffHz) 零相位低通
  highpass,      // highpass(samples, cutoffHz) 零相位高通
  edgeFade,      // edgeFade(samples, attack=0.0007, release=0.025)
  fit,           // fit(samples, duration, release=0.04) 定长裁剪收尾
  splice,        // splice(samples, beginS, endS, overlap=0.012)
  place,         // place(destFloat64Array, fragment, offsetSeconds, gain=1.0) 毫秒级对位混音
  pitchShift,    // pitchShift(samples, semitones)
  normLayer,     // normLayer(samples, { low=null, high=null, release=0.025 }) 50ms 窗口 RMS 归一
  resonate,      // resonate(excitation, [[freq, q, gain], ...], decay) 多模态物理谐振器
  pixelTick,     // pixelTick(duration=0.022, frequency=440) 像素奇次谐波短触点
  compileEffectVariants,
} from "../../sfx-core/index.js";
```
3. 在脚本顶层调用 `await compileEffectVariants("<category>/<name>", variants)`，为当前特效构建 **3 个左右听感侧重鲜明的变种**（`samples` 直接传构造函数引用如 `samples: buildDefault`，系统会在启用参考库时自动记录每个变种引用的 `refSamples`）：
```js
await compileEffectVariants("category/name", {
  default: {
    label: "标准变种中文名 (默认)",
    desc: "简述声学层次与关键帧对位设计",
    samples: buildDefault,
    targetDb: -16.5,
    texture: 0.15,
    cues: [{ t: 0.12, kind: "hit" }],
  },
  heavy: { label: "...", desc: "...", samples: buildHeavy, targetDb: -16.0, texture: 0.2, cues: [{ t: 0.12, kind: "hit" }] },
  bright: { label: "...", desc: "...", samples: buildBright, targetDb: -16.8, texture: 0.12, cues: [{ t: 0.12, kind: "hit" }] },
});
```

---

## 3. 第三步：编译并实时同步至 Web UI
```bash
node .agents/skills/pixelfx-studio/scripts/studio.mjs build-sfx <category>/<name> --select default
```
编译完成后，Web UI 的「音效变种」下拉框与关键帧波形图将在 100ms 内自动热更新！
