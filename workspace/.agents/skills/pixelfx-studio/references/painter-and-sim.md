# PixelFX 核心绘制与物理模拟 API 速查

所有工具均可从 `"../../core/index.js"` 直接导入：

```js
import {
  // 色彩与调色板
  PAL, hex, rgb, mix, scale, fit, ramp, at, blend, WHITE, BLACK,
  // 数学、缓动与噪声（全部确定性可复现）
  Rng, rand, clamp, lerp, smooth, seg, ease, noise, noise2, fbm, loopNoise, tileNoise, tileFbm, TAU,
  // 纯函数粒子辅助
  burst, cycle, fly,
  // 模拟型粒子、碎片、动态光源与地面火点
  Particles, Bits, Lights, Blazes, P, PF, B, GRAVITY, FIRE_RAMP, SMOKE_RAMP,
  // 高频像素特效图元
  sparkle, flare, band, crystal,
  // 角色动作编排
  READY, STAND, chain, shiftKeys, shiftHits,
} from "../../core/index.js";
```

## 1. 坐标系与色阶铁律
- 原点 `(0, 0)` 是锚点（角色脚底 / 命中中心 / 枪口），`x` 向右为正，`y` 向下为正（向天空喷发时 `y` 为负值，地面水平线为 `y = 0`）。
- 调色板自适应：始终使用 `const C = fit(o.palette, 8)`（`C[0]` 最暗阴影 -> `C[7]` 最亮高光），确保外部传入任意长度调色板都能正常工作。
- 像素质感原则：`color` 层使用明确色阶（`C[2]..C[6]`、`WHITE`），避免模糊渐变；发光柔化统一交给 `p.glow()` / `Lights` 写入 `light` 缓冲。

## 2. Painter `p` 绘制方法
| 方法 | 说明 |
|---|---|
| `p.px(x, y, c)` | 绘制 1×1 不透明像素 |
| `p.dot(x, y, c, a)` | 4×4 Bayer 有序抖动半透明像素 (`a` 0..1) |
| `p.blend(x, y, c, a)` | 真 Alpha 半透明混合像素 |
| `p.disc(x, y, r, c, a)` | 柔和半透明圆盘（适合烟雾、水汽、毒雾） |
| `p.line(x0, y0, x1, y1, c, a)` | 1px 像素直线，`c` 可传函数 `(u) => color` |
| `p.beam(x0, y0, x1, y1, w, c, a)` | 粗胶囊能量束 |
| `p.circle(x, y, r, c, a)` / `p.ring(x, y, r, thick, c, a)` | 实心圆 / 圆环 |
| `p.ellipse(x, y, rx, ry, c, a)` | 椭圆（透视地面环常用 `ry = rx * 0.24`），`c` 可为 `(d, angle) => color` |
| `p.rect(x, y, w, h, c, a)` / `p.poly(pts, c, a)` | 矩形 / 多边形 |
| `p.shade(x0, y0, x1, y1, (x, y, out) => { out.c = ...; out.a = 1; })` | 逐像素程序化着色器（火焰柱、水柱、刀光拖尾核心利器） |
| `p.glow(x, y, r, c, k)` | 加法发光圆（`k` 建议 `0.15..0.5`，切勿过曝发白） |
| `p.glowLine(x0, y0, x1, y1, r, c, k)` | 沿线段发光 |

## 3. 模拟型粒子 `Particles` & `Lights` & `Bits`
```js
const R = new Rng(o.seed);
const ps = new Particles({ rng: R, ground: () => 0 });
// 粒子类型 P.*: SPARK(弹跳火花), STAR(十字星芒), FLAKE(飘落雪片/微粒), SMOKE(体积烟团),
// FIRE(上升冷却火团, 可加 PF.SMOKES), VAPOUR(薄雾), DUST(尘团), EMBER(余烬), STREAK(聚能流线), GRIT(落石碎粒)
ps.spawn(P.SPARK, x, y, vx, vy, life, color, size, delay, flags);

const lights = new Lights();
lights.add(x, y, radius, color, strength, life);
```

## 4. 内置 27 套 `PAL` 名称
`fire`, `ember`, `lava`, `smoke`, `dust`, `ice`, `water`, `electric`, `volt`, `poison`, `holy`, `heal`, `arcane`, `shadow`, `blood`, `earth`, `stone`, `gold`, `leaf`, `wood`, `metal`, `bone`, `neon`, `cyber`, `matrix`, `candy`, `night`。
