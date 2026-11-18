// PixelFX 像素特效工作台与 Agent 创作工作区前端核心：双空间管理、SSE 毫秒级热重载、在线代码热编辑与 AI 协同

import { effects as LIB_MODULES, categories } from "../src/fx/index.js";
import {
  createFrame,
  clearFrame,
  createFx,
  createAct,
  actBounds,
  actTiming,
  composite,
  drawActor,
  painterFor,
  stockActor,
  actorAlphaOf,
  PAL,
  toHex,
} from "../src/core/index.js";
import {
  ZH_CATEGORIES,
  ZH_PALETTES,
  ZH_BACKDROPS,
  ZH_OPTION_KEYS,
  ZH_FX,
} from "./zh-data.js";
import {
  buildBackdropBuffer,
  resampleNearestRGBA,
  buildSpriteSheet,
  buildContactSheetCanvas,
  canvasToPngBytes,
  buildZipBlob,
  buildGifBlob,
  downloadBlob,
} from "./export-utils.js";

const STORAGE_CUSTOM_KEY = "pixelfx_custom_meta_v1";
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

function el(tag, props = {}, kids = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) if (k != null) node.append(k);
  return node;
}

const isHexStr = (v) => typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v);
const isColorRamp = (v) =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((c) => (typeof c === "number" && c > 0xffff) || isHexStr(c));

function normHex(c) {
  if (typeof c === "number") return toHex(c);
  if (!isHexStr(c)) return "#ffffff";
  let s = c.slice(1);
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  return "#" + s.slice(0, 6).toLowerCase();
}

const isScreenFx = (meta) =>
  meta.size[0] >= 320 && Math.abs(meta.size[0] / meta.size[1] - 16 / 9) < 0.05;

// ---- 内置特效库与自定义中文元数据 ----
let customMeta = {};
try {
  customMeta = JSON.parse(localStorage.getItem(STORAGE_CUSTOM_KEY) || "{}");
} catch {
  customMeta = {};
}

const LIB_LIST = Object.entries(LIB_MODULES).map(([id, mod]) => {
  const meta = {
    fps: 30,
    bg: "dark",
    loop: false,
    duration: 1,
    tags: [],
    options: {},
    ...mod.meta,
  };
  return { id, space: "library", cat: id.split("/")[0], mod: { ...mod, meta }, meta };
});

// 动态加载的工作区特效列表
let WS_LIST = [];

function getDisplayName(fx) {
  if (!fx) return "";
  if (fx.space === "workspace") {
    return fx.zhName || fx.meta?.name || fx.id.split("/")[1];
  }
  return customMeta[fx.id]?.name || ZH_FX[fx.id]?.[0] || fx.meta.name;
}

function getDisplayDesc(fx) {
  if (!fx) return "";
  if (fx.space === "workspace") {
    return fx.zhDesc || fx.meta?.desc || "";
  }
  return customMeta[fx.id]?.desc || ZH_FX[fx.id]?.[1] || fx.meta.desc || "";
}

function getCatName(catId) {
  return ZH_CATEGORIES[catId]?.name || catId;
}

let toastTimer = null;
function showToast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 2400);
}

// ---- 全局应用状态 ----
const appState = {
  space: "workspace", // "workspace" | "library"
  cat: "all",
  q: "",
  filtered: [],
  currentFx: null,
  activeView: "live", // "live" | "sheet" | "code"
  codeMode: "source", // "source" | "sfx" | "usage" | "json"
  playing: true,
  previewSpeed: 1,
  sheetZoom: "fit",
  sheetGrid: true,
  sheetActor: false,
  lastSheetResult: null,
  sourceCache: new Map(),
  agentOpen: true,
  agentMode: "ext", // "ext" | "api"
  autoFollowAgent: true,
  codeDirty: false,

  cfg: {
    bg: "topstone",
    paletteKey: "",
    palette: null,
    seed: 57,
    fps: 12,
    duration: 10 / 12,
    canvasW: 128,
    canvasH: 160,
    lockAspect: true,
    scaleWithCanvas: true,
    flip: false,
    actorMode: "hide",
    extraOpts: {},
  },
};

function activePool() {
  return appState.space === "workspace" ? WS_LIST : LIB_LIST;
}

// ---- 动态加载并构建工作区特效模块 ----
async function loadWorkspaceEffectsFromServer() {
  try {
    const res = await fetch("/api/workspace/list", { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    const items = data.effects || [];
    const built = [];

    for (const item of items) {
      if (item.broken) {
        built.push({
          ...item,
          space: "workspace",
          mod: {
            meta: item.meta,
            draw() {},
          },
        });
        continue;
      }
      try {
        const modUrl = `/workspace/fx/${item.id}.js?v=${item.mtimeMs}_${Date.now()}`;
        const mod = await import(modUrl);
        const meta = {
          fps: 30,
          bg: "dark",
          loop: false,
          duration: 1,
          tags: [],
          size: [128, 128],
          origin: [64, 96],
          options: {},
          ...mod.meta,
        };
        built.push({
          ...item,
          space: "workspace",
          mod: { ...mod, meta },
          meta,
        });
      } catch (err) {
        built.push({
          ...item,
          space: "workspace",
          broken: true,
          error: String(err.message || err),
          mod: { meta: item.meta, draw() {} },
        });
      }
    }

    WS_LIST = built;
    $("#ws-count").textContent = WS_LIST.length;
    $("#lib-total-count").textContent = LIB_LIST.length;
    return WS_LIST;
  } catch {
    $("#ws-count").textContent = "0";
    return [];
  }
}

// ---- 将当前焦点实时写入 active-context.json 供外部 IDE Agent 读取 ----
let ctxSyncTimer = null;
function scheduleActiveContextSync() {
  clearTimeout(ctxSyncTimer);
  ctxSyncTimer = setTimeout(async () => {
    const fx = appState.currentFx;
    if (!fx) return;
    $("#agent-focus-label").textContent =
      `TARGET: [${fx.space === "workspace" ? "WS" : "LIB"}] ${fx.id}`;
    try {
      await fetch("/api/workspace/active-context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          space: fx.space,
          activeView: appState.activeView,
          theme: document.documentElement.dataset.theme || "amber",
          id: fx.id,
          zhName: getDisplayName(fx),
          zhDesc: getDisplayDesc(fx),
          file: fx.space === "workspace" ? `fx/${fx.id}.js` : `../src/fx/${fx.id}.js`,
          sfxScript: sfxState.hasScript ? `sfx/${fx.id}.js` : null,
          activeSfxVariant: sfxState.activeVariant,
          sfxVariants: sfxState.variants.map((v) => ({ id: v.id, label: v.label })),
          sfxRefs: {
            enabled: sfxRefsState.enabled,
            active: sfxRefsState.active,
            activeLibraryCount: sfxRefsState.activeLibraryCount,
            activeSoundCount: sfxRefsState.activeSoundCount,
          },
          cfg: appState.cfg,
        }),
      });
    } catch {}
  }, 220);
}

// ---- 实时帧级舞台播放器 ----
class StageRunner {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.fx = null;
    this.W = 360;
    this.H = 220;
    this.frameIdx = 0;
    this.totalFrames = 1;
    this.acc = 0;
    this.wait = 0;
    this.inst = null;
    this.acted = false;
    this.bgBuf = null;
    this.frame = null;
    this.img = null;
    this.fxFrame = null;
    this.fxRgba = null;
  }

  setup(fx, resetClock = true) {
    this.fx = fx;
    const errOverlay = $("#stage-error");
    if (!fx) return;

    if (fx.broken) {
      errOverlay.textContent = `⚠ 特效模块加载错误 (${fx.id}):\n${fx.error}`;
      errOverlay.hidden = false;
    } else {
      errOverlay.hidden = true;
    }

    const m = fx.meta;
    const cfg = appState.cfg;
    const screen = isScreenFx(m);

    const rect = $("#stage-viewport").getBoundingClientRect();
    const viewAspect = rect.width > 40 && rect.height > 40 ? rect.width / rect.height : 16 / 10;
    const aspect = screen ? 16 / 9 : Math.max(1.2, Math.min(2.2, viewAspect));

    this.acted = !!fx.mod.act && cfg.actorMode !== "hide";
    const b = this.acted ? { ...actBounds(fx.mod) } : null;
    if (b) b.y1 = Math.min(b.y1, 22);

    const [origW, origH] = m.size;
    const effW = cfg.scaleWithCanvas ? cfg.canvasW : origW;
    const effH = cfg.scaleWithCanvas ? cfg.canvasH : origH;
    const [baseW, baseH] = this.acted ? [b.x1 - b.x0, b.y1 - b.y0] : [effW, effH];
    const pad = screen ? 1.0 : this.acted ? 1.28 : 1.55;

    this.W = Math.max(220, Math.ceil(Math.max(baseW * pad, baseH * pad * aspect)));
    this.H = Math.max(140, Math.ceil(this.W / aspect));
    if (screen) {
      this.W = origW;
      this.H = origH;
    }

    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.frame = createFrame(this.W, this.H);
    this.img = this.ctx.createImageData(this.W, this.H);

    const [ox, oy] = this.acted ? [-b.x0, -b.y0] : m.origin;
    if (this.acted) {
      this.x = Math.floor((this.W - baseW) / 2) + ox;
      this.y = Math.max(oy + 4, Math.floor(this.H * 0.78));
    } else if (screen) {
      this.x = ox;
      this.y = oy;
    } else {
      const scaledOX = cfg.scaleWithCanvas ? Math.round((ox * cfg.canvasW) / origW) : ox;
      const scaledOY = cfg.scaleWithCanvas ? Math.round((oy * cfg.canvasH) / origH) : oy;
      this.x = Math.floor((this.W - effW) / 2) + scaledOX;
      this.y = Math.floor((this.H - effH) / 2) + scaledOY;
    }

    this.bgBuf = buildBackdropBuffer(cfg.bg, this.W, this.H, this.y);
    this.totalFrames = Math.max(1, Math.round(cfg.duration * cfg.fps) + (m.loop ? 0 : 1));

    this.updateBoundsOverlay(rect);
    if (resetClock) {
      this.restart();
    } else {
      this.seekFrame(Math.min(this.frameIdx, this.totalFrames - 1));
    }
  }

  updateBoundsOverlay(viewportRect) {
    const hint = $("#bounds-hint");
    if (!this.fx) return;
    const cfg = appState.cfg;
    const [origW, origH] = this.fx.meta.size;
    const changed = cfg.canvasW !== origW || cfg.canvasH !== origH;
    if (!changed || cfg.scaleWithCanvas || this.acted || isScreenFx(this.fx.meta)) {
      hint.hidden = true;
      return;
    }
    const scaleCss = Math.min(viewportRect.width / this.W, viewportRect.height / this.H);
    const dispW = this.W * scaleCss;
    const dispH = this.H * scaleCss;
    const left0 = (viewportRect.width - dispW) / 2;
    const top0 = (viewportRect.height - dispH) / 2;
    const [origOX, origOY] = this.fx.meta.origin;
    const boxX = this.x - Math.round(origOX + (cfg.canvasW - origW) / 2);
    const boxY = this.y - Math.round(origOY + (cfg.canvasH - origH) / 2);

    hint.style.left = `${left0 + boxX * scaleCss}px`;
    hint.style.top = `${top0 + boxY * scaleCss}px`;
    hint.style.width = `${cfg.canvasW * scaleCss}px`;
    hint.style.height = `${cfg.canvasH * scaleCss}px`;
    hint.hidden = false;
  }

  makeInstance(localX, localY) {
    const cfg = appState.cfg;
    const opts = {
      ...cfg.extraOpts,
      ...(cfg.palette ? { palette: cfg.palette } : {}),
      seed: cfg.seed,
      x: localX,
      y: localY,
      flip: !!cfg.flip,
    };
    return (this.acted ? createAct : createFx)(this.fx.mod, opts);
  }

  simStepDt() {
    const m = this.fx.meta;
    const cfg = appState.cfg;
    if (this.acted) {
      const poses = this.fx.mod.act?.poses ?? [[0]];
      const from = Math.min(0, poses[0]?.[0] ?? 0);
      const to = m.loop ? m.duration : Math.max(m.duration, poses[poses.length - 1]?.[0] ?? m.duration);
      const span = Math.max(0.05, to - from);
      return this.totalFrames > 1 ? span / (m.loop ? this.totalFrames : this.totalFrames - 1) : 1 / cfg.fps;
    }
    return (1 / cfg.fps) * (m.duration / Math.max(0.05, cfg.duration));
  }

  restart() {
    if (!this.fx) return;
    try {
      const cfg = appState.cfg;
      const [origW, origH] = this.fx.meta.size;
      const needScale = !this.acted && cfg.scaleWithCanvas && (cfg.canvasW !== origW || cfg.canvasH !== origH);

      if (needScale) {
        this.fxFrame = createFrame(origW, origH);
        this.fxRgba = new Uint8ClampedArray(origW * origH * 4);
        this.inst = this.makeInstance(this.fx.meta.origin[0], this.fx.meta.origin[1]);
      } else {
        this.fxFrame = null;
        this.inst = this.makeInstance(this.x, this.y);
      }

      this.frameIdx = 0;
      this.acc = 0;
      this.wait = 0;
      this.renderCurrent();
      updateTimelineUI();
      if (sfxState.syncEnabled && appState.playing && appState.activeView === "live") {
        triggerSyncedAudio();
      }
    } catch (e) {
      $("#stage-error").textContent = `⚠ 渲染异常: ${String(e.message || e)}`;
      $("#stage-error").hidden = false;
    }
  }

  seekFrame(targetIdx) {
    if (!this.fx) return;
    targetIdx = Math.max(0, Math.min(this.totalFrames - 1, Math.round(targetIdx)));
    try {
      const cfg = appState.cfg;
      const [origW, origH] = this.fx.meta.size;
      const needScale = !this.acted && cfg.scaleWithCanvas && (cfg.canvasW !== origW || cfg.canvasH !== origH);

      if (needScale) {
        this.fxFrame = createFrame(origW, origH);
        this.fxRgba = new Uint8ClampedArray(origW * origH * 4);
        this.inst = this.makeInstance(this.fx.meta.origin[0], this.fx.meta.origin[1]);
      } else {
        this.fxFrame = null;
        this.inst = this.makeInstance(this.x, this.y);
      }

      const dtSim = this.simStepDt();
      for (let i = 0; i < targetIdx; i++) {
        this.inst.update(dtSim);
      }
      this.frameIdx = targetIdx;
      this.acc = 0;
      this.wait = 0;
      this.renderCurrent();
      updateTimelineUI();
    } catch (e) {
      $("#stage-error").textContent = `⚠ 渲染异常: ${String(e.message || e)}`;
      $("#stage-error").hidden = false;
    }
  }

  tick(dt) {
    if (!this.fx || !this.inst || !appState.playing || this.fx.broken) return;
    const cfg = appState.cfg;
    const frameInterval = 1 / Math.max(1, cfg.fps);
    this.acc = Math.min(this.acc + dt * appState.previewSpeed, 0.25);

    let advanced = false;
    const dtSim = this.simStepDt();
    try {
      while (this.acc >= frameInterval) {
        this.acc -= frameInterval;
        if (this.frameIdx >= this.totalFrames - 1) {
          if (this.fx.meta.loop) {
            this.restart();
            return;
          }
          this.wait += frameInterval;
          if (this.wait >= 0.42) {
            this.restart();
            return;
          }
        } else {
          this.inst.update(dtSim);
          this.frameIdx++;
          advanced = true;
        }
      }
      if (advanced) {
        this.renderCurrent();
        updateTimelineUI();
      }
    } catch (e) {
      appState.playing = false;
      $("#stage-error").textContent = `⚠ 运行时错误: ${String(e.message || e)}`;
      $("#stage-error").hidden = false;
    }
  }

  renderCurrent() {
    const f = clearFrame(this.frame);
    const cfg = appState.cfg;
    const m = this.fx.meta;

    if (this.acted) {
      this.inst.draw(f, {
        body: cfg.actorMode === "full" || cfg.actorMode === "body",
        target: cfg.actorMode === "full" || cfg.actorMode === "target",
      });
      composite(f, this.img.data, this.bgBuf);
      const [sx, sy] = this.inst.shake;
      if (sx || sy) {
        this.ctx.fillStyle = "#161422";
        this.ctx.fillRect(0, 0, this.W, this.H);
      }
      this.ctx.putImageData(this.img, sx, sy);
      return;
    }

    if (this.fxFrame) {
      const [origW, origH] = m.size;
      clearFrame(this.fxFrame);
      const showStand = m.actor && cfg.actorMode !== "hide";
      if (showStand) {
        this.inst.draw(this.fxFrame, "back");
        const tt = m.loop ? this.inst.t % m.duration : Math.min(this.inst.t, m.duration);
        drawActor(
          painterFor(this.fxFrame).place(m.origin[0], m.origin[1], !!cfg.flip),
          this.inst.options.actor ?? stockActor(),
          actorAlphaOf(this.fx.mod, tt, this.inst.options),
        );
        this.inst.draw(this.fxFrame, "front");
      } else {
        this.inst.draw(this.fxFrame);
      }
      composite(this.fxFrame, this.fxRgba, null);
      const scaled = resampleNearestRGBA(this.fxRgba, origW, origH, cfg.canvasW, cfg.canvasH);

      composite(f, this.img.data, this.bgBuf);
      const dst = this.img.data;
      const ox = Math.floor((this.W - cfg.canvasW) / 2);
      const oy = Math.floor((this.H - cfg.canvasH) / 2);
      for (let y = 0; y < cfg.canvasH; y++) {
        const ty = oy + y;
        if (ty < 0 || ty >= this.H) continue;
        for (let x = 0; x < cfg.canvasW; x++) {
          const tx = ox + x;
          if (tx < 0 || tx >= this.W) continue;
          const si = (y * cfg.canvasW + x) * 4;
          const a = scaled[si + 3] / 255;
          if (a <= 0) continue;
          const di = (ty * this.W + tx) * 4;
          dst[di] = Math.min(255, scaled[si] * a + dst[di] * (1 - a));
          dst[di + 1] = Math.min(255, scaled[si + 1] * a + dst[di + 1] * (1 - a));
          dst[di + 2] = Math.min(255, scaled[si + 2] * a + dst[di + 2] * (1 - a));
          dst[di + 3] = 255;
        }
      }
      this.ctx.putImageData(this.img, 0, 0);
      return;
    }

    const showStand = m.actor && cfg.actorMode !== "hide";
    this.inst.draw(f, "back");
    if (showStand) {
      const tt = m.loop ? this.inst.t % m.duration : Math.min(this.inst.t, m.duration);
      drawActor(
        painterFor(f).place(this.x, this.y, !!cfg.flip),
        this.inst.options.actor ?? stockActor(),
        actorAlphaOf(this.fx.mod, tt, this.inst.options),
      );
    }
    this.inst.draw(f, "front");
    composite(f, this.img.data, this.bgBuf);
    this.ctx.putImageData(this.img, 0, 0);
  }
}

const stage = new StageRunner($("#stage-canvas"));

// ---- 抽取默认代表色阶 ----
function extractDefaultRamp(fx) {
  const opts = fx.meta.options || {};
  if (isColorRamp(opts.palette)) return opts.palette.map(normHex);
  for (const v of Object.values(opts)) {
    if (isColorRamp(v)) return v.map(normHex);
  }
  if (fx.broken) return PAL.water;
  try {
    const [w, h] = fx.meta.size;
    const f = createFrame(w, h);
    const inst = createFx(fx.mod, { x: fx.meta.origin[0], y: fx.meta.origin[1] });
    for (let i = 0; i < 5; i++) inst.update((fx.meta.duration * 0.45) / 5);
    inst.draw(f);
    const out = new Uint8ClampedArray(w * h * 4);
    composite(f, out, null);
    const buckets = new Map();
    for (let i = 0; i < w * h; i++) {
      if (out[i * 4 + 3] < 120) continue;
      const r = out[i * 4] & 0xf0;
      const g = out[i * 4 + 1] & 0xf0;
      const b = out[i * 4 + 2] & 0xf0;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const hx = "#" + [r, g, b].map((n) => Math.min(255, n + 8).toString(16).padStart(2, "0")).join("");
      if (!buckets.has(hx)) buckets.set(hx, lum);
    }
    const sorted = [...buckets.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
    if (sorted.length >= 5) {
      return Array.from({ length: 6 }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / 5)]);
    }
  } catch {}
  return PAL.water;
}

// ---- 空间切换（工作区 <-> 内置特效库） ----
function switchSpace(space, targetId = null) {
  appState.space = space;
  $("#space-ws").classList.toggle("active", space === "workspace");
  $("#space-lib").classList.toggle("active", space === "library");
  $("#ws-actions").hidden = space !== "workspace";
  $("#lib-actions").hidden = space !== "library";

  appState.cat = "all";
  rebuildCategorySelect();
  applyFilter();

  const pool = activePool();
  const chosen =
    (targetId && pool.find((x) => x.id === targetId)) ||
    appState.filtered[0] ||
    pool[0] ||
    null;

  if (chosen) {
    selectEffect(chosen);
  } else if (space === "workspace") {
    // 工作区为空时引导新建或从内置库克隆
    $("#fx-name").textContent = "工作区暂无特效";
    $("#fx-id").textContent = "点击右上角「+ 新建特效」或从「内置特效库」克隆";
  }
}

function rebuildCategorySelect() {
  const sel = $("#sel-category");
  const pool = activePool();
  sel.replaceChildren(
    el("option", { value: "all", textContent: `全部分类 (${pool.length})` }),
    ...categories
      .map((c) => {
        const n = pool.filter((x) => x.cat === c.id).length;
        if (appState.space === "workspace" && n === 0) return null;
        return el("option", { value: c.id, textContent: `${getCatName(c.id)} (${n})` });
      })
      .filter(Boolean),
  );
  sel.value = appState.cat;
}

// ---- 选中并载入特效 ----
function buildDefaultCfgForFx(fx) {
  const m = fx.meta;
  const screen = isScreenFx(m);
  const base = {
    bg: screen ? m.bg : m.bg === "sky" ? "sky" : "topstone",
    paletteKey: "",
    palette: null,
    seed: m.options?.seed ?? 1,
    fps: m.fps,
    duration: m.duration,
    canvasW: m.size[0],
    canvasH: m.size[1],
    lockAspect: true,
    scaleWithCanvas: true,
    flip: false,
    actorMode: fx.mod.act || m.actor ? "full" : "hide",
    extraOpts: {},
  };

  if (fx.space === "workspace" && fx.preset) {
    const p = fx.preset;
    return {
      ...base,
      ...p,
      paletteKey: p.paletteKey ?? (p.palette ? "__custom" : ""),
      palette: p.palette ? [...p.palette] : null,
      extraOpts: { ...(p.extraOpts || {}) },
    };
  }
  return base;
}

function selectEffect(fx, { updateHash = true, preserveTime = false } = {}) {
  if (!fx) return;
  stopActiveAudio();
  appState.currentFx = fx;
  appState.codeDirty = false;
  appState.cfg = buildDefaultCfgForFx(fx);

  if (updateHash) {
    history.replaceState(null, "", `#${fx.space}:${fx.id}`);
  }

  syncInspectorDOM();
  buildExtraParamsDOM();
  stage.setup(fx, !preserveTime);
  highlightCarouselActive();
  loadSfxInfoForFx(fx);
  scheduleActiveContextSync();

  if (appState.activeView === "sheet") refreshSheetView();
  if (appState.activeView === "code") refreshCodeView();
}

function refreshTextLabels() {
  const fx = appState.currentFx;
  if (!fx) return;
  $("#fx-name").textContent = getDisplayName(fx);
  $("#fx-cat-badge").textContent = getCatName(fx.cat);
  const spaceTag = $("#fx-space-tag");
  spaceTag.textContent = fx.space === "workspace" ? "RW · 工作区" : "RO · 内置库";
  spaceTag.classList.toggle("readonly", fx.space !== "workspace");

  $("#fx-id").textContent = fx.id;
  $("#insp-desc").textContent = getDisplayDesc(fx);
  document.title = `${getDisplayName(fx)} (${fx.id}) - PixelFX 工作台`;

  $$(".thumb-card", $("#carousel-strip")).forEach((card) => {
    const item = activePool().find((x) => x.id === card.dataset.id);
    if (item) $(".thumb-title", card).textContent = getDisplayName(item);
  });
}

function syncInspectorDOM() {
  const fx = appState.currentFx;
  const m = fx.meta;
  const cfg = appState.cfg;

  refreshTextLabels();

  const origFrames = Math.max(1, Math.round(m.duration * m.fps) + (m.loop ? 0 : 1));
  $("#meta-row-1").textContent =
    `原始: ${m.size[0]}×${m.size[1]} · ${origFrames} 帧 · ${m.fps.toFixed(1)} fps`;
  $("#meta-row-2").textContent =
    `${+m.duration.toFixed(2)} 秒 · ${m.loop ? "循环播放" : "一次性"} · 原点 (${m.origin[0]}, ${m.origin[1]})`;

  if (fx.mod.act) {
    const timing = actTiming(fx.mod);
    $("#meta-row-3").textContent =
      `蓄力 ${timing.windup.toFixed(2)}s · 收招 ${timing.recovery.toFixed(2)}s · ${timing.hits.length} 次命中`;
  } else {
    $("#meta-row-3").textContent = `蓄力 0.00s · 收招 0.00s · ${m.loop ? "持续特效" : "1 次命中"}`;
  }

  $("#sel-bg").value = cfg.bg;
  $("#sel-pal").value = cfg.paletteKey;
  renderSwatchBar();

  $("#inp-seed").value = cfg.seed;
  $("#inp-fps").value = cfg.fps;
  $("#inp-duration").value = +Number(cfg.duration).toFixed(2);
  updateDurationScaleLabel();

  $("#inp-w").value = cfg.canvasW;
  $("#inp-h").value = cfg.canvasH;

  $("#tog-aspect").setAttribute("aria-pressed", String(cfg.lockAspect));
  $("#tog-scale-canvas").setAttribute("aria-pressed", String(cfg.scaleWithCanvas));
  $("#tog-flip").setAttribute("aria-pressed", String(cfg.flip));

  const hasAct = !!fx.mod.act;
  const hasActor = !!m.actor || hasAct;
  const selActor = $("#sel-actor");
  selActor.disabled = !hasActor;
  selActor.querySelector('option[value="body"]').hidden = !hasAct;
  selActor.querySelector('option[value="target"]').hidden = !hasAct;
  selActor.value = hasActor ? cfg.actorMode : "hide";
}

function updateDurationScaleLabel() {
  const fx = appState.currentFx;
  if (!fx) return;
  const ratio = appState.cfg.duration / Math.max(0.01, fx.meta.duration);
  $("#dur-scale").textContent = `${ratio.toFixed(2)}×`;
}

function renderSwatchBar() {
  const fx = appState.currentFx;
  const bar = $("#swatch-bar");
  const colors = (appState.cfg.palette || extractDefaultRamp(fx)).map(normHex);

  bar.replaceChildren(
    ...colors.map((hexColor, idx) => {
      const picker = el("input", { type: "color", value: hexColor, ariaLabel: `色阶 ${idx + 1}` });
      const chip = el("label", { className: "swatch-chip", title: `${hexColor}（点击微调颜色）` }, [picker]);
      chip.style.background = hexColor;

      picker.addEventListener("input", () => {
        const next = [...colors];
        next[idx] = picker.value;
        appState.cfg.palette = next;
        appState.cfg.paletteKey = "__custom";
        $("#sel-pal").value = "__custom";
        chip.style.background = picker.value;
        applyInspectorChange(false);
      });
      return chip;
    }),
  );
}

// ---- 动态专用参数面板 ----
function buildExtraParamsDOM() {
  const fx = appState.currentFx;
  const body = $("#extra-body");
  const dot = $("#extra-indicator");
  const rawOpts = fx.meta.options || {};
  const entries = Object.entries(rawOpts).filter(([k]) => k !== "palette" && k !== "seed");

  dot.classList.toggle("on", entries.length > 0);
  if (!entries.length) {
    body.replaceChildren(
      el("div", { className: "extra-empty", textContent: "当前特效仅使用调色板与随机种子，无额外专用参数。" }),
    );
    return;
  }

  const nodes = entries.map(([key, defVal]) => {
    const labelZh = ZH_OPTION_KEYS[key] || key;
    const head = el("div", { className: "extra-item-head" }, [
      el("span", { textContent: labelZh }),
      el("span", { className: "extra-item-key", textContent: key }),
    ]);

    if (typeof defVal === "number") {
      const isInt = Number.isInteger(defVal) && Math.abs(defVal) >= 2;
      const step = isInt ? 1 : Math.abs(defVal) < 1 ? 0.02 : 0.1;
      const min = defVal < 0 ? Math.floor(defVal * 2) : 0;
      const max = Math.max(isInt ? 12 : 2, Math.ceil(Math.abs(defVal) * 3) || 10);
      const cur = appState.cfg.extraOpts[key] ?? defVal;

      const slider = el("input", { type: "range", min, max, step, value: cur });
      const numInp = el("input", { type: "number", className: "ctrl-input", step, value: cur });
      const syncNum = (v) => {
        const parsed = +v;
        if (!Number.isFinite(parsed)) return;
        slider.value = parsed;
        numInp.value = parsed;
        appState.cfg.extraOpts[key] = parsed;
        applyInspectorChange(false);
      };
      slider.addEventListener("input", () => syncNum(slider.value));
      numInp.addEventListener("change", () => syncNum(numInp.value));

      return el("div", { className: "extra-item" }, [
        head,
        el("div", { className: "extra-num-row" }, [slider, numInp]),
      ]);
    }

    if (typeof defVal === "boolean") {
      const cur = appState.cfg.extraOpts[key] ?? defVal;
      const btn = el(
        "button",
        { type: "button", className: "dot-btn" },
        [el("span", { textContent: cur ? "已开启" : "已关闭" }), el("i", { className: "status-dot" })],
      );
      btn.setAttribute("aria-pressed", String(cur));
      btn.addEventListener("click", () => {
        const next = !(appState.cfg.extraOpts[key] ?? defVal);
        appState.cfg.extraOpts[key] = next;
        btn.setAttribute("aria-pressed", String(next));
        btn.firstChild.textContent = next ? "已开启" : "已关闭";
        applyInspectorChange(false);
      });
      return el("div", { className: "extra-item" }, [head, btn]);
    }

    if (isHexStr(defVal)) {
      const cur = normHex(appState.cfg.extraOpts[key] ?? defVal);
      const picker = el("input", { type: "color", value: cur });
      const chip = el("label", { className: "swatch-chip" }, [picker]);
      chip.style.background = cur;
      picker.addEventListener("input", () => {
        appState.cfg.extraOpts[key] = picker.value;
        chip.style.background = picker.value;
        applyInspectorChange(false);
      });
      return el("div", { className: "extra-item" }, [head, el("div", { className: "swatch-bar" }, [chip])]);
    }

    if (typeof defVal === "string") {
      const inp = el("input", {
        type: "text",
        className: "ctrl-input",
        value: appState.cfg.extraOpts[key] ?? defVal,
      });
      inp.addEventListener("input", () => {
        appState.cfg.extraOpts[key] = inp.value || defVal;
        applyInspectorChange(false);
      });
      return el("div", { className: "extra-item" }, [head, inp]);
    }

    if (Array.isArray(defVal) && defVal.length === 2 && defVal.every((n) => typeof n === "number" && Math.abs(n) <= 1000)) {
      const cur = appState.cfg.extraOpts[key] ?? [...defVal];
      const ix = el("input", { type: "number", className: "ctrl-input num-dim", value: cur[0] });
      const iy = el("input", { type: "number", className: "ctrl-input num-dim", value: cur[1] });
      const onCoord = () => {
        appState.cfg.extraOpts[key] = [+ix.value || 0, +iy.value || 0];
        applyInspectorChange(false);
      };
      ix.addEventListener("change", onCoord);
      iy.addEventListener("change", onCoord);
      return el("div", { className: "extra-item" }, [
        head,
        el("div", { className: "form-row compact-row" }, [
          el("span", { className: "unit-text", textContent: "X" }),
          ix,
          el("span", { className: "unit-text", textContent: "Y" }),
          iy,
        ]),
      ]);
    }

    if (isColorRamp(defVal)) {
      const colors = (appState.cfg.extraOpts[key] ?? defVal).map(normHex);
      const chips = colors.map((hx, idx) => {
        const pk = el("input", { type: "color", value: hx });
        const ch = el("label", { className: "swatch-chip", title: hx }, [pk]);
        ch.style.background = hx;
        pk.addEventListener("input", () => {
          const curArr = [...(appState.cfg.extraOpts[key] ?? defVal).map(normHex)];
          curArr[idx] = pk.value;
          appState.cfg.extraOpts[key] = curArr;
          ch.style.background = pk.value;
          applyInspectorChange(false);
        });
        return ch;
      });
      return el("div", { className: "extra-item" }, [head, el("div", { className: "swatch-bar" }, chips)]);
    }
    return null;
  });

  body.replaceChildren(...nodes.filter(Boolean));
}

function applyInspectorChange(resetClock = false) {
  stage.setup(appState.currentFx, resetClock);
  scheduleActiveContextSync();
  if (appState.activeView === "sheet") refreshSheetView();
  if (appState.activeView === "code" && appState.codeMode !== "source") refreshCodeView();
}

function updateTimelineUI() {
  const slider = $("#scrub-range");
  const maxIdx = Math.max(0, stage.totalFrames - 1);
  slider.max = maxIdx;
  slider.value = stage.frameIdx;
  const pct = maxIdx > 0 ? (stage.frameIdx / maxIdx) * 100 : 100;
  slider.style.setProperty("--prog", `${pct.toFixed(1)}%`);

  const fpsTxt = Number.isInteger(appState.cfg.fps) ? appState.cfg.fps : appState.cfg.fps.toFixed(1);
  $("#frame-counter").textContent = `第 ${stage.frameIdx + 1} / ${stage.totalFrames} 帧 · ${fpsTxt} fps`;
  drawSfxWaveform(maxIdx > 0 ? stage.frameIdx / maxIdx : 0);
}

// ---- 视图 2：透明图集 ----
function refreshSheetView() {
  const fx = appState.currentFx;
  if (!fx || fx.broken) return;
  const cfg = { ...appState.cfg, displayName: getDisplayName(fx) };
  const res = buildSpriteSheet(fx, cfg, { exportActor: appState.sheetActor });
  appState.lastSheetResult = res;

  $("#sheet-summary").textContent =
    `共 ${res.n} 帧 · 单帧 ${res.w}×${res.h} px · ${res.cols} 列 × ${res.rows} 行 · 图集 ${res.canvas.width}×${res.canvas.height} px`;

  const outCv = $("#sheet-canvas");
  outCv.width = res.canvas.width;
  outCv.height = res.canvas.height;
  const ctx = outCv.getContext("2d");
  ctx.clearRect(0, 0, outCv.width, outCv.height);
  ctx.drawImage(res.canvas, 0, 0);

  if (appState.sheetGrid) {
    ctx.strokeStyle = "rgba(165, 119, 235, 0.35)";
    ctx.lineWidth = 1;
    for (let i = 0; i < res.n; i++) {
      const gx = (i % res.cols) * res.w;
      const gy = Math.floor(i / res.cols) * res.h;
      ctx.strokeRect(gx + 0.5, gy + 0.5, res.w - 1, res.h - 1);
    }
  }
  applySheetZoom();
}

function applySheetZoom() {
  const res = appState.lastSheetResult;
  if (!res) return;
  const outCv = $("#sheet-canvas");
  const scrollBox = $("#sheet-scroll").getBoundingClientRect();
  let z = 1;
  if (appState.sheetZoom === "fit") {
    const availW = Math.max(200, scrollBox.width - 40);
    const availH = Math.max(180, scrollBox.height - 40);
    z = Math.min(4, Math.max(0.5, Math.min(availW / res.canvas.width, availH / res.canvas.height)));
    if (z >= 1) z = Math.floor(z * 2) / 2;
  } else {
    z = +appState.sheetZoom || 1;
  }
  outCv.style.width = `${Math.round(res.canvas.width * z)}px`;
  outCv.style.height = `${Math.round(res.canvas.height * z)}px`;
}

// ---- 视图 3：源码实时编辑器、质量诊断与调用示例 ----
function buildUsageCode(fx) {
  const cfg = appState.cfg;
  const varName = fx.id.split("/")[1].replace(/-(\w)/g, (_, c) => c.toUpperCase());
  const useAct = !!fx.mod.act && cfg.actorMode !== "hide";
  const fnName = useAct ? "createAct" : "createFx";

  const optsObj = {
    x: Math.round(cfg.canvasW / 2),
    y: Math.round(cfg.canvasH * 0.75),
    ...(cfg.seed !== (fx.meta.options?.seed ?? 1) ? { seed: cfg.seed } : {}),
    ...(cfg.flip ? { flip: true } : {}),
    ...(cfg.palette ? { palette: cfg.palette } : {}),
    ...cfg.extraOpts,
  };

  return [
    `// ${getDisplayName(fx)} (${fx.id}) — 游戏实时渲染集成示例`,
    `import { createFrame, clearFrame, ${fnName}, composite } from "pixelfx";`,
    `import * as ${varName} from "${fx.space === "workspace" ? `./workspace/fx/${fx.id}.js` : `pixelfx/fx/${fx.id}`}";`,
    ``,
    `const W = ${Math.max(320, cfg.canvasW)}, H = ${Math.max(180, cfg.canvasH)};`,
    `const frame = createFrame(W, H);`,
    `const imgData = ctx.createImageData(W, H);`,
    `const fx = ${fnName}(${varName}, ${JSON.stringify(optsObj, null, 2)});`,
    ``,
    `function updateAndDraw(dt) {`,
    `  fx.update(dt);`,
    `  clearFrame(frame);`,
    `  fx.draw(frame);`,
    `  composite(frame, imgData.data, null);`,
    useAct
      ? `  const [sx, sy] = fx.shake;\n  ctx.putImageData(imgData, sx, sy);`
      : `  ctx.putImageData(imgData, 0, 0);`,
    `}`,
  ].join("\n");
}

function renderCheckBanner(check) {
  const banner = $("#check-banner");
  if (!check) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  if (check.errors?.length) {
    banner.className = "check-banner err";
    banner.textContent = `❌ 诊断未通过：${check.errors.join(" ； ")}`;
  } else if (check.warnings?.length) {
    banner.className = "check-banner warn";
    banner.textContent =
      `⚠ 通过（有优化建议）：峰值 ${check.stats?.maxPixels ?? 0} px · 单帧 ${check.stats?.medianMs ?? 0}ms —— ` +
      check.warnings.join(" ； ");
  } else {
    banner.className = "check-banner ok";
    banner.textContent =
      `✓ 像素质量检查全部通过：峰值绘制 ${check.stats?.maxPixels ?? 0} px · 单帧中位耗时 ${check.stats?.medianMs ?? 0}ms · 无越界无残留`;
  }
}

async function loadHistoryDropdown(id) {
  const sel = $("#sel-history");
  try {
    const res = await fetch(`/api/workspace/history?id=${encodeURIComponent(id)}`);
    if (!res.ok) return;
    const data = await res.json();
    const list = data.history || [];
    sel.replaceChildren(
      el("option", { value: "", textContent: `历史快照 (${list.length})...` }),
      ...list.map((h) => {
        const dt = new Date(h.mtimeMs).toLocaleTimeString("zh-CN", { hour12: false });
        const tag = h.file.replace(/^.*?_/, "").replace(/\.js$/, "");
        return el("option", { value: h.file, textContent: `${dt} [${tag}]` });
      }),
    );
  } catch {}
}

async function refreshCodeView() {
  const fx = appState.currentFx;
  if (!fx) return;

  const isWsSource = fx.space === "workspace" && appState.codeMode === "source";
  const isSfxSource = appState.codeMode === "sfx";
  const isLibSource = fx.space === "library" && appState.codeMode === "source";

  $("#btn-check-code").hidden = !isWsSource;
  $("#sel-history").hidden = !isWsSource;
  $("#btn-fork-to-edit").hidden = !isLibSource;

  if (isSfxSource) {
    $("#code-path").textContent = `workspace/sfx/${fx.id}.js`;
    try {
      const resp = await fetch(`/api/sfx/source?id=${encodeURIComponent(fx.id)}`, { cache: "no-store" });
      const data = await resp.json();
      const banner = $("#check-banner");
      if (data.ok && data.exists) {
        $("#code-editor").hidden = false;
        $("#code-box").hidden = true;
        $("#btn-save-code").hidden = false;
        $("#btn-save-code").textContent = "保存并编译配音 (Ctrl+S)";
        if (!appState.codeDirty) {
          $("#code-editor").value = data.code;
        }
        banner.hidden = false;
        banner.className = "check-banner ok";
        banner.textContent = `✓ 已由纯 JS 声学引擎独立编译 ${sfxState.variants.length} 个变种：${sfxState.variants.map((v) => v.label).join(" / ")}`;
      } else {
        // 严禁预填固定音效模板，避免 AI 或人工在模板上套改导致听感雷同
        $("#code-editor").hidden = true;
        $("#code-box").hidden = false;
        $("#btn-save-code").hidden = true;
        $("#code-content").textContent = [
          `// 当前特效 (${fx.id}) 尚未生成专属配音脚本。`,
          `//`,
          `// 设计原则：不预置任何固定音效模板供套改，也不在技能中硬编码绑定参考库！`,
          `// 1. 默认模式：直接使用 sfx-core 纯 JavaScript DSP 原语针对特效关键帧独立程序化合成；`,
          `// 2. 可选参考模式：在右侧开启「启用音效参考」并挂载自定义音频库后，AI 可检索参考采样分层混音 + DSP 合成。`,
          `// 请点击右侧「✦ AI 生成配音」或通过外部 AI Harness 编排 workspace/sfx/${fx.id}.js。`,
        ].join("\n");
        banner.hidden = false;
        banner.className = "check-banner warn";
        banner.textContent = "提示：为保证每个特效配音的独特性，系统不预置可套改模板，请通过 AI Agent 针对关键帧从零合成。";
      }
    } catch {}
    return;
  }

  $("#code-editor").hidden = !isWsSource;
  $("#code-box").hidden = isWsSource;
  $("#btn-save-code").hidden = !isWsSource;
  $("#btn-save-code").textContent = "保存热重载 (Ctrl+S)";
  if (!isWsSource) $("#check-banner").hidden = true;

  if (appState.codeMode === "usage") {
    $("#code-path").textContent = fx.space === "workspace" ? `workspace/fx/${fx.id}.js` : `pixelfx/fx/${fx.id}`;
    $("#code-content").textContent = buildUsageCode(fx);
    return;
  }

  if (appState.codeMode === "json") {
    $("#code-path").textContent = `${fx.id.split("/")[1]}.json`;
    const res = buildSpriteSheet(fx, { ...appState.cfg, displayName: getDisplayName(fx) }, { exportActor: appState.sheetActor });
    $("#code-content").textContent = JSON.stringify(res.json, null, 2);
    return;
  }

  // source 模式
  if (fx.space === "workspace") {
    $("#code-path").textContent = `workspace/fx/${fx.id}.js`;
    loadHistoryDropdown(fx.id);
    try {
      const resp = await fetch(`/api/workspace/source?id=${encodeURIComponent(fx.id)}`, { cache: "no-store" });
      const data = await resp.json();
      if (data.ok && !appState.codeDirty) {
        $("#code-editor").value = data.code;
      }
      // 自动执行一次轻量质量诊断
      const chkResp = await fetch("/api/workspace/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: fx.id }),
      });
      const chkData = await chkResp.json();
      if (chkData.ok) renderCheckBanner(chkData.check);
    } catch {}
    return;
  }

  // 内置只读库源码展示
  const relUrl = `../src/fx/${fx.id}.js`;
  $("#code-path").textContent = `src/fx/${fx.id}.js (只读)`;
  if (appState.sourceCache.has(fx.id)) {
    $("#code-content").textContent = appState.sourceCache.get(fx.id);
    return;
  }
  $("#code-content").textContent = "// 正在读取特效源码...";
  try {
    let resp = await fetch(relUrl);
    if (!resp.ok) resp = await fetch(`./src/fx/${fx.id}.js`);
    const src = await resp.text();
    appState.sourceCache.set(fx.id, src);
    if (appState.currentFx === fx && appState.codeMode === "source") {
      $("#code-content").textContent = src;
    }
  } catch {
    $("#code-content").textContent = `// 读取失败: ${relUrl}`;
  }
}

async function saveCurrentEditorCode() {
  const fx = appState.currentFx;
  if (!fx) return;
  const code = $("#code-editor").value;
  const btn = $("#btn-save-code");

  if (appState.codeMode === "sfx") {
    btn.disabled = true;
    btn.textContent = "编译 .ogg 变种中...";
    try {
      const resp = await fetch("/api/sfx/save-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: fx.id, code, reason: "manual-sfx" }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || "配音编译失败");
      appState.codeDirty = false;
      invalidateSfxCacheForFx(fx.id);
      await applySfxInfoToDOM(data.sfx);
      const banner = $("#check-banner");
      banner.hidden = false;
      banner.className = "check-banner ok";
      banner.textContent = `✓ 配音脚本编译成功：共生成 ${data.sfx.variants.length} 个专属变种 (${data.sfx.variants.map((v) => v.label).join(" / ")})`;
      if (fx.space !== "workspace") {
        await loadWorkspaceEffectsFromServer();
        switchSpace("workspace", fx.id);
      }
      showToast(`已编译 ${data.sfx.variants.length} 个音效变种！`);
    } catch (e) {
      const banner = $("#check-banner");
      banner.hidden = false;
      banner.className = "check-banner err";
      banner.textContent = `❌ 配音脚本编译报错：${e.message}`;
      showToast(`配音脚本报错: ${e.message.split("\n")[0]}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "保存并编译配音 (Ctrl+S)";
    }
    return;
  }

  if (fx.space !== "workspace") return;
  btn.disabled = true;
  btn.textContent = "保存中...";
  try {
    const resp = await fetch("/api/workspace/save-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: fx.id, code, reason: "manual" }),
    });
    const data = await resp.json();
    if (!resp.ok && !data.check) throw new Error(data.error || "保存失败");
    appState.codeDirty = false;
    renderCheckBanner(data.check);
    loadHistoryDropdown(fx.id);
    await reloadWorkspaceAndRefresh(fx.id, true);
    showToast(data.check?.errors?.length ? "已保存，但存在诊断错误" : "源码已保存并热重载到舞台！");
  } catch (e) {
    showToast(`保存失败: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "保存热重载 (Ctrl+S)";
  }
}

// ---- 底部缩略图切换栏 ----
function renderThumbPreview(canvas, fx, tRatio = 0.42) {
  const W = 98, H = 44;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (fx.broken) {
    ctx.fillStyle = "#2b1620";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#f87171";
    ctx.font = "11px monospace";
    ctx.fillText("ERR", 36, 26);
    return;
  }
  try {
    const m = fx.meta;
    const [fw, fh] = m.size;
    const scale = Math.min(1, Math.min((W * 0.9) / fw, (H * 0.92) / fh));
    const simW = Math.max(W, Math.ceil(W / scale));
    const simH = Math.max(H, Math.ceil(H / scale));
    const ox = Math.floor((simW - fw) / 2) + m.origin[0];
    const oy = Math.floor((simH - fh) / 2) + m.origin[1];

    const f = createFrame(simW, simH);
    const bg = buildBackdropBuffer(m.bg === "sky" ? "sky" : "topstone", simW, simH, oy);
    const opts = {
      ...(fx.preset?.extraOpts || {}),
      ...(fx.preset?.palette ? { palette: fx.preset.palette } : {}),
      ...(fx.preset?.seed !== undefined ? { seed: fx.preset.seed } : {}),
      x: ox,
      y: oy,
    };
    const inst = createFx(fx.mod, opts);
    const steps = 6;
    const dt = (m.duration * tRatio) / steps;
    for (let i = 0; i < steps; i++) inst.update(dt);
    inst.draw(f);

    const rgba = composite(f, new Uint8ClampedArray(simW * simH * 4), bg);
    const out = simW === W && simH === H ? rgba : resampleNearestRGBA(rgba, simW, simH, W, H);
    ctx.putImageData(new ImageData(out, W, H), 0, 0);
  } catch {}
}

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const cv = $("canvas", e.target);
      if (cv && !cv.dataset.rendered) {
        cv.dataset.rendered = "1";
        const fx = activePool().find((x) => x.id === e.target.dataset.id);
        if (fx) renderThumbPreview(cv, fx);
      }
    }
  },
  { root: $("#carousel-strip"), rootMargin: "160px" },
);

function applyFilter() {
  const q = appState.q.trim().toLowerCase();
  const pool = activePool();
  appState.filtered = pool.filter((fx) => {
    if (appState.cat !== "all" && fx.cat !== appState.cat) return false;
    if (!q) return true;
    const hay = [
      fx.id,
      fx.meta.name,
      getDisplayName(fx),
      getDisplayDesc(fx),
      getCatName(fx.cat),
      ...(fx.meta.tags || []),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
  buildCarouselStrip();
}

function buildCarouselStrip() {
  const strip = $("#carousel-strip");
  thumbObserver.disconnect();

  if (!appState.filtered.length) {
    strip.replaceChildren(
      el("div", {
        className: "extra-empty",
        style: "padding: 14px 8px;",
        textContent:
          appState.space === "workspace" && !WS_LIST.length
            ? "创作工作区为空，可点击「+ 新建特效」或切到「内置特效库」克隆。"
            : "未找到匹配的特效。",
      }),
    );
    return;
  }

  const cards = appState.filtered.map((fx) => {
    const cv = el("canvas", { className: "thumb-stage" });
    const editBtn = el("span", { className: "thumb-edit", title: "重命名", textContent: "[E]" });
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openRenameModal(fx);
    });

    const card = el(
      "div",
      {
        className: "thumb-card" + (appState.currentFx?.id === fx.id ? " active" : ""),
        role: "option",
        tabIndex: 0,
      },
      [
        cv,
        el("div", { className: "thumb-foot" }, [
          el("span", { className: "thumb-title", textContent: getDisplayName(fx) }),
          editBtn,
        ]),
      ],
    );
    card.dataset.id = fx.id;
    card.addEventListener("click", () => selectEffect(fx));
    thumbObserver.observe(card);
    return card;
  });

  strip.replaceChildren(...cards);
  highlightCarouselActive(true);
}

function highlightCarouselActive(instant = false) {
  const curId = appState.currentFx?.id;
  $$(".thumb-card", $("#carousel-strip")).forEach((c) => {
    const on = c.dataset.id === curId;
    c.classList.toggle("active", on);
    if (on) {
      c.scrollIntoView({ behavior: instant ? "instant" : "smooth", inline: "center", block: "nearest" });
    }
  });
}

function stepPrevNext(delta) {
  const list = appState.filtered.length ? appState.filtered : activePool();
  if (!list.length) return;
  const idx = list.findIndex((x) => x.id === appState.currentFx?.id);
  const nextIdx = idx < 0 ? 0 : (idx + delta + list.length) % list.length;
  selectEffect(list[nextIdx]);
}

// ---- 工作区动作：克隆、新建、变体、保存预设、发布回库、删除 ----
async function forkCurrentToWorkspace(fx = appState.currentFx, customSuffixName = null) {
  if (!fx) return;
  const baseZh = customSuffixName || (fx.space === "library" ? getDisplayName(fx) : `${getDisplayName(fx)}·变体`);
  try {
    const resp = await fetch("/api/workspace/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: fx.id,
        zhName: baseZh,
        zhDesc: getDisplayDesc(fx),
        cloneFrom: fx.id,
        cloneSpace: fx.space,
        preset: { ...appState.cfg },
      }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "克隆失败");
    await loadWorkspaceEffectsFromServer();
    switchSpace("workspace", data.id);
    showToast(`已载入工作区: ${baseZh} (${data.id})`);
  } catch (e) {
    showToast(`操作失败: ${e.message}`);
  }
}

async function saveCurrentPresetToWorkspace() {
  const fx = appState.currentFx;
  if (!fx || fx.space !== "workspace") return;
  try {
    const resp = await fetch("/api/workspace/tune", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: fx.id,
        source: "ui-save-preset",
        preset: { ...appState.cfg },
      }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error);
    fx.preset = { ...appState.cfg };
    showToast("已将当前参数保存为该特效的默认工作区预设");
  } catch (e) {
    showToast(`保存预设失败: ${e.message}`);
  }
}

async function publishCurrentWorkspaceFx() {
  const fx = appState.currentFx;
  if (!fx || fx.space !== "workspace") return;
  if (!confirm(`确定将「${getDisplayName(fx)} (${fx.id})」正式发布写入 src/fx/ 内置特效库吗？`)) return;
  try {
    const resp = await fetch("/api/workspace/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: fx.id }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error);
    showToast(`🎉 已发布至 src/fx/${fx.id}.js 并更新内置库索引！`);
  } catch (e) {
    showToast(`发布失败: ${e.message}`);
  }
}

async function deleteCurrentWorkspaceFx() {
  const fx = appState.currentFx;
  if (!fx || fx.space !== "workspace") return;
  if (!confirm(`确定从工作区删除「${getDisplayName(fx)} (${fx.id})」吗？（历史备份仍会保留）`)) return;
  try {
    const resp = await fetch("/api/workspace/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: fx.id }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error);
    await loadWorkspaceEffectsFromServer();
    rebuildCategorySelect();
    applyFilter();
    if (WS_LIST.length) {
      selectEffect(appState.filtered[0] || WS_LIST[0]);
    } else {
      switchSpace("library");
    }
    showToast(`已从工作区移除 ${fx.id}`);
  } catch (e) {
    showToast(`删除失败: ${e.message}`);
  }
}

// ---- SSE 实时监听：外部 Agent 或内置 AI 修改文件后毫秒级热同步 ----
async function reloadWorkspaceAndRefresh(targetId, keepView = true) {
  await loadWorkspaceEffectsFromServer();
  if (appState.space === "workspace") {
    rebuildCategorySelect();
    applyFilter();
  }
  const hit = WS_LIST.find((x) => x.id === (targetId || appState.currentFx?.id));
  if (hit) {
    if (appState.space !== "workspace" && appState.autoFollowAgent && targetId) {
      switchSpace("workspace", hit.id);
      return;
    }
    if (appState.space === "workspace") {
      if (targetId && appState.autoFollowAgent) {
        selectEffect(hit, { preserveTime: keepView && appState.currentFx?.id === hit.id });
      } else if (appState.currentFx?.id === hit.id) {
        selectEffect(hit, { preserveTime: true });
      }
    }
  }
}

function connectLiveSSE() {
  const badge = $("#sync-badge");
  const txt = $("#sync-text");
  if (location.hostname.endsWith(".github.io")) {
    txt.textContent = "STATIC PREVIEW";
    return;
  }
  let es;
  let everConnected = false;
  try {
    es = new EventSource("/api/events");
  } catch {
    txt.textContent = "离线静态模式";
    return;
  }

  es.addEventListener("connected", () => {
    everConnected = true;
    badge.classList.add("online");
    txt.textContent = "LIVE SYNC";
  });

  es.onerror = () => {
    badge.classList.remove("online");
    if (!everConnected) {
      txt.textContent = "STATIC PREVIEW";
      es.close();
      return;
    }
    txt.textContent = "RECONNECT...";
  };

  es.addEventListener("workspace-sync", async (ev) => {
    const payload = JSON.parse(ev.data || "{}");
    if (payload.source === "api-save" || payload.source === "api-delete") return;
    await reloadWorkspaceAndRefresh(payload.changedId, true);
    pushLiveFeedLocal("FX", `文件热重载: ${payload.changedId || "workspace.json"}`);
    if (payload.changedId) {
      showToast(`已热更新工作区特效: ${payload.changedId}`);
    }
  });

  es.addEventListener("preset-sync", async (ev) => {
    const payload = JSON.parse(ev.data || "{}");
    if (payload.source === "ui-save-preset") return;
    await reloadWorkspaceAndRefresh(payload.changedId, false);
    pushLiveFeedLocal("TUNE", `参数实时更新: ${payload.changedId}`);
    showToast(`Agent 已动态更新参数: ${payload.changedId}`);
  });

  es.addEventListener("ui-command", async (ev) => {
    const cmd = JSON.parse(ev.data || "{}");
    await applyExternalUiCommand(cmd);
  });

  es.addEventListener("harness-sync", async (ev) => {
    const payload = JSON.parse(ev.data || "{}");
    await refreshHarnessDirectoryUI();
    if (payload.changedFile) {
      pushLiveFeedLocal("SKILL", `目录变更: ${payload.changedFile}`);
    }
  });

  es.addEventListener("sfx-sync", async (ev) => {
    const payload = JSON.parse(ev.data || "{}");
    if (!payload.id) return;
    invalidateSfxCacheForFx(payload.id);
    if (appState.currentFx?.id === payload.id && payload.sfx) {
      await applySfxInfoToDOM(payload.sfx);
      if (appState.activeView === "code" && appState.codeMode === "sfx" && !appState.codeDirty) {
        refreshCodeView();
      }
      if (payload.source !== "ui-select-variant" && payload.source !== "api-sfx-save") {
        pushLiveFeedLocal("SFX", `专属配音已同步: ${payload.id} (${payload.sfx.variants?.length || 0} 变种)`);
        showToast(`已同步 ${payload.id} 的 ${payload.sfx.variants?.length || 0} 个音效变种`);
      }
    }
  });

  es.addEventListener("sfx-refs-sync", (ev) => {
    try {
      const status = JSON.parse(ev.data || "{}");
      applySfxRefsStatusToDOM(status);
    } catch {}
  });
}

// ---- 动态可选音效参考库前端状态（不内置音频包，与技能解耦） ----
const sfxRefsState = {
  enabled: false,
  active: false,
  activeLibraryCount: 0,
  activeSoundCount: 0,
  totalSoundCount: 0,
  libraries: [],
};

async function loadSfxRefsStatus() {
  try {
    const resp = await fetch("/api/sfx/refs/status", { cache: "no-store" });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.ok) applySfxRefsStatusToDOM(data);
  } catch {}
}

function applySfxRefsStatusToDOM(status) {
  sfxRefsState.enabled = !!status.enabled;
  sfxRefsState.active = !!status.active;
  sfxRefsState.activeLibraryCount = status.activeLibraryCount || 0;
  sfxRefsState.activeSoundCount = status.activeSoundCount || 0;
  sfxRefsState.totalSoundCount = status.totalSoundCount || 0;
  sfxRefsState.libraries = Array.isArray(status.libraries) ? status.libraries : [];

  const togBtn = $("#tog-sfx-refs");
  const togLbl = $("#tog-sfx-refs-lbl");
  const mgrBtn = $("#btn-sfx-refs-mgr");
  if (togBtn) {
    togBtn.setAttribute("aria-pressed", String(sfxRefsState.active));
  }
  if (togLbl) {
    togLbl.textContent = sfxRefsState.active
      ? `参考已启用 (${sfxRefsState.activeSoundCount})`
      : "启用音效参考";
  }
  if (mgrBtn) {
    mgrBtn.textContent = sfxRefsState.libraries.length
      ? `参考库管理 (${sfxRefsState.libraries.length})`
      : "参考库管理 (0)";
  }

  const dlgTog = $("#dlg-tog-refs-global");
  const dlgTxt = $("#dlg-refs-global-txt");
  const statEl = $("#refs-summary-stat");
  if (dlgTog) dlgTog.setAttribute("aria-pressed", String(sfxRefsState.enabled));
  if (dlgTxt) {
    dlgTxt.textContent = sfxRefsState.enabled
      ? sfxRefsState.activeSoundCount > 0
        ? `已启用 (${sfxRefsState.activeSoundCount} 条参考可用)`
        : "开关已开启 (请挂载参考库)"
      : "未启用 (纯程序化合成)";
  }
  if (statEl) {
    statEl.textContent = `${sfxRefsState.libraries.length} 个库 · ${sfxRefsState.activeSoundCount} 条启用音频`;
  }

  renderSfxRefsModalList();
  scheduleActiveContextSync();
}

function renderSfxRefsModalList() {
  const listEl = $("#sfx-refs-list");
  if (!listEl) return;
  if (!sfxRefsState.libraries.length) {
    listEl.replaceChildren(
      el("div", {
        className: "extra-empty",
        style: "padding: 16px 10px;",
        textContent: "当前未挂载任何音效参考库（默认使用 sfx-core 纯 JS 程序化合成）。你可在上方挂载本地音效目录或导入 ZIP 音频包。",
      }),
    );
    return;
  }

  listEl.replaceChildren(
    ...sfxRefsState.libraries.map((lib) => {
      const chk = el("input", {
        type: "checkbox",
        checked: lib.enabled !== false,
        title: "勾选或取消该参考库参与合成",
      });
      chk.addEventListener("change", async () => {
        try {
          const resp = await fetch("/api/sfx/refs/toggle-lib", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: lib.id, enabled: chk.checked }),
          });
          const data = await resp.json();
          if (data.ok) applySfxRefsStatusToDOM(data);
        } catch (e) {
          showToast(`切换失败: ${e.message}`);
        }
      });

      const rescanBtn = el("button", {
        type: "button",
        className: "ctrl-btn btn-xs",
        textContent: "重扫",
      });
      rescanBtn.addEventListener("click", async () => {
        rescanBtn.disabled = true;
        try {
          const resp = await fetch("/api/sfx/refs/rescan", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: lib.id }),
          });
          const data = await resp.json();
          if (!data.ok) throw new Error(data.error);
          applySfxRefsStatusToDOM(data);
          showToast(`已重新扫描「${lib.name}」`);
        } catch (e) {
          showToast(`扫描失败: ${e.message}`);
        } finally {
          rescanBtn.disabled = false;
        }
      });

      const delBtn = el("button", {
        type: "button",
        className: "ctrl-btn btn-xs danger-hover",
        textContent: "移除",
      });
      delBtn.addEventListener("click", async () => {
        if (!confirm(`确定移除音效参考库「${lib.name}」吗？${lib.sourceType === "dir" ? "（原本地文件夹文件不会被删除）" : ""}`)) return;
        try {
          const resp = await fetch("/api/sfx/refs/remove", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: lib.id }),
          });
          const data = await resp.json();
          if (!data.ok) throw new Error(data.error);
          applySfxRefsStatusToDOM(data);
          showToast(`已移除参考库「${lib.name}」`);
        } catch (e) {
          showToast(`移除失败: ${e.message}`);
        }
      });

      const badgeTxt = lib.sourceType === "upload" ? "导入包" : "本地目录";
      return el(
        "div",
        { className: "refs-lib-row" + (lib.enabled === false ? " disabled" : "") },
        [
          el("div", { className: "refs-lib-main" }, [
            el("label", { className: "refs-lib-top" }, [
              chk,
              el("span", { textContent: lib.name }),
              el("span", { className: "kind-tag", textContent: badgeTxt }),
              el("span", { className: "kind-tag rule", textContent: `${lib.count || 0} 条` }),
            ]),
            el("div", { className: "refs-lib-sub", textContent: `ID: ${lib.id} · ${lib.dirPath}` }),
          ]),
          el("div", { className: "refs-lib-btns" }, [rescanBtn, delBtn]),
        ],
      );
    }),
  );
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const str = String(reader.result || "");
      const idx = str.indexOf(",");
      resolve(idx >= 0 ? str.slice(idx + 1) : str);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---- 专属特效配音与变种播放器：一特效一配音集，切换该特效的不同听感变种 (.ogg) ----
const sfxState = {
  syncEnabled: false,
  audioCtx: null,
  activeSource: null,
  fxId: null,
  hasScript: false,
  variants: [], // Array<{ id, label, desc, file, duration, rmsDb, peakDb, cues, bars }>
  activeVariant: null,
  audioCache: new Map(), // `${fxId}::${variantId}` -> { oggBytes, audioBuffer }
};

function getAudioCtx() {
  if (!sfxState.audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) sfxState.audioCtx = new Ctx();
  }
  if (sfxState.audioCtx?.state === "suspended") {
    sfxState.audioCtx.resume().catch(() => {});
  }
  return sfxState.audioCtx;
}

function stopActiveAudio() {
  if (sfxState.activeSource) {
    try { sfxState.activeSource.stop(); } catch {}
    sfxState.activeSource = null;
  }
}

function invalidateSfxCacheForFx(effectId) {
  for (const k of [...sfxState.audioCache.keys()]) {
    if (k.startsWith(`${effectId}::`)) sfxState.audioCache.delete(k);
  }
}

function getActiveVariantMeta() {
  if (!sfxState.variants.length) return null;
  return (
    sfxState.variants.find((v) => v.id === sfxState.activeVariant) ||
    sfxState.variants[0] ||
    null
  );
}

async function loadSfxInfoForFx(fx) {
  if (!fx) return;
  try {
    const resp = await fetch(`/api/sfx/info?id=${encodeURIComponent(fx.id)}`, { cache: "no-store" });
    const data = await resp.json();
    if (appState.currentFx !== fx) return;
    await applySfxInfoToDOM(data);
  } catch {
    if (appState.currentFx === fx) {
      await applySfxInfoToDOM({ id: fx.id, hasScript: false, activeVariant: null, variants: [] });
    }
  }
}

async function applySfxInfoToDOM(info) {
  sfxState.fxId = info.id || appState.currentFx?.id || null;
  sfxState.hasScript = !!info.hasScript;
  sfxState.variants = Array.isArray(info.variants) ? info.variants : [];
  sfxState.activeVariant =
    sfxState.variants.find((v) => v.id === info.activeVariant)?.id ||
    sfxState.variants[0]?.id ||
    null;

  const sel = $("#sel-sfx-variant");
  const descEl = $("#sfx-variant-desc");
  const baseTagsEl = $("#sfx-base-tags");
  const lblEl = $("#sfx-meta-lbl");
  const playBtn = $("#btn-sfx-play");
  const expBtn = $("#btn-sfx-export");
  const aiBtn = $("#btn-sfx-ai-gen");

  if (!sfxState.variants.length) {
    sel.replaceChildren(el("option", { value: "", textContent: "暂无专属配音 — 请由 AI Agent 生成" }));
    sel.disabled = true;
    descEl.textContent =
      "纯 JS 程序化声学引擎（可选开启上方「启用音效参考」叠加自定义参考包）。点击「✦ AI 生成配音」即可针对当前特效生成多个音效变种。";
    if (baseTagsEl) baseTagsEl.hidden = true;
    lblEl.textContent = "待 AI 生成";
    playBtn.disabled = true;
    expBtn.disabled = true;
    if (aiBtn) aiBtn.textContent = "✦ AI 生成配音";
    drawSfxWaveform(0);
    return;
  }

  sel.disabled = false;
  sel.replaceChildren(
    ...sfxState.variants.map((v) =>
      el("option", { value: v.id, textContent: v.label }),
    ),
  );
  sel.value = sfxState.activeVariant;
  playBtn.disabled = false;
  expBtn.disabled = false;
  if (aiBtn) aiBtn.textContent = "✦ AI 新增变种";

  refreshActiveVariantSummary();
  scheduleActiveContextSync();
  // 预取当前激活变种音频字节，保证点击试听或舞台同步零延迟
  fetchActiveVariantAudio({ decode: !!sfxState.audioCtx }).catch(() => {});
}

function refreshActiveVariantSummary() {
  const v = getActiveVariantMeta();
  const descEl = $("#sfx-variant-desc");
  const baseTagsEl = $("#sfx-base-tags");
  const lblEl = $("#sfx-meta-lbl");
  if (!v) return;
  descEl.textContent = v.desc || `当前特效专属变种：${v.label}`;
  if (baseTagsEl) {
    const refs = Array.isArray(v.refSamples)
      ? v.refSamples
      : Array.isArray(v.baseSamples)
        ? v.baseSamples
        : [];
    if (refs.length) {
      baseTagsEl.hidden = false;
      baseTagsEl.replaceChildren(
        ...refs.map((b) => {
          const shortLbl = b.split("/").slice(0, 1)[0] + ":" + b.split("/").pop();
          return el("span", { className: "sfx-base-pill", title: `参考库采样: ${b}`, textContent: shortLbl });
        }),
        el("span", { className: "sfx-base-pill ai", textContent: "+ AI 合成" }),
      );
    } else {
      baseTagsEl.hidden = true;
    }
  }
  lblEl.textContent = `${sfxState.variants.length} 变种 · ${v.duration}s · ${v.rmsDb}dB`;
  drawSfxWaveform(stage.totalFrames > 1 ? stage.frameIdx / (stage.totalFrames - 1) : 0);
}

function drawSfxWaveform(playRatio = 0) {
  const cv = $("#sfx-wave-canvas");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const W = cv.width;
  const H = cv.height;
  ctx.clearRect(0, 0, W, H);

  const styles = getComputedStyle(document.documentElement);
  const priColor = styles.getPropertyValue("--pri").trim() || "#f59e0b";
  const secColor = styles.getPropertyValue("--sec").trim() || "#2dd4bf";
  const mutedColor = styles.getPropertyValue("--border-mid").trim() || "#334155";

  const v = getActiveVariantMeta();
  const bars = v?.bars;
  if (!bars || !bars.length) {
    ctx.fillStyle = mutedColor;
    for (let i = 0; i < 48; i++) {
      ctx.fillRect(4 + i * 6.5, H / 2 - 1, 4, 2);
    }
    return;
  }

  const step = (W - 8) / bars.length;
  const barW = Math.max(2, Math.floor(step - 1.5));
  const playX = 4 + Math.round(playRatio * (W - 8));

  for (let i = 0; i < bars.length; i++) {
    const x = Math.round(4 + i * step);
    const bh = Math.max(2, Math.round(bars[i] * (H - 8)));
    const y = Math.round((H - bh) / 2);
    ctx.fillStyle = x <= playX ? secColor : mutedColor;
    ctx.fillRect(x, y, barW, bh);
  }

  const dur = v.duration || 1;
  for (const cue of v.cues || []) {
    const cx = Math.round(4 + Math.min(1, cue.t / dur) * (W - 8));
    ctx.fillStyle = cue.kind === "hit" ? "#fb7185" : priColor;
    ctx.fillRect(cx, 1, 2, H - 2);
  }

  ctx.fillStyle = priColor;
  ctx.fillRect(playX, 0, 2, H);
}

async function fetchActiveVariantAudio({ decode = true } = {}) {
  const fx = appState.currentFx;
  const v = getActiveVariantMeta();
  if (!fx || !v) return null;
  const cacheKey = `${fx.id}::${v.id}`;
  let entry = sfxState.audioCache.get(cacheKey);
  if (!entry) {
    const resp = await fetch(`${v.file}?t=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    entry = { oggBytes: new Uint8Array(buf), audioBuffer: null, meta: v };
    sfxState.audioCache.set(cacheKey, entry);
  }
  if (decode && !entry.audioBuffer) {
    const ctx = getAudioCtx();
    if (ctx) {
      try {
        entry.audioBuffer = await ctx.decodeAudioData(entry.oggBytes.buffer.slice(0));
      } catch {}
    }
  }
  return entry;
}

async function playActiveVariantOnce() {
  const v = getActiveVariantMeta();
  if (!v) {
    showToast("当前特效暂无专属配音，请点击「✦ AI 生成配音」");
    return;
  }
  const ctx = getAudioCtx();
  if (!ctx) return;
  const entry = await fetchActiveVariantAudio({ decode: true });
  if (!entry?.audioBuffer) return;
  stopActiveAudio();
  const src = ctx.createBufferSource();
  src.buffer = entry.audioBuffer;
  src.playbackRate.value = appState.previewSpeed;
  src.connect(ctx.destination);
  src.start(0);
  sfxState.activeSource = src;
  src.onended = () => {
    if (sfxState.activeSource === src) sfxState.activeSource = null;
  };
}

async function triggerSyncedAudio() {
  if (!sfxState.syncEnabled || !sfxState.variants.length) return;
  await playActiveVariantOnce();
}

// ---- AI Harness 工作区目录 (.agents 技能树 + 全局 UI 联动反馈流) ----
const localFeedEvents = [];
let editingAgentsDocPath = null;

function pushLiveFeedLocal(tag, message) {
  localFeedEvents.unshift({
    ts: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    tag,
    message,
  });
  if (localFeedEvents.length > 25) localFeedEvents.pop();
  renderFeedNodes();
}

let serverFeedCache = [];
function renderFeedNodes() {
  const listEl = $("#harness-feed-list");
  if (!listEl) return;

  const merged = [
    ...localFeedEvents,
    ...serverFeedCache.map((e) => ({
      ts: new Date(e.ts).toLocaleTimeString("zh-CN", { hour12: false }),
      tag: String(e.type || "AGENT").toUpperCase(),
      message: e.message + (e.targetId ? ` (${e.targetId})` : ""),
    })),
  ].slice(0, 25);

  if (!merged.length) {
    listEl.replaceChildren(
      el("div", {
        className: "extra-empty",
        textContent: "监听就绪：外部 AI Harness 在工作区新建/修改 fx/、调整预设或调用 studio.mjs 时，此处与左侧画布将实时同步更新。",
      }),
    );
    return;
  }

  listEl.replaceChildren(
    ...merged.map((item) =>
      el("div", { className: "task-item" }, [
        el("div", { className: "task-item-top" }, [
          el("span", { className: "task-status", textContent: `[${item.tag}]` }),
          el("span", { textContent: item.ts }),
        ]),
        el("div", { textContent: item.message }),
      ]),
    ),
  );
}

async function applyExternalUiCommand(cmd) {
  if (!cmd || !appState.autoFollowAgent) return;
  if (cmd.theme && $("#sel-ui-theme")) {
    document.documentElement.dataset.theme = cmd.theme;
    $("#sel-ui-theme").value = cmd.theme;
    localStorage.setItem("pixelfx_ui_theme", cmd.theme);
  }
  if (cmd.space && cmd.space !== appState.space) {
    await loadWorkspaceEffectsFromServer();
    switchSpace(cmd.space, cmd.selectId || null);
  } else if (cmd.selectId) {
    await reloadWorkspaceAndRefresh(cmd.selectId, false);
  }
  if (cmd.bg && ZH_BACKDROPS[cmd.bg]) {
    appState.cfg.bg = cmd.bg;
    $("#sel-bg").value = cmd.bg;
    stage.setup(appState.currentFx, false);
  }
  if (cmd.activeView && ["live", "sheet", "code"].includes(cmd.activeView)) {
    const tab = $(`.wb-header .wb-tab[data-view="${cmd.activeView}"]`);
    if (tab) tab.click();
  }
  if (cmd.message) {
    pushLiveFeedLocal("UI", cmd.message);
    showToast(`Agent: ${cmd.message}`);
  }
}

async function refreshHarnessDirectoryUI() {
  const treeEl = $("#agents-file-list");
  if (!treeEl) return;
  try {
    const resp = await fetch("/api/workspace/harness-info", { cache: "no-store" });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.workspaceDir) {
      const pathEl = $("#ws-dir-path");
      pathEl.dataset.fullPath = data.workspaceDir;
      pathEl.textContent = "./workspace";
      pathEl.title = `点击右侧按钮复制完整本地路径: ${data.workspaceDir}`;
    }
    serverFeedCache = data.feed || [];
    renderFeedNodes();

    const files = data.files || [];
    const kindLabels = {
      entry: ["ENTRY", ""],
      skill: ["SKILL", "skill"],
      rule: ["RULE", "rule"],
      script: ["CLI", ""],
      ref: ["REF", ""],
    };

    treeEl.replaceChildren(
      ...files.map((f) => {
        const [lbl, cls] = kindLabels[f.kind] || ["DOC", ""];
        const row = el("div", { className: "agents-file-row", title: `点击查看或编辑 ${f.relPath}` }, [
          el("span", { className: "agents-file-path", textContent: f.relPath }),
          el("span", { className: `kind-tag ${cls}`, textContent: lbl }),
        ]);
        row.addEventListener("click", () => openAgentsDocModal(f.relPath));
        return row;
      }),
    );
  } catch {}
}

async function openAgentsDocModal(relPath) {
  try {
    const resp = await fetch(`/api/workspace/agents-file?path=${encodeURIComponent(relPath)}`, {
      cache: "no-store",
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error);
    editingAgentsDocPath = data.relPath;
    $("#agents-doc-title").textContent = `workspace/${data.relPath}`;
    $("#inp-agents-doc").value = data.content;
    $("#dlg-agents-doc").showModal();
  } catch (e) {
    showToast(`读取失败: ${e.message}`);
  }
}

// ---- 内置 AI Agent 面板交互（多轮对话上下文 + 原子级检查点回撤 Undo） ----
const agentTurns = []; // Array<{ checkpointId, prompt, replyText, userEl, assistantEl }>

function syncUndoButtonState() {
  const undoBtn = $("#btn-agent-undo");
  if (!undoBtn) return;
  const validCount = agentTurns.filter((t) => t.checkpointId).length;
  undoBtn.disabled = validCount === 0;
  undoBtn.textContent = validCount > 0 ? `↩ 撤回 (${validCount})` : "↩ 撤回";
}

function toggleAgentDrawer(forceOpen) {
  appState.agentOpen = forceOpen !== undefined ? forceOpen : !appState.agentOpen;
  $("#agent-drawer").hidden = !appState.agentOpen;
  $("#wb-body").classList.toggle("with-agent", appState.agentOpen);
  $("#btn-toggle-agent").setAttribute("aria-pressed", String(appState.agentOpen));
  setTimeout(() => {
    if (appState.activeView === "live" && appState.currentFx) stage.setup(appState.currentFx, false);
  }, 40);
}

function appendAgentMsg(role, text, isErr = false) {
  const box = $("#agent-msgs");
  const bodyEl = el("div", { textContent: text });
  const msg = el("div", { className: `agent-msg ${role}${isErr ? " err" : ""}` }, [bodyEl]);
  box.append(msg);
  box.scrollTop = box.scrollHeight;
  return { msg, bodyEl };
}

async function performAgentUndo(checkpointId = null) {
  const validTurns = agentTurns.filter((t) => t.checkpointId);
  if (!validTurns.length) return;

  const undoBtn = $("#btn-agent-undo");
  undoBtn.disabled = true;

  try {
    const resp = await fetch("/api/agent/undo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkpointId }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "撤回失败");

    // 移除该检查点及之后的所有对话节点与上下文历史
    const idx = checkpointId
      ? agentTurns.findIndex((t) => t.checkpointId === checkpointId)
      : agentTurns.length - 1;
    if (idx >= 0) {
      const removed = agentTurns.splice(idx);
      for (const turn of removed) {
        turn.userEl?.remove();
        turn.assistantEl?.remove();
      }
      // 将撤回的用户提示词填回输入框，方便微调后重发
      if (!$("#inp-agent-prompt").value.trim() && removed[0]?.prompt) {
        $("#inp-agent-prompt").value = removed[0].prompt;
      }
    }

    await loadWorkspaceEffectsFromServer();
    if (data.restoredId) invalidateSfxCacheForFx(data.restoredId);
    const targetSpace = data.restoredSpace || "workspace";
    const pool = targetSpace === "workspace" ? WS_LIST : LIB_LIST;
    if (appState.space !== targetSpace) {
      switchSpace(targetSpace, data.restoredId);
    } else {
      rebuildCategorySelect();
      applyFilter();
      const hit = pool.find((x) => x.id === data.restoredId) || pool[0];
      if (hit) selectEffect(hit);
    }

    // 精准还原回撤前的右侧滑块参数
    if (data.restoredCfg && appState.currentFx) {
      appState.cfg = {
        ...appState.cfg,
        ...data.restoredCfg,
        extraOpts: { ...(data.restoredCfg.extraOpts || {}) },
      };
      syncInspectorDOM();
      buildExtraParamsDOM();
      stage.setup(appState.currentFx, true);
      if (appState.activeView === "sheet") refreshSheetView();
      if (appState.activeView === "code") refreshCodeView();
    }

    showToast(`已撤回 ${data.undoneCount} 步 AI 修改并还原特效状态`);
  } catch (e) {
    showToast(`撤回失败: ${e.message}`);
  } finally {
    syncUndoButtonState();
  }
}

async function clearBuiltinAgentChat() {
  agentTurns.splice(0, agentTurns.length);
  await fetch("/api/agent/clear-chat", { method: "POST" }).catch(() => {});
  $("#agent-msgs").replaceChildren(
    el("div", {
      className: "agent-msg assistant",
      textContent: "对话已清空。输入指令即可生成或调整特效，每一步均支持一键「↩ 撤回」还原。",
    }),
  );
  syncUndoButtonState();
}

async function sendBuiltinAgentPrompt(promptText) {
  const prompt = promptText.trim();
  if (!prompt) return;
  const { msg: userEl } = appendAgentMsg("user", prompt);
  $("#inp-agent-prompt").value = "";

  const btn = $("#btn-agent-send");
  btn.disabled = true;
  btn.textContent = "生成与校验中...";
  const { msg: pendingNode, bodyEl } = appendAgentMsg(
    "assistant",
    "正在结合上下文生成像素特效并执行规范校验...",
  );

  // 构建多轮历史摘要供模型衔接上下文
  const history = agentTurns.flatMap((t) => [
    { role: "user", content: t.prompt },
    { role: "assistant", content: t.replyText },
  ]);

  try {
    const fx = appState.currentFx;
    const resp = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        currentId: fx?.id || null,
        currentSpace: appState.space,
        currentCfg: appState.cfg,
        history,
      }),
    });
    const data = await resp.json();
    if (!resp.ok && !data.explanation) throw new Error(data.error || "Agent 调用失败");

    const actionLabel =
      data.action === "write_sfx"
        ? "专属配音与变种"
        : data.action === "tune"
          ? "参数调优"
          : data.action === "create_code"
            ? "新建特效"
            : "代码重构";
    const warnNote =
      data.action === "write_sfx"
        ? `\n✓ 已编译 ${data.sfx?.variants?.length || 0} 个专属音效变种 (${(data.sfx?.variants || []).map((v) => v.label).join(" / ")})`
        : data.check?.errors?.length
          ? `\n诊断提示: ${data.check.errors.join("; ")}`
          : data.check?.warnings?.length
            ? `\n建议: ${data.check.warnings[0]}`
            : "\n✓ 像素规范校验通过";

    const finalText = `[${actionLabel} -> ${data.id}]\n${data.explanation}${warnNote}`;
    bodyEl.textContent = finalText;

    if (data.checkpointId) {
      const undoStepBtn = el("button", {
        type: "button",
        className: "undo-turn-btn",
        textContent: "↩ 撤回至此步前",
        title: "回撤该步及之后的修改，还原特效代码、配音变种、参数与对话",
      });
      undoStepBtn.addEventListener("click", () => performAgentUndo(data.checkpointId));
      pendingNode.append(
        el("div", { className: "msg-foot" }, [
          el("span", { className: "modal-id", textContent: data.id }),
          undoStepBtn,
        ]),
      );

      agentTurns.push({
        checkpointId: data.checkpointId,
        prompt,
        replyText: data.explanation || finalText,
        userEl,
        assistantEl: pendingNode,
      });
      syncUndoButtonState();
    }

    if (data.sfx) {
      invalidateSfxCacheForFx(data.id);
      await applySfxInfoToDOM(data.sfx);
    }
    await reloadWorkspaceAndRefresh(data.id, data.action === "write_sfx");
    if (appState.space !== "workspace") switchSpace("workspace", data.id);
  } catch (e) {
    pendingNode.classList.add("err");
    bodyEl.textContent = `错误: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "立即生成 / 调优";
  }
}

// ---- 素材导出逻辑 ----
const EXPORT_FORMAT_META = {
  "sheet-both": { btn: "导出透明图集...", hint: "透明 PNG + JSON，保留完整动画帧。" },
  "bundle-all-zip": { btn: "导出全套资产包...", hint: "打包透明图集 PNG + Aseprite JSON + 关键帧对位 .ogg 音效。" },
  "sfx-ogg": { btn: "导出 .ogg 音效...", hint: "导出 22050Hz 单声道 Vorbis .ogg 像素特效配音。" },
  "sheet-zip": { btn: "导出图集 ZIP...", hint: "打包透明 PNG 图集与 Aseprite JSON 为单个 ZIP 文件。" },
  "frames-zip": { btn: "导出单帧序列...", hint: "将每一帧独立透明 PNG 与元数据打包为 ZIP 序列。" },
  gif: { btn: "导出 GIF 动图...", hint: "生成像素级清晰 GIF 动图（棋盘格背景下自动导出透明 GIF）。" },
  "sheet-png": { btn: "导出透明 PNG...", hint: "仅导出透明背景序列帧网格 PNG 图片。" },
  "contact-png": { btn: "导出预览联系表...", hint: "导出带帧编号、时间戳与背景的分帧预览大图。" },
};

async function runExport() {
  const fx = appState.currentFx;
  if (!fx || fx.broken) return;
  const fmt = $("#sel-export-fmt").value;
  const btn = $("#btn-export");
  const origLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "正在生成...";
  await new Promise((r) => setTimeout(r, 20));

  try {
    const cfg = { ...appState.cfg, displayName: getDisplayName(fx) };
    const baseName = fx.id.split("/")[1];

    if (fmt === "sheet-both") {
      const res = buildSpriteSheet(fx, cfg, { exportActor: appState.sheetActor });
      const pngBytes = await canvasToPngBytes(res.canvas);
      downloadBlob(new Blob([pngBytes], { type: "image/png" }), `${baseName}.png`);
      setTimeout(() => {
        downloadBlob(new Blob([JSON.stringify(res.json, null, 2)], { type: "application/json" }), `${baseName}.json`);
      }, 180);
      showToast(`已导出 ${baseName}.png 与 ${baseName}.json`);
    } else if (fmt === "bundle-all-zip") {
      const res = buildSpriteSheet(fx, cfg, { exportActor: appState.sheetActor });
      const pngBytes = await canvasToPngBytes(res.canvas);
      const sfxEntry = await fetchActiveVariantAudio({ decode: false });
      const files = [
        { name: `${baseName}.png`, data: pngBytes },
        { name: `${baseName}.json`, data: JSON.stringify(res.json, null, 2) },
      ];
      if (sfxEntry?.oggBytes) {
        files.push({ name: `${baseName}.ogg`, data: sfxEntry.oggBytes });
      }
      downloadBlob(buildZipBlob(files), `${baseName}-bundle.zip`);
      showToast(
        sfxEntry?.oggBytes
          ? `已打包导出 ${baseName} (PNG + JSON + 变种 ${sfxEntry.meta.label} OGG)`
          : `已打包导出 ${baseName} (PNG + JSON；当前特效尚无配音)`,
      );
    } else if (fmt === "sfx-ogg") {
      const sfxEntry = await fetchActiveVariantAudio({ decode: false });
      if (!sfxEntry?.oggBytes) {
        showToast("当前特效尚无专属配音，请先点击「✦ AI 生成配音」");
      } else {
        const suffix = sfxEntry.meta.id === "default" ? "" : `_${sfxEntry.meta.id}`;
        downloadBlob(new Blob([sfxEntry.oggBytes], { type: "audio/ogg" }), `${baseName}${suffix}.ogg`);
        showToast(`已导出 ${baseName}${suffix}.ogg (${sfxEntry.meta.label})`);
      }
    } else if (fmt === "sheet-zip") {
      const res = buildSpriteSheet(fx, cfg, { exportActor: appState.sheetActor });
      const pngBytes = await canvasToPngBytes(res.canvas);
      const zip = buildZipBlob([
        { name: `${baseName}.png`, data: pngBytes },
        { name: `${baseName}.json`, data: JSON.stringify(res.json, null, 2) },
      ]);
      downloadBlob(zip, `${baseName}-spritesheet.zip`);
      showToast(`已导出 ${baseName}-spritesheet.zip`);
    } else if (fmt === "frames-zip") {
      const res = buildSpriteSheet(fx, cfg, { exportActor: appState.sheetActor });
      const entries = [];
      const cv = document.createElement("canvas");
      cv.width = res.w;
      cv.height = res.h;
      const ctx = cv.getContext("2d");
      for (let i = 0; i < res.n; i++) {
        ctx.putImageData(new ImageData(res.seq.frames[i].rgba, res.w, res.h), 0, 0);
        entries.push({ name: `${baseName}_${String(i).padStart(3, "0")}.png`, data: await canvasToPngBytes(cv) });
      }
      entries.push({ name: `${baseName}_meta.json`, data: JSON.stringify(res.json.meta, null, 2) });
      downloadBlob(buildZipBlob(entries), `${baseName}-frames.zip`);
      showToast(`已打包导出 ${res.n} 张单帧序列 ZIP`);
    } else if (fmt === "gif") {
      downloadBlob(buildGifBlob(fx, cfg), `${baseName}.gif`);
      showToast(`已导出 ${baseName}.gif`);
    } else if (fmt === "sheet-png") {
      const res = buildSpriteSheet(fx, cfg, { exportActor: appState.sheetActor });
      downloadBlob(new Blob([await canvasToPngBytes(res.canvas)], { type: "image/png" }), `${baseName}.png`);
      showToast(`已导出 ${baseName}.png`);
    } else if (fmt === "contact-png") {
      const cv = buildContactSheetCanvas(fx, cfg);
      downloadBlob(new Blob([await canvasToPngBytes(cv)], { type: "image/png" }), `${baseName}-contact.png`);
      showToast(`已导出 ${baseName}-contact.png`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}

// ---- 重命名弹窗（同时支持工作区特效与内置库特效） ----
let renameTargetFx = null;
function openRenameModal(fx = appState.currentFx) {
  if (!fx) return;
  renameTargetFx = fx;
  $("#ren-id").textContent = `[${fx.space === "workspace" ? "创作工作区" : "内置库"}] ${fx.id}`;
  $("#inp-ren-name").value = getDisplayName(fx);
  $("#inp-ren-desc").value = getDisplayDesc(fx);
  $("#btn-ren-default").hidden = fx.space === "workspace";
  $("#dlg-rename").showModal();
  $("#inp-ren-name").select();
}

// ---- 内置特效库总览弹窗 ----
let libCat = "all";
let libQuery = "";
const libObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const cv = $("canvas", e.target);
      if (cv && !cv.dataset.rendered) {
        cv.dataset.rendered = "1";
        const fx = LIB_LIST.find((x) => x.id === e.target.dataset.id);
        if (fx) renderThumbPreview(cv, fx);
      }
    }
  },
  { root: $("#lib-grid"), rootMargin: "200px" },
);

function openLibraryModal() {
  renderLibraryChips();
  renderLibraryGrid();
  $("#dlg-library").showModal();
}

function renderLibraryChips() {
  const box = $("#lib-chips");
  const mk = (id, label, count) => {
    const b = el("button", {
      type: "button",
      className: "lib-chip" + (libCat === id ? " active" : ""),
      textContent: `${label} (${count})`,
    });
    b.addEventListener("click", () => {
      libCat = id;
      renderLibraryChips();
      renderLibraryGrid();
    });
    return b;
  };
  box.replaceChildren(
    mk("all", "全部", LIB_LIST.length),
    ...categories.map((c) => mk(c.id, getCatName(c.id), LIB_LIST.filter((x) => x.cat === c.id).length)),
  );
}

function renderLibraryGrid() {
  const grid = $("#lib-grid");
  libObserver.disconnect();
  const q = libQuery.trim().toLowerCase();
  const list = LIB_LIST.filter((fx) => {
    if (libCat !== "all" && fx.cat !== libCat) return false;
    if (!q) return true;
    return [fx.id, fx.meta.name, getDisplayName(fx), getDisplayDesc(fx), ...fx.meta.tags]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });

  $("#lib-count").textContent = `${list.length} / ${LIB_LIST.length}`;

  const cards = list.map((fx) => {
    const cv = el("canvas");
    const forkBtn = el("button", {
      type: "button",
      className: "fork-mini",
      textContent: "克隆",
      title: "克隆到创作工作区编辑",
    });
    forkBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      $("#dlg-library").close();
      forkCurrentToWorkspace(fx);
    });

    const card = el("div", { className: "lib-card" }, [
      cv,
      el("div", { className: "lib-card-info" }, [
        el("div", { className: "lib-card-title", textContent: getDisplayName(fx) }),
        el("div", { className: "lib-card-sub" }, [el("span", { textContent: fx.id }), forkBtn]),
      ]),
    ]);
    card.dataset.id = fx.id;
    card.addEventListener("click", () => {
      $("#dlg-library").close();
      switchSpace("library", fx.id);
    });
    libObserver.observe(card);
    return card;
  });

  grid.replaceChildren(...cards);
}

// ---- 事件绑定初始化 ----
function initControls() {
  // 像素工作台配色主题切换
  const savedTheme = localStorage.getItem("pixelfx_ui_theme") || "amber";
  document.documentElement.dataset.theme = savedTheme;
  const selTheme = $("#sel-ui-theme");
  if (selTheme) {
    selTheme.value = savedTheme;
    selTheme.addEventListener("change", (e) => {
      document.documentElement.dataset.theme = e.target.value;
      localStorage.setItem("pixelfx_ui_theme", e.target.value);
    });
  }

  // 空间切换
  $("#space-ws").addEventListener("click", () => switchSpace("workspace"));
  $("#space-lib").addEventListener("click", () => switchSpace("library"));

  $("#sel-category").addEventListener("change", (e) => {
    appState.cat = e.target.value;
    applyFilter();
    if (appState.filtered.length && !appState.filtered.includes(appState.currentFx)) {
      selectEffect(appState.filtered[0]);
    }
  });

  $("#inp-search").addEventListener("input", (e) => {
    appState.q = e.target.value;
    applyFilter();
  });

  // 工作区与内置库按钮
  $("#btn-fork-ws").addEventListener("click", () => forkCurrentToWorkspace(appState.currentFx));
  $("#btn-fork-to-edit").addEventListener("click", () => forkCurrentToWorkspace(appState.currentFx));
  $("#btn-dup-variant").addEventListener("click", () => forkCurrentToWorkspace(appState.currentFx));
  $("#btn-save-preset").addEventListener("click", saveCurrentPresetToWorkspace);
  $("#btn-publish-lib").addEventListener("click", publishCurrentWorkspaceFx);
  $("#btn-del-fx").addEventListener("click", deleteCurrentWorkspaceFx);

  // 新建特效弹窗
  const selNewCat = $("#sel-new-cat");
  selNewCat.replaceChildren(
    ...categories.map((c) => el("option", { value: c.id, textContent: `${getCatName(c.id)} (${c.id})` })),
  );
  $("#btn-new-fx").addEventListener("click", () => {
    selNewCat.value = appState.currentFx?.cat || "water";
    $("#inp-new-slug").value = "";
    $("#inp-new-zh").value = "";
    $("#dlg-new-fx").showModal();
    $("#inp-new-slug").focus();
  });
  $("#btn-new-close").addEventListener("click", () => $("#dlg-new-fx").close());
  $("#btn-new-cancel").addEventListener("click", () => $("#dlg-new-fx").close());
  $("#form-new-fx").addEventListener("submit", async (e) => {
    e.preventDefault();
    const cat = selNewCat.value;
    const slug = $("#inp-new-slug").value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const zhName = $("#inp-new-zh").value.trim();
    const tpl = $("#sel-new-tpl").value;
    if (!slug || !zhName) return;

    const payload = {
      id: `${cat}/${slug}`,
      zhName,
      loop: tpl === "loop",
      ...(tpl === "clone" && appState.currentFx
        ? { cloneFrom: appState.currentFx.id, cloneSpace: appState.currentFx.space }
        : {}),
    };
    try {
      const resp = await fetch("/api/workspace/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error);
      $("#dlg-new-fx").close();
      await loadWorkspaceEffectsFromServer();
      switchSpace("workspace", data.id);
      showToast(`已创建新特效: ${zhName} (${data.id})`);
    } catch (err) {
      showToast(`创建失败: ${err.message}`);
    }
  });

  // 背景与调色板
  const selBg = $("#sel-bg");
  selBg.replaceChildren(
    ...Object.entries(ZH_BACKDROPS).map(([k, label]) => el("option", { value: k, textContent: label })),
  );
  selBg.addEventListener("change", () => {
    appState.cfg.bg = selBg.value;
    stage.setup(appState.currentFx, false);
    scheduleActiveContextSync();
  });

  const selPal = $("#sel-pal");
  selPal.replaceChildren(
    el("option", { value: "", textContent: "特效原始配色" }),
    ...Object.keys(PAL).map((k) => el("option", { value: k, textContent: ZH_PALETTES[k] || k })),
    el("option", { value: "__custom", textContent: "自定义微调配色" }),
  );
  selPal.addEventListener("change", () => {
    const val = selPal.value;
    appState.cfg.paletteKey = val;
    if (!val) appState.cfg.palette = null;
    else if (val !== "__custom" && PAL[val]) appState.cfg.palette = [...PAL[val]];
    renderSwatchBar();
    applyInspectorChange(false);
  });

  // 顶部视图标签切换
  $$(".wb-header .wb-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const view = tab.dataset.view;
      appState.activeView = view;
      $$(".wb-header .wb-tab").forEach((b) => {
        const on = b === tab;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", String(on));
      });
      $("#pane-live").hidden = view !== "live";
      $("#pane-sheet").hidden = view !== "sheet";
      $("#pane-code").hidden = view !== "code";

      if (view === "sheet") refreshSheetView();
      else if (view === "code") refreshCodeView();
      else stage.setup(appState.currentFx, false);
    });
  });

  // 播放与时间轴控制
  $("#stage-viewport").addEventListener("click", () => {
    if (!appState.playing) {
      appState.playing = true;
      $("#btn-play").textContent = "暂停";
    }
    stage.restart();
  });

  $("#btn-play").addEventListener("click", () => {
    appState.playing = !appState.playing;
    $("#btn-play").textContent = appState.playing ? "暂停" : "播放";
    if (!appState.playing) stopActiveAudio();
  });

  $("#btn-replay").addEventListener("click", () => {
    getAudioCtx();
    appState.playing = true;
    $("#btn-play").textContent = "暂停";
    stage.restart();
  });

  $("#tog-sfx-sync").addEventListener("click", async () => {
    getAudioCtx();
    sfxState.syncEnabled = !sfxState.syncEnabled;
    $("#tog-sfx-sync").setAttribute("aria-pressed", String(sfxState.syncEnabled));
    if (sfxState.syncEnabled) {
      if (!sfxState.variants.length) {
        showToast("已开启同步开关；当前特效暂无配音，可点击「✦ AI 生成配音」");
      } else {
        await fetchActiveVariantAudio({ decode: true });
        stage.restart();
        showToast(`已开启舞台同步配音：${getActiveVariantMeta()?.label || ""}`);
      }
    } else {
      stopActiveAudio();
    }
  });

  $("#sel-speed").addEventListener("change", (e) => {
    appState.previewSpeed = +e.target.value || 1;
  });

  $("#scrub-range").addEventListener("input", (e) => {
    appState.playing = false;
    $("#btn-play").textContent = "播放";
    stage.seekFrame(+e.target.value);
  });

  // 检查器参数控件
  $("#inp-seed").addEventListener("change", (e) => {
    appState.cfg.seed = Math.round(+e.target.value || 1);
    applyInspectorChange(true);
  });

  $("#btn-rand-seed").addEventListener("click", () => {
    const s = 1 + Math.floor(Math.random() * 999);
    appState.cfg.seed = s;
    $("#inp-seed").value = s;
    applyInspectorChange(true);
  });

  $("#inp-fps").addEventListener("change", (e) => {
    const v = Math.max(1, Math.min(120, +e.target.value || 30));
    appState.cfg.fps = v;
    e.target.value = v;
    applyInspectorChange(false);
  });

  $("#inp-duration").addEventListener("change", (e) => {
    const v = Math.max(0.05, Math.min(60, +e.target.value || 1));
    appState.cfg.duration = v;
    e.target.value = v;
    updateDurationScaleLabel();
    applyInspectorChange(false);
  });

  $("#inp-w").addEventListener("change", (e) => {
    const m = appState.currentFx.meta;
    const w = Math.max(16, Math.min(1024, Math.round(+e.target.value || m.size[0])));
    appState.cfg.canvasW = w;
    e.target.value = w;
    if (appState.cfg.lockAspect) {
      const h = Math.max(16, Math.round((w * m.size[1]) / m.size[0]));
      appState.cfg.canvasH = h;
      $("#inp-h").value = h;
    }
    applyInspectorChange(false);
  });

  $("#inp-h").addEventListener("change", (e) => {
    const m = appState.currentFx.meta;
    const h = Math.max(16, Math.min(1024, Math.round(+e.target.value || m.size[1])));
    appState.cfg.canvasH = h;
    e.target.value = h;
    if (appState.cfg.lockAspect) {
      const w = Math.max(16, Math.round((h * m.size[0]) / m.size[1]));
      appState.cfg.canvasW = w;
      $("#inp-w").value = w;
    }
    applyInspectorChange(false);
  });

  $("#tog-aspect").addEventListener("click", () => {
    appState.cfg.lockAspect = !appState.cfg.lockAspect;
    $("#tog-aspect").setAttribute("aria-pressed", String(appState.cfg.lockAspect));
    if (appState.cfg.lockAspect) {
      const m = appState.currentFx.meta;
      appState.cfg.canvasH = Math.max(16, Math.round((appState.cfg.canvasW * m.size[1]) / m.size[0]));
      $("#inp-h").value = appState.cfg.canvasH;
      applyInspectorChange(false);
    }
  });

  $("#tog-scale-canvas").addEventListener("click", () => {
    appState.cfg.scaleWithCanvas = !appState.cfg.scaleWithCanvas;
    $("#tog-scale-canvas").setAttribute("aria-pressed", String(appState.cfg.scaleWithCanvas));
    applyInspectorChange(false);
  });

  $("#tog-flip").addEventListener("click", () => {
    appState.cfg.flip = !appState.cfg.flip;
    $("#tog-flip").setAttribute("aria-pressed", String(appState.cfg.flip));
    applyInspectorChange(false);
  });

  $("#sel-actor").addEventListener("change", (e) => {
    appState.cfg.actorMode = e.target.value;
    applyInspectorChange(true);
  });

  $("#btn-reset").addEventListener("click", () => {
    if (!appState.currentFx) return;
    const fx = appState.currentFx;
    const cleanFx = { ...fx, preset: null };
    appState.cfg = buildDefaultCfgForFx(cleanFx);
    syncInspectorDOM();
    buildExtraParamsDOM();
    stage.setup(fx, true);
    showToast("已重置为特效原始代码默认参数");
  });

  // 透明图集工具栏
  $("#sel-sheet-zoom").addEventListener("change", (e) => {
    appState.sheetZoom = e.target.value;
    applySheetZoom();
  });
  $("#tog-sheet-grid").addEventListener("click", () => {
    appState.sheetGrid = !appState.sheetGrid;
    $("#tog-sheet-grid").setAttribute("aria-pressed", String(appState.sheetGrid));
    refreshSheetView();
  });
  $("#tog-sheet-actor").addEventListener("click", () => {
    appState.sheetActor = !appState.sheetActor;
    $("#tog-sheet-actor").setAttribute("aria-pressed", String(appState.sheetActor));
    refreshSheetView();
  });
  $("#btn-dl-png").addEventListener("click", async () => {
    if (!appState.lastSheetResult) refreshSheetView();
    const res = appState.lastSheetResult;
    downloadBlob(new Blob([await canvasToPngBytes(res.canvas)], { type: "image/png" }), `${res.shortName}.png`);
    showToast(`已下载 ${res.shortName}.png`);
  });
  $("#btn-dl-json").addEventListener("click", () => {
    if (!appState.lastSheetResult) refreshSheetView();
    const res = appState.lastSheetResult;
    downloadBlob(new Blob([JSON.stringify(res.json, null, 2)], { type: "application/json" }), `${res.shortName}.json`);
    showToast(`已下载 ${res.shortName}.json`);
  });

  // 源码实时编辑与历史快照
  $$(".code-subtabs .wb-tab").forEach((b) => {
    b.addEventListener("click", () => {
      appState.codeMode = b.dataset.code;
      $$(".code-subtabs .wb-tab").forEach((x) => x.classList.toggle("active", x === b));
      refreshCodeView();
    });
  });

  const editor = $("#code-editor");
  editor.addEventListener("input", () => {
    appState.codeDirty = true;
  });
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + "  " + editor.value.slice(end);
      editor.selectionStart = editor.selectionEnd = s + 2;
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveCurrentEditorCode();
    }
  });

  $("#btn-save-code").addEventListener("click", saveCurrentEditorCode);
  $("#btn-check-code").addEventListener("click", async () => {
    const fx = appState.currentFx;
    if (!fx || fx.space !== "workspace") return;
    if (appState.codeDirty) await saveCurrentEditorCode();
    else {
      const resp = await fetch("/api/workspace/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: fx.id }),
      });
      const data = await resp.json();
      if (data.ok) renderCheckBanner(data.check);
    }
  });

  $("#sel-history").addEventListener("change", async (e) => {
    const file = e.target.value;
    const fx = appState.currentFx;
    if (!file || !fx) return;
    if (!confirm(`确定回退到历史快照 ${file} 吗？`)) {
      e.target.value = "";
      return;
    }
    const resp = await fetch("/api/workspace/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: fx.id, file }),
    });
    const data = await resp.json();
    e.target.value = "";
    if (data.id) {
      appState.codeDirty = false;
      await reloadWorkspaceAndRefresh(fx.id, true);
      refreshCodeView();
      showToast("已恢复至选定历史快照版本");
    }
  });

  $("#btn-copy-code").addEventListener("click", async () => {
    const isEditor = !$("#code-editor").hidden;
    const txt = isEditor ? $("#code-editor").value : $("#code-content").textContent;
    try {
      await navigator.clipboard.writeText(txt);
      showToast("代码已复制到剪贴板");
    } catch {
      showToast("复制失败，请手动全选复制");
    }
  });

  // 专属特效配音与当前特效变种控件事件
  $("#sel-sfx-variant").addEventListener("change", async (e) => {
    const variantId = e.target.value;
    const fx = appState.currentFx;
    if (!variantId || !fx) return;
    sfxState.activeVariant = variantId;
    refreshActiveVariantSummary();
    fetch("/api/sfx/select-variant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: fx.id, variantId }),
    }).catch(() => {});

    getAudioCtx();
    appState.playing = true;
    $("#btn-play").textContent = "暂停";
    if (sfxState.syncEnabled) {
      stage.restart();
    } else {
      stage.restart();
      await playActiveVariantOnce();
    }
  });

  $("#btn-sfx-script").addEventListener("click", () => {
    appState.codeMode = "sfx";
    $$(".code-subtabs .wb-tab").forEach((x) => x.classList.toggle("active", x.dataset.code === "sfx"));
    const codeTab = $(`.wb-header .wb-tab[data-view="code"]`);
    if (codeTab) codeTab.click();
  });

  $("#sfx-wave-box").addEventListener("click", async () => {
    if (!sfxState.variants.length) {
      $("#btn-sfx-ai-gen").click();
      return;
    }
    getAudioCtx();
    appState.playing = true;
    $("#btn-play").textContent = "暂停";
    if (sfxState.syncEnabled) {
      stage.restart();
    } else {
      stage.restart();
      await playActiveVariantOnce();
    }
  });

  $("#btn-sfx-play").addEventListener("click", async () => {
    if (!sfxState.variants.length) {
      showToast("当前特效暂无专属配音，请点击「✦ AI 生成配音」");
      return;
    }
    getAudioCtx();
    sfxState.syncEnabled = true;
    $("#tog-sfx-sync").setAttribute("aria-pressed", "true");
    appState.playing = true;
    $("#btn-play").textContent = "暂停";
    stage.restart();
  });

  $("#btn-sfx-ai-gen").addEventListener("click", async () => {
    const fx = appState.currentFx;
    if (!fx) return;
    toggleAgentDrawer(true);
    const refModeNote = sfxRefsState.active
      ? "结合当前已启用的音效参考库采样分层与 sfx-core 合成"
      : "使用 sfx-core 纯 JS 程序化声学原语独立合成";
    const prompt = sfxState.variants.length
      ? `在当前特效「${getDisplayName(fx)} (${fx.id})」现有配音脚本基础上保留原有变种，再对齐其视觉节奏（${refModeNote}）新增 2 个风格差异鲜明的音效变种（action: write_sfx）`
      : `为当前特效「${getDisplayName(fx)} (${fx.id})」编写专属 JS 配音脚本（action: write_sfx），严格对齐其动画时长与视觉爆发关键帧（${refModeNote}），设计并编译 3 个不同听感层次的音效变种`;

    try {
      const resp = await fetch("/api/agent/config");
      const data = await resp.json();
      const c = data.config || {};
      const canCallDirect =
        c.hasKey ||
        (c.baseUrl && (c.baseUrl.includes("localhost") || c.baseUrl.includes("127.0.0.1")));
      $("#tab-amode-api").click();
      if (canCallDirect) {
        sendBuiltinAgentPrompt(prompt);
      } else {
        $("#inp-agent-prompt").value = prompt;
        $("#inp-agent-prompt").focus();
        showToast("已填入专属配音生成指令：配置 API Key 可一键生成，或用外部 Agent 调用 pixelfx-sfx 技能");
      }
    } catch {
      $("#tab-amode-api").click();
      $("#inp-agent-prompt").value = prompt;
    }
  });

  // 动态音效参考库开关与管理弹窗事件
  const toggleGlobalRefs = async (desired) => {
    try {
      const resp = await fetch("/api/sfx/refs/toggle-global", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: desired }),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error);
      applySfxRefsStatusToDOM(data);
      if (desired && !sfxRefsState.libraries.length) {
        $("#dlg-sfx-refs").showModal();
        showToast("尚未挂载参考音效包，请先挂载本地目录或导入音频/ZIP");
      } else {
        showToast(
          data.active
            ? `已启用音效参考库 (${data.activeSoundCount} 条可用采样)`
            : "已切换为纯 JS 程序化配音合成模式",
        );
      }
    } catch (e) {
      showToast(`切换失败: ${e.message}`);
    }
  };

  $("#tog-sfx-refs").addEventListener("click", () => {
    toggleGlobalRefs(!sfxRefsState.enabled);
  });
  $("#dlg-tog-refs-global").addEventListener("click", () => {
    toggleGlobalRefs(!sfxRefsState.enabled);
  });

  $("#btn-sfx-refs-mgr").addEventListener("click", async () => {
    await loadSfxRefsStatus();
    $("#dlg-sfx-refs").showModal();
  });
  $("#btn-refs-close").addEventListener("click", () => $("#dlg-sfx-refs").close());
  $("#btn-refs-done").addEventListener("click", () => $("#dlg-sfx-refs").close());

  $("#btn-add-ref-dir").addEventListener("click", async () => {
    const dirPath = $("#inp-ref-dir-path").value.trim();
    const name = $("#inp-ref-dir-name").value.trim();
    if (!dirPath) {
      showToast("请先输入本地音效文件夹路径");
      $("#inp-ref-dir-path").focus();
      return;
    }
    const btn = $("#btn-add-ref-dir");
    btn.disabled = true;
    btn.textContent = "扫描索引中...";
    try {
      const resp = await fetch("/api/sfx/refs/add-dir", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, dirPath }),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "挂载失败");
      $("#inp-ref-dir-name").value = "";
      $("#inp-ref-dir-path").value = "";
      applySfxRefsStatusToDOM(data);
      showToast(`已成功挂载音效参考目录（当前共 ${data.activeSoundCount} 条启用音频）`);
    } catch (e) {
      showToast(`挂载失败: ${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "挂载目录";
    }
  });

  $("#btn-upload-ref-files").addEventListener("click", () => {
    $("#inp-ref-files").click();
  });

  $("#inp-ref-files").addEventListener("change", async (e) => {
    const fileList = [...(e.target.files || [])];
    e.target.value = "";
    if (!fileList.length) return;
    const name = $("#inp-ref-upload-name").value.trim();
    const btn = $("#btn-upload-ref-files");
    btn.disabled = true;
    btn.textContent = "导入解析中...";
    try {
      const encodedFiles = [];
      for (const f of fileList) {
        encodedFiles.push({ name: f.name, base64: await fileToBase64(f) });
      }
      const resp = await fetch("/api/sfx/refs/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, files: encodedFiles }),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "导入失败");
      $("#inp-ref-upload-name").value = "";
      applySfxRefsStatusToDOM(data);
      showToast(`成功导入音效参考包（当前共 ${data.activeSoundCount} 条启用音频）`);
    } catch (err) {
      showToast(`导入失败: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "选择 ZIP / 音频导入...";
    }
  });

  $("#btn-sfx-export").addEventListener("click", async () => {
    const fx = appState.currentFx;
    if (!fx) return;
    const baseName = fx.id.split("/")[1];
    const entry = await fetchActiveVariantAudio({ decode: false });
    if (!entry?.oggBytes) {
      showToast("当前特效暂无专属配音");
      return;
    }
    const suffix = entry.meta.id === "default" ? "" : `_${entry.meta.id}`;
    downloadBlob(new Blob([entry.oggBytes], { type: "audio/ogg" }), `${baseName}${suffix}.ogg`);
    showToast(`已导出 ${baseName}${suffix}.ogg (${entry.meta.label})`);
  });

  // 导出与底部切换
  $("#sel-export-fmt").addEventListener("change", (e) => {
    const info = EXPORT_FORMAT_META[e.target.value];
    if (info) {
      $("#btn-export").textContent = info.btn;
      $("#export-hint").textContent = info.hint;
    }
  });
  $("#btn-export").addEventListener("click", runExport);
  $("#btn-prev").addEventListener("click", () => stepPrevNext(-1));
  $("#btn-next").addEventListener("click", () => stepPrevNext(1));

  // 重命名提交（区分工作区与内置库）
  $("#btn-rename").addEventListener("click", () => openRenameModal(appState.currentFx));
  $("#btn-rename-close").addEventListener("click", () => $("#dlg-rename").close());
  $("#btn-ren-cancel").addEventListener("click", () => $("#dlg-rename").close());
  $("#btn-ren-default").addEventListener("click", async () => {
    if (!renameTargetFx || renameTargetFx.space === "workspace") return;
    delete customMeta[renameTargetFx.id];
    localStorage.setItem(STORAGE_CUSTOM_KEY, JSON.stringify(customMeta));
    try {
      await fetch("/api/custom-meta", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(customMeta),
      });
    } catch {}
    refreshTextLabels();
    $("#dlg-rename").close();
    showToast("已恢复内置默认名称");
  });

  $("#form-rename").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!renameTargetFx) return;
    const newName = $("#inp-ren-name").value.trim();
    const newDesc = $("#inp-ren-desc").value.trim();
    if (!newName) return;

    if (renameTargetFx.space === "workspace") {
      await fetch("/api/workspace/tune", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: renameTargetFx.id,
          zhName: newName,
          zhDesc: newDesc,
          source: "ui-save-preset",
        }),
      });
      renameTargetFx.zhName = newName;
      renameTargetFx.zhDesc = newDesc;
    } else {
      customMeta[renameTargetFx.id] = { name: newName, desc: newDesc };
      localStorage.setItem(STORAGE_CUSTOM_KEY, JSON.stringify(customMeta));
      try {
        await fetch("/api/custom-meta", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(customMeta),
        });
      } catch {}
    }
    refreshTextLabels();
    $("#dlg-rename").close();
    showToast(`已更新名称为「${newName}」`);
  });

  // 内置库总览弹窗
  $("#btn-open-lib").addEventListener("click", openLibraryModal);
  $("#btn-lib-close").addEventListener("click", () => $("#dlg-library").close());
  $("#inp-lib-search").addEventListener("input", (e) => {
    libQuery = e.target.value;
    renderLibraryGrid();
  });

  // Agent 创作侧栏事件（双标签：外部 Agent 联动 vs 内置 API 直连）
  $("#btn-toggle-agent").addEventListener("click", () => toggleAgentDrawer());
  $("#btn-agent-close").addEventListener("click", () => toggleAgentDrawer(false));
  $("#chk-auto-follow").addEventListener("change", (e) => {
    appState.autoFollowAgent = e.target.checked;
  });

  $$(".agent-mode-tabs .wb-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const m = tab.dataset.amode;
      appState.agentMode = m;
      $$(".agent-mode-tabs .wb-tab").forEach((x) => x.classList.toggle("active", x === tab));
      $("#amode-ext").hidden = m !== "ext";
      $("#amode-api").hidden = m !== "api";
    });
  });

  $("#btn-copy-ws-dir").addEventListener("click", async () => {
    const pathEl = $("#ws-dir-path");
    const dir = (pathEl.dataset.fullPath || pathEl.textContent).trim();
    try {
      await navigator.clipboard.writeText(dir);
      showToast(`已复制工作区完整路径: ${dir}`);
    } catch {}
  });

  $("#btn-refresh-harness").addEventListener("click", () => {
    refreshHarnessDirectoryUI();
    showToast("已刷新 .agents 目录状态");
  });

  $("#btn-close-agents-doc").addEventListener("click", () => $("#dlg-agents-doc").close());

  $$(".q-chip").forEach((chip) => {
    chip.addEventListener("click", () => sendBuiltinAgentPrompt(chip.dataset.prompt));
  });

  $("#btn-agent-undo").addEventListener("click", () => performAgentUndo(null));
  $("#btn-agent-clear").addEventListener("click", () => clearBuiltinAgentChat());

  $("#form-agent-chat").addEventListener("submit", (e) => {
    e.preventDefault();
    sendBuiltinAgentPrompt($("#inp-agent-prompt").value);
  });

  $("#inp-agent-prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendBuiltinAgentPrompt($("#inp-agent-prompt").value);
    }
  });

  // 内置 AI 模型配置弹窗
  const PROVIDER_DEFAULTS = {
    openai: { url: "https://api.openai.com/v1", model: "gpt-4o" },
    gemini: { url: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-pro" },
    anthropic: { url: "https://api.anthropic.com/v1", model: "claude-sonnet-4-20250514" },
  };

  $("#sel-cfg-provider").addEventListener("change", (e) => {
    const d = PROVIDER_DEFAULTS[e.target.value];
    if (d) {
      $("#inp-cfg-url").value = d.url;
      $("#inp-cfg-model").value = d.model;
    }
  });

  $("#btn-agent-cfg").addEventListener("click", async () => {
    try {
      const resp = await fetch("/api/agent/config", { cache: "no-store" });
      const data = await resp.json();
      if (data.ok) {
        const c = data.config;
        $("#sel-cfg-provider").value = c.provider;
        $("#inp-cfg-url").value = c.baseUrl;
        $("#inp-cfg-model").value = c.model;
        $("#inp-cfg-key").value = "";
        $("#inp-cfg-key").placeholder = c.hasKey
          ? `已脱敏保护 (${c.apiKeyMasked})，留空保持不变`
          : "填写 API Key（加密存于 ~/.pixelfx/ 仓库外部）...";
        $("#cfg-key-status").textContent = c.hasKey
          ? c.keySource === "env"
            ? `✓ 已从环境变量读取 (${c.apiKeyMasked})`
            : `✓ 仓外加密已配置 (${c.apiKeyMasked})`
          : "尚未配置密钥（也可通过环境变量 PIXELFX_API_KEY 注入）";
        const clrBtn = $("#btn-cfg-clear");
        if (clrBtn) clrBtn.hidden = !(c.hasKey && c.keySource !== "env");
      }
    } catch {}
    $("#dlg-agent-cfg").showModal();
  });

  $("#btn-cfg-clear")?.addEventListener("click", async () => {
    if (!confirm("确定彻底清除本机已保存的大模型密钥与接口配置吗？")) return;
    const resp = await fetch("/api/agent/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clearKey: true }),
    });
    const data = await resp.json();
    if (data.ok) {
      $("#dlg-agent-cfg").close();
      showToast("已彻底清除本机保存的 AI 密钥配置");
    }
  });

  $("#btn-cfg-close").addEventListener("click", () => $("#dlg-agent-cfg").close());
  $("#btn-cfg-cancel").addEventListener("click", () => $("#dlg-agent-cfg").close());
  $("#form-agent-cfg").addEventListener("submit", async (e) => {
    e.preventDefault();
    const resp = await fetch("/api/agent/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: $("#sel-cfg-provider").value,
        baseUrl: $("#inp-cfg-url").value,
        model: $("#inp-cfg-model").value,
        apiKey: $("#inp-cfg-key").value,
      }),
    });
    const data = await resp.json();
    if (data.ok) {
      $("#inp-cfg-key").value = "";
      $("#dlg-agent-cfg").close();
      showToast("AI 密钥已加密保存在仓库外 (~/.pixelfx/)，不会进入 Git");
    }
  });

  // 全局键盘快捷键
  window.addEventListener("keydown", (e) => {
    if ($$("dialog[open]").length > 0) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    if (e.code === "Space") {
      e.preventDefault();
      appState.playing = !appState.playing;
      $("#btn-play").textContent = appState.playing ? "暂停" : "播放";
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (e.shiftKey) {
        appState.playing = false;
        $("#btn-play").textContent = "播放";
        stage.seekFrame(stage.frameIdx - 1);
      } else {
        stepPrevNext(-1);
      }
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (e.shiftKey) {
        appState.playing = false;
        $("#btn-play").textContent = "播放";
        stage.seekFrame(stage.frameIdx + 1);
      } else {
        stepPrevNext(1);
      }
    }
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (appState.activeView === "live" && appState.currentFx) stage.setup(appState.currentFx, false);
      else if (appState.activeView === "sheet") applySheetZoom();
    }, 100);
  });
}

// ---- 主动画帧循环 ----
let lastTick = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  if (appState.activeView === "live") {
    stage.tick(dt);
  }
  requestAnimationFrame(loop);
}

// ---- 应用启动 ----
async function boot() {
  initControls();
  try {
    const res = await fetch("/api/custom-meta", { cache: "no-store" });
    if (res.ok) {
      const serverCustom = await res.json();
      customMeta = { ...customMeta, ...serverCustom };
      localStorage.setItem(STORAGE_CUSTOM_KEY, JSON.stringify(customMeta));
    }
  } catch {}

  await loadWorkspaceEffectsFromServer();
  await loadSfxRefsStatus();
  await refreshHarnessDirectoryUI();
  connectLiveSSE();

  const rawHash = decodeURIComponent(location.hash.slice(1));
  if (rawHash.startsWith("library:")) {
    switchSpace("library", rawHash.slice("library:".length));
  } else if (rawHash.startsWith("workspace:")) {
    switchSpace("workspace", rawHash.slice("workspace:".length));
  } else if (WS_LIST.length > 0) {
    switchSpace("workspace", "water/water-eruption");
  } else {
    switchSpace("library", "water/geyser");
  }

  requestAnimationFrame(loop);
}

boot();
