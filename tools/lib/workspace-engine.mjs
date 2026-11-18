// PixelFX 创作工作区后端引擎：工作区特效管理、历史快照、像素质量校验 (Check)、发布回库与内置 AI Agent 驱动

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir, hostname, userInfo } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { ROOT, FX_DIR, loadEffect } from "./fxlib.mjs";
import {
  createFrame,
  clearFrame,
  painterFor,
  createFx,
  createAct,
  actTiming,
  stockActor,
  BACKDROPS,
} from "../../src/core/index.js";
import {
  getSfxRefsStatus,
  setSfxRefsGlobalEnabled,
  addLocalDirRefLibrary,
  importUploadedRefLibrary,
  toggleRefLibrary,
  rescanRefLibrary,
  removeRefLibrary,
  searchRefs,
} from "./sfx-core.mjs";

export {
  getSfxRefsStatus,
  setSfxRefsGlobalEnabled,
  addLocalDirRefLibrary,
  importUploadedRefLibrary,
  toggleRefLibrary,
  rescanRefLibrary,
  removeRefLibrary,
  searchRefs,
};

export const WS_DIR = join(ROOT, "workspace");
export const WS_FX_DIR = join(WS_DIR, "fx");
export const WS_SFX_DIR = join(WS_DIR, "sfx");
export const WS_AGENTS_DIR = join(WS_DIR, ".agents");
export const WS_STATE_DIR = join(WS_DIR, "state");
export const WS_META_FILE = join(WS_DIR, "workspace.json");
export const WS_ACTIVE_FILE = join(WS_STATE_DIR, "ui-context.json");
export const WS_LEGACY_ACTIVE_FILE = join(WS_DIR, "active-context.json");
export const WS_UI_CMD_FILE = join(WS_STATE_DIR, "ui-command.json");
export const WS_FEED_FILE = join(WS_STATE_DIR, "agent-feed.json");
export const WS_TASKS_FILE = join(WS_DIR, "tasks.json");
export const WS_HISTORY_DIR = join(WS_DIR, ".history");
const WS_LEGACY_AGENT_CFG_FILE = join(WS_DIR, ".agent-config.json");
const USER_VAULT_DIR = join(homedir(), ".pixelfx");
export const USER_AGENT_CFG_FILE = join(USER_VAULT_DIR, "agent-config.json");
const CUSTOM_META_FILE = join(ROOT, "gallery", "custom-meta.json");

export function ensureBaseDirs() {
  mkdirSync(WS_FX_DIR, { recursive: true });
  mkdirSync(WS_SFX_DIR, { recursive: true });
  mkdirSync(WS_HISTORY_DIR, { recursive: true });
  mkdirSync(WS_STATE_DIR, { recursive: true });
  mkdirSync(WS_AGENTS_DIR, { recursive: true });
  migrateLegacyRepoAgentConfig();
  const coreShimDir = join(WS_DIR, "core");
  mkdirSync(coreShimDir, { recursive: true });
  const coreShim = join(coreShimDir, "index.js");
  if (!existsSync(coreShim)) {
    writeFileSync(
      coreShim,
      '// Auto-generated bridge to src/core/index.js\nexport * from "../../src/core/index.js";\n',
      "utf8",
    );
  }
  const sfxShimDir = join(WS_DIR, "sfx-core");
  mkdirSync(sfxShimDir, { recursive: true });
  const sfxShim = join(sfxShimDir, "index.js");
  if (!existsSync(sfxShim)) {
    writeFileSync(
      sfxShim,
      '// Auto-generated read-only bridge to tools/lib/sfx-core.mjs\nexport * from "../../tools/lib/sfx-core.mjs";\n',
      "utf8",
    );
  }
}

export function ensureCategoryShims(cat, codeText = "") {
  ensureBaseDirs();
  const catDir = join(WS_FX_DIR, cat);
  mkdirSync(catDir, { recursive: true });

  // 若内置库该分类有 _lib.js，则在工作区同分类自动建立桥接模块，保证 Node 与浏览器一致解析
  const srcLib = join(FX_DIR, cat, "_lib.js");
  const wsLib = join(catDir, "_lib.js");
  if (existsSync(srcLib) && !existsSync(wsLib)) {
    writeFileSync(
      wsLib,
      `// Auto-generated bridge to src/fx/${cat}/_lib.js\nexport * from "../../../src/fx/${cat}/_lib.js";\n`,
      "utf8",
    );
  }

  // 若代码引用了跨分类内置模块（如 moves 引用 ../melee/sword-slash.js），自动在未覆盖时建立只读转发桥接
  if (codeText) {
    const relRe = /from\s+["']\.\.\/([a-z0-9-]+)\/([a-z0-9_-]+\.js)["']/g;
    let m;
    while ((m = relRe.exec(codeText))) {
      const [, refCat, refFile] = m;
      const srcTarget = join(FX_DIR, refCat, refFile);
      const wsTarget = join(WS_FX_DIR, refCat, refFile);
      if (existsSync(srcTarget) && !existsSync(wsTarget)) {
        mkdirSync(dirname(wsTarget), { recursive: true });
        writeFileSync(
          wsTarget,
          `// Auto-generated bridge to src/fx/${refCat}/${refFile}\nexport * from "../../../src/fx/${refCat}/${refFile}";\n`,
          "utf8",
        );
      }
    }
  }
}

function isBridgeShimFile(filePath) {
  try {
    const head = readFileSync(filePath, "utf8").slice(0, 120);
    return head.startsWith("// Auto-generated bridge to src/");
  } catch {
    return false;
  }
}

export function readWorkspaceManifest() {
  ensureBaseDirs();
  if (!existsSync(WS_META_FILE)) return { effects: {} };
  try {
    const parsed = JSON.parse(readFileSync(WS_META_FILE, "utf8"));
    return { effects: {}, ...parsed };
  } catch {
    return { effects: {} };
  }
}

export function writeWorkspaceManifest(data) {
  ensureBaseDirs();
  writeFileSync(WS_META_FILE, JSON.stringify(data, null, 2), "utf8");
}

export function allWorkspaceIds() {
  ensureBaseDirs();
  const out = [];
  for (const cat of readdirSync(WS_FX_DIR).sort()) {
    const d = join(WS_FX_DIR, cat);
    if (cat.startsWith("_") || cat.startsWith(".") || !statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".js") || f.startsWith("_")) continue;
      const full = join(d, f);
      if (isBridgeShimFile(full)) continue;
      out.push(`${cat}/${f.slice(0, -3)}`);
    }
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export async function loadWorkspaceModule(id) {
  const file = join(WS_FX_DIR, id + ".js");
  if (!existsSync(file)) throw new Error(`工作区不存在特效 ${id}`);
  const st = statSync(file);
  const code = readFileSync(file, "utf8");
  ensureCategoryShims(id.split("/")[0], code);
  const mod = await import(pathToFileURL(file).href + `?v=${st.mtimeMs}_${Math.random().toString(36).slice(2, 7)}`);
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
  return { id, file, mtimeMs: st.mtimeMs, mod: { ...mod, meta }, meta, code };
}

export async function listWorkspaceEffects() {
  const manifest = readWorkspaceManifest();
  const ids = allWorkspaceIds();
  const items = [];

  for (const id of ids) {
    const file = join(WS_FX_DIR, id + ".js");
    const st = statSync(file);
    const entry = manifest.effects[id] || {};
    try {
      const loaded = await loadWorkspaceModule(id);
      const sfxInfo = getEffectSfxInfo(id);
      items.push({
        id,
        cat: id.split("/")[0],
        mtimeMs: st.mtimeMs,
        meta: loaded.meta,
        hasAct: !!loaded.mod.act,
        zhName: entry.zhName || loaded.meta.name || id.split("/")[1],
        zhDesc: entry.zhDesc || loaded.meta.desc || "",
        baseId: entry.baseId || null,
        preset: entry.preset || null,
        activeSfxVariant: sfxInfo.activeVariant,
        sfxVariantCount: sfxInfo.variants.length,
        hasSfxScript: sfxInfo.hasScript,
        updatedAt: entry.updatedAt || new Date(st.mtimeMs).toISOString(),
        broken: false,
        error: null,
      });
    } catch (e) {
      items.push({
        id,
        cat: id.split("/")[0],
        mtimeMs: st.mtimeMs,
        meta: {
          name: entry.zhName || id.split("/")[1],
          desc: String(e.message || e),
          size: [128, 128],
          origin: [64, 96],
          duration: 1,
          loop: false,
          fps: 30,
          bg: "dark",
          tags: ["error"],
          options: {},
        },
        hasAct: false,
        zhName: entry.zhName || id.split("/")[1],
        zhDesc: entry.zhDesc || "代码存在语法或运行时错误，请在代码编辑器中修复。",
        baseId: entry.baseId || null,
        preset: entry.preset || null,
        updatedAt: new Date(st.mtimeMs).toISOString(),
        broken: true,
        error: String(e.message || e),
      });
    }
  }
  return items;
}

function saveSnapshot(id, code, tag = "edit") {
  const safeId = id.replace(/\//g, "__");
  const dir = join(WS_HISTORY_DIR, safeId);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${stamp}_${tag}.js`;
  writeFileSync(join(dir, file), code, "utf8");

  // 保留最近 20 个快照
  const all = readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  while (all.length > 20) {
    const old = all.shift();
    try { unlinkSync(join(dir, old)); } catch {}
  }
}

export function listEffectHistory(id) {
  const safeId = id.replace(/\//g, "__");
  const dir = join(WS_HISTORY_DIR, safeId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .reverse()
    .map((file) => {
      const st = statSync(join(dir, file));
      return { file, mtimeMs: st.mtimeMs, size: st.size };
    });
}

export async function restoreEffectHistory(id, historyFile) {
  const safeId = id.replace(/\//g, "__");
  const src = join(WS_HISTORY_DIR, safeId, historyFile);
  if (!existsSync(src)) throw new Error("未找到对应历史版本快照");
  const code = readFileSync(src, "utf8");
  return saveWorkspaceCode({ id, code, reason: "restore" });
}

export function uniqueWorkspaceId(desiredId) {
  let [cat, name] = desiredId.toLowerCase().split("/");
  cat = (cat || "arcane").replace(/[^a-z0-9-]/g, "");
  name = (name || "custom-fx").replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "custom-fx";
  let candidate = `${cat}/${name}`;
  let idx = 2;
  while (existsSync(join(WS_FX_DIR, candidate + ".js")) && !isBridgeShimFile(join(WS_FX_DIR, candidate + ".js"))) {
    candidate = `${cat}/${name}-v${idx++}`;
  }
  return candidate;
}

function buildStarterCode(id, { zhName, zhDesc, loop = false }) {
  const cat = id.split("/")[0];
  const engName = id.split("/")[1].replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  if (loop) {
    return `import { PAL, fit, at, cycle, TAU, WHITE } from "../../core/index.js";

export const meta = {
  name: ${JSON.stringify(engName)},
  desc: ${JSON.stringify(zhDesc || `${zhName || engName}：循环像素能量特效。`)},
  tags: [${JSON.stringify(cat)}, "loop", "custom"],
  size: [128, 128],
  origin: [64, 88],
  duration: 1.6,
  loop: true,
  fps: 24,
  bg: "dark",
  options: { palette: PAL.arcane, radius: 22, count: 18, seed: 7 },
};

export function draw(p, t, o) {
  const C = fit(o.palette, 8);
  const ph = t / meta.duration;
  const rad0 = o.radius ?? 22;

  // 地面透视光环与核心脉动
  const pulse = 1 + 0.14 * Math.sin(ph * TAU * 2);
  p.ellipse(0, 0, rad0 * pulse, rad0 * 0.28 * pulse, (d) => (d > 0.78 ? C[5] : d > 0.55 ? C[2] : 0));

  // 无缝循环螺旋粒子
  cycle(t, meta.duration, o.count ?? 18, o.seed, 0.85, (age, life, r) => {
    const k = age / life;
    const a = r.range(0, TAU) + k * 2.6;
    const rr = rad0 * (0.95 - 0.55 * k);
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr * 0.28 - k * 42;
    p.circle(x, y, (1 - k) * 1.8 + 0.6, k < 0.25 ? WHITE : at(C.slice(2), 1 - k));
    p.glow(x, y, 5, C[5], 0.25 * (1 - k));
  });

  p.circle(0, -18 + Math.sin(ph * TAU) * 2, 5.5 * pulse, C[5]);
  p.circle(-1, -19 + Math.sin(ph * TAU) * 2, 3 * pulse, WHITE);
  p.glow(0, -18, 32 * pulse, C[4], 0.42);
}
`;
  }

  return `import { Particles, Lights, P, Rng, PAL, fit, smooth, sparkle, WHITE, TAU } from "../../core/index.js";

export const meta = {
  name: ${JSON.stringify(engName)},
  desc: ${JSON.stringify(zhDesc || `${zhName || engName}：爆发像素打击特效。`)},
  tags: [${JSON.stringify(cat)}, "one-shot", "custom"],
  size: [128, 128],
  origin: [64, 92],
  duration: 1.0,
  loop: false,
  fps: 24,
  bg: "ground",
  options: { palette: PAL.water, power: 1, count: 32, seed: 12 },
};

export function create(o) {
  const C = fit(o.palette, 8);
  const R = new Rng(o.seed);
  const kPow = o.power ?? 1;
  const ps = new Particles({ rng: R, ground: () => 0 });
  const lights = new Lights();

  lights.add(0, -16, 48 * kPow, C[5], 0.8, 0.45);
  const n = Math.round((o.count ?? 32) * kPow);
  for (let i = 0; i < n; i++) {
    const a = R.range(0, TAU);
    const sp = R.range(55, 195) * kPow;
    ps.spawn(
      i % 5 === 0 ? P.STAR : P.SPARK,
      0,
      -14,
      Math.cos(a) * sp,
      Math.sin(a) * sp - 55,
      R.range(0.24, 0.68),
      i % 4 === 0 ? WHITE : C[5],
      R.range(1, 2.2),
    );
  }

  let t = 0;
  return {
    update(dt) {
      t += dt;
      ps.update(dt);
      lights.update(dt);
    },
    draw(p) {
      if (t >= meta.duration - 0.01) return;
      const fade = 1 - smooth(meta.duration - 0.18, meta.duration, t);
      if (t < 0.14) {
        const u = t / 0.14;
        p.circle(0, -14, 11 * (1 - u * 0.5) * kPow, u < 0.4 ? WHITE : C[6]);
        sparkle(p, 0, -14, 18 * (1 - u) * kPow, WHITE, C[5]);
      }
      if (t < 0.42) {
        const u = t / 0.42;
        const rx = (6 + 34 * u) * kPow;
        p.ellipse(0, 0, rx, rx * 0.24, (d) => (d > 0.82 ? C[6] : 0), (1 - u) * fade);
      }
      ps.draw(p);
      lights.draw(p);
    },
  };
}
`;
}

export async function createWorkspaceEffect({
  id,
  zhName,
  zhDesc,
  loop = false,
  cloneFrom = null,
  cloneSpace = "library",
  preset = null,
}) {
  const finalId = uniqueWorkspaceId(id);
  const [cat] = finalId.split("/");
  let code = "";
  let inheritedPreset = preset;

  if (cloneFrom) {
    const srcFile =
      cloneSpace === "workspace"
        ? join(WS_FX_DIR, cloneFrom + ".js")
        : join(FX_DIR, cloneFrom + ".js");
    if (!existsSync(srcFile)) throw new Error(`源特效 ${cloneFrom} 不存在`);
    code = readFileSync(srcFile, "utf8");
    if (cloneSpace === "workspace") {
      const m = readWorkspaceManifest();
      if (!inheritedPreset && m.effects[cloneFrom]?.preset) {
        inheritedPreset = { ...m.effects[cloneFrom].preset };
      }
    }
  } else {
    code = buildStarterCode(finalId, { zhName, zhDesc, loop });
  }

  ensureCategoryShims(cat, code);
  const targetFile = join(WS_FX_DIR, finalId + ".js");
  writeFileSync(targetFile, code, "utf8");
  saveSnapshot(finalId, code, cloneFrom ? "fork" : "init");

  const manifest = readWorkspaceManifest();
  const now = new Date().toISOString();
  manifest.effects[finalId] = {
    zhName: zhName || finalId.split("/")[1],
    zhDesc: zhDesc || "",
    baseId: cloneFrom || null,
    createdAt: now,
    updatedAt: now,
    ...(inheritedPreset ? { preset: inheritedPreset } : {}),
  };
  writeWorkspaceManifest(manifest);

  const check = await checkWorkspaceEffect(finalId);
  const list = await listWorkspaceEffects();
  return {
    ok: true,
    id: finalId,
    check,
    item: list.find((x) => x.id === finalId),
  };
}

export async function saveWorkspaceCode({ id, code, zhName, zhDesc, preset, reason = "save" }) {
  if (!id || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) {
    throw new Error(`特效 ID 格式不合法 (${id})，应为 category/kebab-name`);
  }
  const [cat] = id.split("/");
  ensureCategoryShims(cat, code);
  const file = join(WS_FX_DIR, id + ".js");
  if (existsSync(file) && !isBridgeShimFile(file)) {
    saveSnapshot(id, readFileSync(file, "utf8"), reason);
  }
  writeFileSync(file, code, "utf8");

  const manifest = readWorkspaceManifest();
  const prev = manifest.effects[id] || { createdAt: new Date().toISOString() };
  manifest.effects[id] = {
    ...prev,
    ...(zhName !== undefined ? { zhName } : {}),
    ...(zhDesc !== undefined ? { zhDesc } : {}),
    ...(preset !== undefined ? { preset: { ...(prev.preset || {}), ...preset } } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeWorkspaceManifest(manifest);

  const check = await checkWorkspaceEffect(id);
  const list = await listWorkspaceEffects();
  return {
    ok: check.errors.length === 0,
    id,
    check,
    item: list.find((x) => x.id === id),
  };
}

export async function tuneWorkspaceEffect({
  id,
  zhName,
  zhDesc,
  preset,
  autoForkFromLibrary = true,
}) {
  const wsFile = join(WS_FX_DIR, id + ".js");
  if ((!existsSync(wsFile) || isBridgeShimFile(wsFile)) && autoForkFromLibrary) {
    const libFile = join(FX_DIR, id + ".js");
    if (!existsSync(libFile)) throw new Error(`未找到特效 ${id}`);
    const code = readFileSync(libFile, "utf8");
    ensureCategoryShims(id.split("/")[0], code);
    writeFileSync(wsFile, code, "utf8");
    saveSnapshot(id, code, "autofork");
  }

  const manifest = readWorkspaceManifest();
  const prev = manifest.effects[id] || { createdAt: new Date().toISOString() };
  manifest.effects[id] = {
    ...prev,
    ...(zhName !== undefined ? { zhName } : {}),
    ...(zhDesc !== undefined ? { zhDesc } : {}),
    preset: {
      ...(prev.preset || {}),
      ...(preset || {}),
    },
    updatedAt: new Date().toISOString(),
  };
  writeWorkspaceManifest(manifest);

  const list = await listWorkspaceEffects();
  return { ok: true, id, item: list.find((x) => x.id === id) };
}

export function deleteWorkspaceEffect(id) {
  const file = join(WS_FX_DIR, id + ".js");
  if (existsSync(file)) {
    saveSnapshot(id, readFileSync(file, "utf8"), "deleted");
    unlinkSync(file);
  }
  const manifest = readWorkspaceManifest();
  delete manifest.effects[id];
  writeWorkspaceManifest(manifest);
  return { ok: true, id };
}

export async function publishWorkspaceToLibrary(id) {
  const wsFile = join(WS_FX_DIR, id + ".js");
  if (!existsSync(wsFile) || isBridgeShimFile(wsFile)) {
    throw new Error(`工作区不存在特效 ${id}`);
  }
  const check = await checkWorkspaceEffect(id);
  if (check.errors.length) {
    throw new Error(`特效存在错误，无法发布回内置库：${check.errors.join("；")}`);
  }

  const dstFile = join(FX_DIR, id + ".js");
  mkdirSync(dirname(dstFile), { recursive: true });
  copyFileSync(wsFile, dstFile);

  // 同步中文名称与描述至 gallery/custom-meta.json
  const manifest = readWorkspaceManifest();
  const entry = manifest.effects[id];
  if (entry?.zhName || entry?.zhDesc) {
    let cm = {};
    try { cm = JSON.parse(readFileSync(CUSTOM_META_FILE, "utf8")); } catch {}
    cm[id] = {
      name: entry.zhName || cm[id]?.name || id.split("/")[1],
      desc: entry.zhDesc || cm[id]?.desc || "",
    };
    writeFileSync(CUSTOM_META_FILE, JSON.stringify(cm, null, 2), "utf8");
  }

  // 重新生成 src/fx/index.js 与 docs/CATALOG.md
  const res = spawnSync(process.execPath, [join(ROOT, "tools", "index.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`索引重建失败: ${res.stderr || res.stdout}`);
  }
  return { ok: true, id, output: res.stdout.trim() };
}

// ---- 像素特效代码规范与画面边界检查器（移植增强自 tools/check.mjs） ----
export async function checkWorkspaceEffect(id) {
  const errors = [];
  const warnings = [];
  const stats = { maxPixels: 0, spillPixels: 0, medianMs: 0, bounds: null };

  const file = join(WS_FX_DIR, id + ".js");
  if (!existsSync(file)) {
    return { ok: false, errors: [`文件不存在: workspace/fx/${id}.js`], warnings, stats };
  }

  const src = readFileSync(file, "utf8");
  if (/\bMath\.random\s*\(/.test(src)) {
    errors.push("禁止使用 Math.random()，请改用 new Rng(o.seed) 或 rand() 以保证每帧确定性复现");
  }
  if (/\bDate\.now\s*\(|\bnew\s+Date\s*\(/.test(src)) {
    warnings.push("检测到 Date 时间调用，特效渲染应完全仅依赖传入的时间参数 t 与 dt");
  }

  try {
    const loaded = await loadWorkspaceModule(id);
    const { mod, meta } = loaded;

    if (!mod.meta) errors.push("缺少 export const meta 元数据导出");
    if (!mod.draw && !mod.create) errors.push("缺少 export function draw(p, t, o) 或 export function create(o)");
    if (!Array.isArray(meta.size) || meta.size.some((v) => !Number.isInteger(v) || v < 8 || v > 640)) {
      errors.push("meta.size 必须是 [宽, 高] 整数像素数组（范围 8..640）");
    }
    if (!Array.isArray(meta.origin) || meta.origin.length !== 2) {
      errors.push("meta.origin 必须是 [ox, oy] 锚点坐标");
    }
    if (!(meta.duration > 0 && meta.duration <= 20)) {
      errors.push("meta.duration 时长需在 0..20 秒之间");
    }
    if (meta.bg && !BACKDROPS.includes(meta.bg)) {
      warnings.push(`meta.bg ("${meta.bg}") 建议使用标准值: ${BACKDROPS.join(", ")}`);
    }
    if (errors.length) return { ok: false, errors, warnings, stats };

    // 实际离屏步进渲染全部帧，检查越界、空画布、尾帧残留、循环跳变与耗时
    const M = 24;
    const [W, H] = meta.size;
    const fw = W + M * 2;
    const fh = H + M * 2;
    const frame = createFrame(fw, fh, -M, -M);
    const n = Math.max(2, Math.min(180, Math.round(meta.duration * meta.fps)));
    const opts = { ...(meta.options ?? {}), seed: meta.options?.seed ?? 1 };
    if (meta.actor) opts.actor = stockActor(meta.actor === 2 ? 2 : 1);

    let maxPx = 0;
    let spill = 0;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const times = [];

    const inspectFrame = () => {
      let inCount = 0;
      let outCount = 0;
      for (let j = 0; j < frame.color.length; j++) {
        const c = frame.color[j];
        const l = frame.light[j] & 0xffffff;
        if (!(c >>> 24) && !l) continue;
        const x = (j % fw) - M;
        const y = ((j / fw) | 0) - M;
        const inside = x >= 0 && y >= 0 && x < W && y < H;
        if (c >>> 24) {
          bx0 = Math.min(bx0, x);
          bx1 = Math.max(bx1, x);
          by0 = Math.min(by0, y);
          by1 = Math.max(by1, y);
        }
        if (inside) inCount++;
        else if (c >>> 24) outCount++;
      }
      maxPx = Math.max(maxPx, inCount);
      spill = Math.max(spill, outCount);
      return inCount;
    };

    let lastFramePixels = 0;
    if (!mod.create) {
      for (let i = 0; i <= n; i++) {
        const t = meta.loop ? ((i % n) / n) * meta.duration : (i / n) * meta.duration;
        clearFrame(frame);
        const p = painterFor(frame);
        p.place(meta.origin[0], meta.origin[1]);
        const t0 = performance.now();
        if (mod.drawBack) mod.drawBack(p, t, opts);
        mod.draw(p, t, opts);
        times.push(performance.now() - t0);
        lastFramePixels = inspectFrame();
      }
    } else {
      const inst = createFx(mod, { x: meta.origin[0], y: meta.origin[1], ...opts });
      for (let i = 0; i <= n; i++) {
        if (i > 0) inst.update(meta.duration / n);
        clearFrame(frame);
        const t0 = performance.now();
        inst.draw(frame);
        times.push(performance.now() - t0);
        lastFramePixels = inspectFrame();
      }
    }

    // 若包含 act 角色动作编排，额外试跑一轮验证无异常并能正常结束
    if (mod.act) {
      const actInst = createAct(mod, { x: 120, y: 120 });
      const af = createFrame(320, 240);
      for (let i = 0; i < 450 && !actInst.done(); i++) {
        actInst.update(1 / 30);
        if (i % 6 === 0) actInst.draw(clearFrame(af));
      }
      if (!meta.loop && !actInst.done()) {
        warnings.push("act 角色动作编排在超时后仍未结束，请检查 poses 最后一帧时间戳");
      }
    }

    times.sort((a, b) => a - b);
    stats.maxPixels = maxPx;
    stats.spillPixels = spill;
    stats.medianMs = +(times[times.length >> 1] || 0).toFixed(2);
    if (bx0 <= bx1) stats.bounds = [bx0, by0, bx1, by1];

    if (maxPx === 0) errors.push("全程未绘制任何可见像素，请检查坐标与锚点 (0, 0)");
    if (spill > 8) {
      warnings.push(
        `有 ${spill} 个像素超出 ${W}×${H} 画布边界（实际范围 x:${bx0}..${bx1}, y:${by0}..${by1}），可适当增大画布或调整原点`,
      );
    }
    if (!meta.loop && lastFramePixels > 4) {
      warnings.push(`一次性特效在结束帧 (t = duration) 仍有 ${lastFramePixels} 个残留像素，建议做收尾消散`);
    }
    if (stats.medianMs > 5) {
      warnings.push(`单帧渲染中位耗时 ${stats.medianMs}ms 偏高，建议减少遍历区域或粒子数量`);
    }
  } catch (e) {
    errors.push(`运行时错误: ${String(e.message || e).split("\n")[0]}`);
  }

  return { ok: errors.length === 0, errors, warnings, stats };
}

// ---- 内置 AI Agent 模型配置、仓外加密存储与密钥脱敏引擎 ----
function deriveLocalVaultKey() {
  let uname = "local";
  try { uname = userInfo().username || "local"; } catch {}
  return scryptSync(`${hostname()}::${uname}::pixelfx-vault-v1`, "pixelfx-local-salt", 32);
}

function encryptSecret(plainText) {
  const txt = String(plainText || "");
  if (!txt) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveLocalVaultKey(), iv);
  const enc = Buffer.concat([cipher.update(txt, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decryptSecret(stored) {
  const s = String(stored || "");
  if (!s) return "";
  if (!s.startsWith("enc:v1:")) return s; // 兼容旧格式以便自动迁移升级
  try {
    const [, , ivB64, tagB64, dataB64] = s.split(":");
    const decipher = createDecipheriv("aes-256-gcm", deriveLocalVaultKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export function maskSecretKey(key) {
  const k = String(key || "").trim();
  if (!k) return "";
  if (k.length <= 8) return "••••••••";
  return `${k.slice(0, 3)}••••••••${k.slice(-2)}`;
}

export function maskEndpointUrl(urlStr) {
  const u = String(urlStr || "").trim();
  if (!u) return "";
  try {
    const parsed = new URL(u);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    // 对内网私有网关 IP 做脱敏展示，避免录屏或截图泄露内网地址
    if (/^(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(parsed.hostname)) {
      const portPart = parsed.port ? `:${parsed.port}` : "";
      return `${parsed.protocol}//***.***.***.***${portPart}${parsed.pathname.replace(/\/+$/, "")}`;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return u;
  }
}

function redactSensitiveText(text, cfg = {}) {
  let out = String(text || "");
  if (cfg.apiKey && cfg.apiKey.length >= 4) {
    out = out.split(cfg.apiKey).join("[REDACTED_KEY]");
  }
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{6,}|AIza[A-Za-z0-9_-]{8,})\b/g, "[REDACTED_KEY]");
  out = out.replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED_KEY]");
  out = out.replace(/([?&]key=)[^&\s"']+/gi, "$1[REDACTED_KEY]");
  out = out.replace(/\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}(?::\d+)?\b/g, "***.***.***.***");
  return out;
}

function writeVaultFile(data) {
  mkdirSync(USER_VAULT_DIR, { recursive: true });
  const payload = {
    provider: data.provider || "openai",
    baseUrl: data.baseUrl || "https://api.openai.com/v1",
    model: data.model || "gpt-4o",
    apiKeyEnc: data.apiKey ? encryptSecret(data.apiKey) : "",
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(USER_AGENT_CFG_FILE, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
}

// 启动时若发现旧版仓库内 workspace/.agent-config.json，自动迁移加密至用户主目录 ~/.pixelfx/ 并立即物理删除仓库内文件
export function migrateLegacyRepoAgentConfig() {
  if (!existsSync(WS_LEGACY_AGENT_CFG_FILE)) return;
  try {
    const legacy = JSON.parse(readFileSync(WS_LEGACY_AGENT_CFG_FILE, "utf8"));
    if (!existsSync(USER_AGENT_CFG_FILE) && (legacy.apiKey || legacy.baseUrl || legacy.model)) {
      writeVaultFile({
        provider: legacy.provider || "openai",
        baseUrl: legacy.baseUrl || "https://api.openai.com/v1",
        model: legacy.model || "gpt-4o",
        apiKey: decryptSecret(legacy.apiKeyEnc || legacy.apiKey || ""),
      });
    }
  } catch {}
  try {
    unlinkSync(WS_LEGACY_AGENT_CFG_FILE);
  } catch {}
}

export function getAgentConfig(includeSecret = false) {
  migrateLegacyRepoAgentConfig();
  const defaults = {
    provider: process.env.PIXELFX_PROVIDER || "openai",
    baseUrl: process.env.PIXELFX_BASE_URL || "https://api.openai.com/v1",
    model: process.env.PIXELFX_MODEL || "gpt-4o",
    apiKey: process.env.PIXELFX_API_KEY || "",
  };

  let raw = { ...defaults };
  if (existsSync(USER_AGENT_CFG_FILE)) {
    try {
      const disk = JSON.parse(readFileSync(USER_AGENT_CFG_FILE, "utf8"));
      const diskKey = decryptSecret(disk.apiKeyEnc ?? disk.apiKey ?? "");
      raw = {
        provider: process.env.PIXELFX_PROVIDER || disk.provider || defaults.provider,
        baseUrl: process.env.PIXELFX_BASE_URL || disk.baseUrl || defaults.baseUrl,
        model: process.env.PIXELFX_MODEL || disk.model || defaults.model,
        apiKey: process.env.PIXELFX_API_KEY || diskKey || "",
      };
    } catch {}
  }

  if (!includeSecret) {
    const fromEnv = Boolean(process.env.PIXELFX_API_KEY);
    return {
      provider: raw.provider,
      baseUrl: maskEndpointUrl(raw.baseUrl),
      model: raw.model,
      hasKey: Boolean(raw.apiKey),
      keySource: fromEnv ? "env" : raw.apiKey ? "vault" : "none",
      apiKeyMasked: maskSecretKey(raw.apiKey),
      storageHint: "~/.pixelfx/agent-config.json (AES-256-GCM 仓外加密存储)",
      apiKey: "",
    };
  }
  return raw;
}

export function saveAgentConfig(partial = {}) {
  migrateLegacyRepoAgentConfig();
  if (partial.clearKey) {
    try {
      if (existsSync(USER_AGENT_CFG_FILE)) unlinkSync(USER_AGENT_CFG_FILE);
      if (existsSync(WS_LEGACY_AGENT_CFG_FILE)) unlinkSync(WS_LEGACY_AGENT_CFG_FILE);
    } catch {}
    return getAgentConfig(false);
  }

  const prev = getAgentConfig(true);
  const incomingUrl = String(partial.baseUrl ?? "").trim().replace(/\/+$/, "");
  const keepPrevUrl = !incomingUrl || incomingUrl.includes("***");
  const incomingKey = String(partial.apiKey ?? "").trim();
  const keepPrevKey = !incomingKey || incomingKey.includes("••••") || incomingKey.includes("[REDACTED");

  const next = {
    provider: partial.provider || prev.provider,
    baseUrl: keepPrevUrl ? prev.baseUrl : incomingUrl,
    model: (partial.model ?? prev.model).trim() || prev.model,
    apiKey: keepPrevKey ? prev.apiKey : incomingKey,
  };
  writeVaultFile(next);
  return getAgentConfig(false);
}

const PIXELFX_SYSTEM_PROMPT = `你是 PixelFX 像素艺术游戏特效与专属配音专家 Agent。整个工程统一采用纯 JavaScript (ES Module)。你不仅能通过参数调优或编写双缓冲像素视觉特效（color 像素层 + light 加法发光层），还能针对每个特效的动作节奏独立编写专属 JS 配音脚本（生成当前特效的多个音效变种 .ogg）。

## 一、像素视觉特效规则与 API (import from "../../core/index.js")
1. 坐标系：局部锚点 (0, 0) 为特效原点（脚底/命中点/发射口），x 向右，y 向下（地面为 y=0，向上喷射 y 为负数），单位 1px。
2. 严禁使用 Math.random() 或 Date！所有随机数必须用 \`new Rng(o.seed)\`（方法：\`R.next()\`, \`R.range(a,b)\`, \`R.int(a,b)\`, \`R.chance(p)\`, \`R.sign()\`）或确定性哈希 \`rand(i, seed)\`。
3. 颜色系统：使用 \`const C = fit(o.palette, 8)\` 将调色板采样为暗->亮的 32位颜色数组，最亮高光可用 \`WHITE\`。平滑时间过渡用 \`smooth(t0, t1, t)\`、\`clamp(x, a, b)\`、\`ease.outQuart(u)\`、\`ease.inQuad(u)\`、\`noise(x, seed)\`、\`noise2(x, y, seed)\`、\`TAU\`。
4. 两种特效模式：
   - **模拟型（推荐用于爆发/打击/投射/法术）**：\`export function create(o)\` 返回 \`{ update(dt), draw(p), drawBack?(p) }\`。可用粒子与灯光：\`Particles\`, \`P\`, \`Lights\`, \`sparkle\`, \`flare\`, \`band\`, \`crystal\`。
   - **纯函数型（推荐用于无缝循环光环/法阵/火焰/生物）**：\`export function draw(p, t, o)\`，仅依赖相位 \`ph = t / meta.duration\`，循环粒子用 \`cycle(t, meta.duration, count, o.seed, lifeRatio, (age, life, r) => { ... })\`。
5. Painter \`p\` 常用方法：\`p.px\`, \`p.dot\`, \`p.blend\`, \`p.disc\`, \`p.line\`, \`p.beam\`, \`p.circle\`, \`p.ellipse\`, \`p.ring\`, \`p.rect\`, \`p.poly\`, \`p.shade(x0, y0, x1, y1, (x, y, out) => { out.c = color; out.a = 1; })\`, \`p.glow\`, \`p.glowLine\`, \`p.light\`。
6. 一次性特效在 \`t >= meta.duration\` 时必须清空不留残影；可选导出 \`export const act = { target: { x: 58 }, poses: [...], hits: [{ t, stop, shake, amp, push, straw, skin }] }\`。

## 二、专属特效配音与多变种生成规则 (当用户要求生成配音、调整音效或增加音效变种时使用 action: "write_sfx")
每个特效拥有自己独立的 ES Module 配音脚本 \`workspace/sfx/<category>/<name>.js\`，一特效一音效集，分类下拉选项就是**当前特效音效的多个不同听感变种**！
1. **核心原则（严禁套改固定模板 + 动态可选音效参考库）**：
   - 严禁修改任何预设基础设施、\`sfx-core/\`、\`tools/\`、\`.agents/\` 或用户参考库文件！
   - **音效参考库由用户动态开关管理，绝非强制内置**：
     - 若下方上下文提示 **「音效参考库状态: 已启用」** 并列出匹配的参考采样 ID，请使用 \`await refLayer(refId, begin, end, { low, high, semitones })\` 挑选 2~3 条参考音频做切片、移调与分频段提取，再与 \`sfx-core\` 程序化合成层叠加融合；
     - 若下方上下文提示 **「音效参考库状态: 未启用」**，则**严禁调用 \`refLayer\` 或 \`refSample\`**！请完全使用 \`sfx-core\` 的纯 JS DSP 原语（确定性噪声 \`sfxRng\`、零相位滤波 \`band\`/\`lowpass\`/\`highpass\`、多模态物理共鸣腔 \`resonate\`、包络扫频调制、奇次谐波触点 \`pixelTick\`、毫秒级对位 \`place\`）针对该特效的物理材质独立合成！
2. 必须先仔细阅读当前特效 JS 源码的 \`meta.duration\`、\`act.hits\` 时间戳与动画阶段，使配音瞬态与画面爆发帧严丝合缝（起音或命中点绝不留前导静音）。
3. 配音脚本导入方式（纯 JavaScript ES Module）：
\`\`\`js
import {
  RATE,          // 22050 Hz
  sfxRng,        // const R = sfxRng(seed); R.noise(len), R.normal(), R.range(a,b), R.chance(p)
  refLayer,      // 仅在参考库已启用时调用: await refLayer(refId, begin=0, end=null, { low=null, high=null, semitones=0 })
  refSample,     // 仅在参考库已启用时调用: await refSample(refId) -> 只读返回单声道 Float64Array 副本
  band,          // band(samples, lowHz, highHz)
  lowpass,       // lowpass(samples, cutoffHz)
  highpass,      // highpass(samples, cutoffHz)
  edgeFade,      // edgeFade(samples, attack=0.0007, release=0.025)
  fit,           // fit(samples, duration, release=0.04) 定长裁剪收尾
  splice,        // splice(samples, beginS, endS, overlap=0.012)
  place,         // place(destFloat64Array, fragment, offsetSeconds, gain=1.0) 按秒精确对位叠加
  pitchShift,    // pitchShift(samples, semitones)
  normLayer,     // normLayer(samples, { low=null, high=null, release=0.025 })
  resonate,      // resonate(excitation, [[freq, q, gain], ...], decay=0.12) iirpeak 窄带物理谐振
  pixelTick,     // pixelTick(duration=0.022, frequency=440) 命中瞬间像素短触点
  compileEffectVariants,
} from "../../sfx-core/index.js";
\`\`\`
4. 脚本末尾顶层调用 \`await compileEffectVariants(targetId, variantsObj)\`，注意 \`samples\` 直接传入函数引用（如 \`samples: buildDefault\`，不要加括号调用），为当前特效独立编排 **3 个听感层次鲜明的变种**：
\`\`\`js
await compileEffectVariants("category/name", {
  default: {
    label: "标准变种中文名 (默认)",
    desc: "简述声学层次与关键帧对位设计",
    samples: buildDefault,
    targetDb: -16.5,
    texture: 0.15,
    cues: [{ t: 0.12, kind: "hit" }],
  },
  heavy: { label: "...", desc: "...", samples: buildHeavy, targetDb: -16.0, texture: 0.2, cues: [...] },
  bright: { label: "...", desc: "...", samples: buildBright, targetDb: -16.8, texture: 0.12, cues: [...] },
});
\`\`\`

## 三、输出格式要求（严格只输出一个合法 JSON 对象，不要包含额外解释文本）
{
  "action": "tune" | "edit_code" | "create_code" | "write_sfx",
  "targetId": "category/kebab-name",
  "zhName": "特效中文名（可选）",
  "zhDesc": "一句生动的中文视觉表现描述（可选）",
  "explanation": "向用户简要说明你做了哪些视觉调整或设计了哪几个专属音效变种",
  "selectVariant": "当生成或新增音效变种时，默认激活的变种 key（如 default）",
  "preset": { ... },
  "code": "当创建或修改视觉特效 JS 代码时提供完整 ES Module JS 源码；纯配音任务省略",
  "sfxCode": "当 action 为 write_sfx（或同时生成配音）时，提供完整的 ES Module JS 专属配音脚本源码字符串"
}`;

// 字符串感知的平衡大括号 JSON 扫描器：彻底杜绝代理网关拼接流式块 {...}{...} 或尾部多余字符导致的 JSON.parse 报错
function scanBalancedJsonObjects(text) {
  const results = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          const slice = text.slice(start, i + 1);
          try {
            results.push(JSON.parse(slice));
          } catch {}
          start = -1;
        }
      }
    }
  }
  return results;
}

function parseProviderHttpBody(rawBody, provider) {
  const trimmed = rawBody.trim();
  if (!trimmed) return "";

  // 1. 标准单 JSON 响应
  try {
    const single = JSON.parse(trimmed);
    if (provider === "gemini") {
      return single.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    }
    if (provider === "anthropic") {
      return single.content?.map((c) => c.text || "").join("") || "";
    }
    return single.choices?.[0]?.message?.content ?? single.choices?.[0]?.delta?.content ?? "";
  } catch {}

  // 2. 兼容强制返回 SSE (data: {...}) 或拼接多块 NDJSON ({...}{...}) 的中转网关
  const objs = scanBalancedJsonObjects(trimmed);
  if (!objs.length) {
    throw new Error(`接口返回内容不是有效 JSON: ${trimmed.slice(0, 180)}`);
  }

  let acc = "";
  for (const obj of objs) {
    if (obj.error?.message) throw new Error(obj.error.message);
    if (provider === "gemini") {
      acc += obj.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    } else if (provider === "anthropic") {
      if (obj.delta?.text) acc += obj.delta.text;
      else if (Array.isArray(obj.content)) acc += obj.content.map((c) => c.text || "").join("");
    } else {
      const c = obj.choices?.[0];
      if (c?.delta?.content) acc += c.delta.content;
      else if (c?.message?.content) acc += c.message.content;
    }
  }
  return acc;
}

async function callLLMProvider(cfg, systemPrompt, userMessage, historyMsgs = []) {
  if (!cfg.apiKey && !cfg.baseUrl.includes("localhost") && !cfg.baseUrl.includes("127.0.0.1")) {
    throw new Error("尚未配置大模型 API Key，请先点击「配置 API Key」填写密钥。");
  }

  const cleanHistory = Array.isArray(historyMsgs)
    ? historyMsgs
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .slice(-10)
    : [];

  try {
    if (cfg.provider === "gemini") {
      const base = cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
      const url = `${base}/models/${encodeURIComponent(cfg.model)}:generateContent`;
      const contents = [
        ...cleanHistory.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        { role: "user", parts: [{ text: userMessage }] },
      ];
      const headers = { "content-type": "application/json" };
      if (cfg.apiKey) headers["x-goog-api-key"] = cfg.apiKey;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
        }),
      });
      const raw = await resp.text();
      if (!resp.ok) throw new Error(`Gemini API 请求失败 (${resp.status}): ${raw.slice(0, 240)}`);
      return parseProviderHttpBody(raw, "gemini");
    }

    if (cfg.provider === "anthropic") {
      const base = cfg.baseUrl || "https://api.anthropic.com/v1";
      const resp = await fetch(`${base}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: cfg.model || "claude-sonnet-4-20250514",
          max_tokens: 4096,
          temperature: 0.4,
          stream: false,
          system: systemPrompt,
          messages: [...cleanHistory, { role: "user", content: userMessage }],
        }),
      });
      const raw = await resp.text();
      if (!resp.ok) throw new Error(`Claude API 请求失败 (${resp.status}): ${raw.slice(0, 240)}`);
      return parseProviderHttpBody(raw, "anthropic");
    }

    // 默认 OpenAI 兼容接口 (OpenAI / DeepSeek / Qwen / OpenRouter / Ollama)
    const base = cfg.baseUrl || "https://api.openai.com/v1";
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const headers = { "content-type": "application/json" };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model || "gpt-4o",
        temperature: 0.4,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          ...cleanHistory,
          { role: "user", content: userMessage },
        ],
      }),
    });
    const raw = await resp.text();
    if (!resp.ok) throw new Error(`模型接口请求失败 (${resp.status}): ${raw.slice(0, 240)}`);
    return parseProviderHttpBody(raw, "openai");
  } catch (err) {
    throw new Error(redactSensitiveText(err?.message || err, cfg));
  }
}

function extractJsonPayload(raw) {
  // 移除思考标签 <think>...</think>
  const cleaned = String(raw || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}

  const jsonFence = cleaned.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFence) {
    try { return JSON.parse(jsonFence[1].trim()); } catch {}
    const inner = scanBalancedJsonObjects(jsonFence[1]);
    if (inner.length) return inner[0];
  }

  const candidates = scanBalancedJsonObjects(cleaned);
  const hit =
    candidates.find((o) => o && (o.action || o.code || o.sfxCode || o.preset || o.targetId)) ||
    candidates[0];

  if (hit) {
    // 若模型把 JS 代码块放在了 JSON 后面，自动根据 action 合并补齐
    if (!hit.code && !hit.sfxCode) {
      const jsFence = cleaned.match(/```(?:js|javascript)\s*([\s\S]*?)```/i);
      if (jsFence) {
        if (hit.action === "write_sfx" || jsFence[1].includes("compileEffectVariants")) {
          hit.sfxCode = jsFence[1].trim();
        } else {
          hit.code = jsFence[1].trim();
        }
      }
    }
    return hit;
  }

  // 兜底：若模型直接返回了一段 ```js 代码块而没有包裹 JSON
  const bareJs = cleaned.match(/```(?:js|javascript)\s*([\s\S]*?)```/i);
  if (bareJs) {
    const body = bareJs[1].trim();
    if (body.includes("compileEffectVariants") || body.includes("sfx-core")) {
      return {
        action: "write_sfx",
        sfxCode: body,
        explanation: "已提取生成的专属配音脚本并编译多变种音效。",
      };
    }
    return { action: "edit_code", code: body, explanation: "已提取生成的特效源码并热重载。" };
  }

  throw new Error("模型返回内容未能解析出有效的特效 JSON 或代码");
}

// ---- 内置 AI 对话回撤检查点栈 (Undo Checkpoint Stack) ----
const AI_CHECKPOINTS_FILE = join(WS_HISTORY_DIR, "ai-checkpoints.json");
const SFX_CP_DIR = join(WS_HISTORY_DIR, "sfx-cp");

export function readAgentCheckpoints() {
  ensureBaseDirs();
  if (!existsSync(AI_CHECKPOINTS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(AI_CHECKPOINTS_FILE, "utf8"));
    return Array.isArray(parsed.stack) ? parsed.stack : [];
  } catch {
    return [];
  }
}

function pushAgentCheckpoint(cp) {
  const stack = readAgentCheckpoints();
  stack.push(cp);
  writeFileSync(AI_CHECKPOINTS_FILE, JSON.stringify({ stack: stack.slice(-30) }, null, 2), "utf8");
  return cp;
}

export function clearAgentCheckpoints() {
  ensureBaseDirs();
  writeFileSync(AI_CHECKPOINTS_FILE, JSON.stringify({ stack: [] }, null, 2), "utf8");
  return { ok: true };
}

function backupSfxOutputsForCheckpoint(checkpointId, effectId) {
  const outDir = join(WS_SFX_DIR, effectId);
  if (!existsSync(outDir)) return false;
  const files = readdirSync(outDir).filter((f) => f.endsWith(".ogg") || f === "manifest.json");
  if (!files.length) return false;
  const dstDir = join(SFX_CP_DIR, checkpointId);
  mkdirSync(dstDir, { recursive: true });
  for (const f of files) {
    copyFileSync(join(outDir, f), join(dstDir, f));
  }
  return true;
}

function restoreSfxOutputsFromCheckpoint(checkpointId, effectId, hadOutputsBefore) {
  const outDir = join(WS_SFX_DIR, effectId);
  if (!hadOutputsBefore) {
    if (existsSync(outDir)) {
      try { rmSync(outDir, { recursive: true, force: true }); } catch {}
    }
    return;
  }
  const srcDir = join(SFX_CP_DIR, checkpointId);
  if (!existsSync(srcDir)) return;
  if (existsSync(outDir)) {
    try { rmSync(outDir, { recursive: true, force: true }); } catch {}
  }
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(srcDir)) {
    copyFileSync(join(srcDir, f), join(outDir, f));
  }
}

/**
 * 回撤到指定 checkpointId 之前的状态（若不传 checkpointId 则默认撤回最近一步）。
 * 若中间有多轮对话修改，按后进先出 (LIFO) 顺序逐一精准还原视觉源码、配音脚本、多变种 OGG 与预设！
 */
export async function undoAgentCheckpoint(targetCheckpointId = null) {
  const stack = readAgentCheckpoints();
  if (!stack.length) throw new Error("当前没有可撤回的 AI 操作记录");

  const idx = targetCheckpointId
    ? stack.findIndex((c) => c.checkpointId === targetCheckpointId)
    : stack.length - 1;
  if (idx < 0) throw new Error("未找到对应的对话回撤节点");

  const toRevert = stack.slice(idx).reverse();
  const remaining = stack.slice(0, idx);
  const manifest = readWorkspaceManifest();

  for (const cp of toRevert) {
    const file = join(WS_FX_DIR, cp.targetId + ".js");
    if (!cp.prevFileExisted) {
      if (existsSync(file) && !isBridgeShimFile(file)) {
        try { unlinkSync(file); } catch {}
      }
    } else if (typeof cp.prevCode === "string") {
      ensureCategoryShims(cp.targetId.split("/")[0], cp.prevCode);
      writeFileSync(file, cp.prevCode, "utf8");
    }

    if (cp.sfxTouched) {
      const sfxJsFile = join(WS_SFX_DIR, cp.targetId + ".js");
      if (!cp.prevSfxFileExisted) {
        if (existsSync(sfxJsFile)) {
          try { unlinkSync(sfxJsFile); } catch {}
        }
      } else if (typeof cp.prevSfxCode === "string") {
        mkdirSync(dirname(sfxJsFile), { recursive: true });
        writeFileSync(sfxJsFile, cp.prevSfxCode, "utf8");
      }
      restoreSfxOutputsFromCheckpoint(cp.checkpointId, cp.targetId, !!cp.prevSfxHadOutputs);
    }

    if (cp.prevManifestEntry) {
      manifest.effects[cp.targetId] = cp.prevManifestEntry;
    } else {
      delete manifest.effects[cp.targetId];
    }
  }

  writeWorkspaceManifest(manifest);
  writeFileSync(AI_CHECKPOINTS_FILE, JSON.stringify({ stack: remaining }, null, 2), "utf8");

  const earliestReverted = toRevert[toRevert.length - 1];
  return {
    ok: true,
    undoneCount: toRevert.length,
    checkpointId: earliestReverted.checkpointId,
    restoredSpace: earliestReverted.prevSpace || "workspace",
    restoredId: earliestReverted.prevId || null,
    restoredCfg: earliestReverted.prevCfg || null,
    restoredPrompt: earliestReverted.prompt || "",
    remainingCount: remaining.length,
  };
}

export async function runWorkspaceAgentChat({ prompt, currentId, currentSpace, currentCfg, history = [] }) {
  const llmCfg = getAgentConfig(true);

  let currentCode = "";
  let currentSfxCode = "";
  let checkInfo = null;
  let fxSearchTerms = "";
  if (currentId) {
    const f =
      currentSpace === "workspace" && existsSync(join(WS_FX_DIR, currentId + ".js"))
        ? join(WS_FX_DIR, currentId + ".js")
        : join(FX_DIR, currentId + ".js");
    if (existsSync(f)) currentCode = readFileSync(f, "utf8");
    const sfxJs = join(WS_SFX_DIR, currentId + ".js");
    if (existsSync(sfxJs)) currentSfxCode = readFileSync(sfxJs, "utf8");
    if (currentSpace === "workspace") {
      checkInfo = await checkWorkspaceEffect(currentId);
    }
    fxSearchTerms = currentId.replace(/[/-]/g, " ");
    const tagMatch = currentCode.match(/tags\s*:\s*\[([^\]]+)\]/);
    if (tagMatch) fxSearchTerms += " " + tagMatch[1].replace(/["',]/g, " ");
  }

  // 动态检查用户音效参考库启用状态（仅在用户开启且有可用参考音频时注入参考采样候选）
  const refsStatus = getSfxRefsStatus();
  let refsHintBlock =
    "音效参考库状态: 未启用（用户当前未开启音效参考库，严禁调用 refLayer/refSample，请完全使用 sfx-core 纯 JS 原语独立程序化合成）";
  if (refsStatus.active) {
    const matchedRefs = searchRefs(`${fxSearchTerms} ${prompt}`, { limit: 20 });
    const sampleRefs = matchedRefs.length ? matchedRefs : searchRefs("", { limit: 16 });
    refsHintBlock = sampleRefs.length
      ? `音效参考库状态: 已启用 (${refsStatus.activeLibraryCount} 个启用库 / 共 ${refsStatus.activeSoundCount} 条音频)。匹配的只读参考采样候选 (可通过 \`await refLayer("<id>", begin, end, opts)\` 分层混音并结合 AI 合成):\n` +
        sampleRefs.map((r) => `- "${r.id}" (${r.duration}s, peak@${r.peakTime}s)`).join("\n")
      : `音效参考库状态: 已启用 (${refsStatus.activeLibraryCount} 个库)，请结合 sfx-core 合成。`;
  }

  const contextBlock = [
    `当前选中空间: ${currentSpace} (${currentSpace === "library" ? "只读内置库，修改代码或生成专属配音时会自动转入工作区" : "可写创作工作区"})`,
    `当前特效 ID: ${currentId || "无"}`,
    `当前界面参数: ${JSON.stringify(currentCfg || {})}`,
    checkInfo ? `当前代码诊断结果: ${JSON.stringify(checkInfo)}` : "",
    currentCode ? `当前特效视觉源码 (JS):\n\`\`\`js\n${currentCode}\n\`\`\`` : "",
    currentSfxCode ? `当前特效已有专属配音源码 (JS):\n\`\`\`js\n${currentSfxCode}\n\`\`\`` : "当前特效尚无专属配音脚本。",
    refsHintBlock,
    `\n用户需求指令:\n${prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  let rawReply = await callLLMProvider(llmCfg, PIXELFX_SYSTEM_PROMPT, contextBlock, history);
  let plan = extractJsonPayload(rawReply);

  const action =
    plan.action ||
    (plan.sfxCode && !plan.code ? "write_sfx" : plan.code ? "edit_code" : "tune");
  let targetId = (plan.targetId || currentId || "arcane/agent-fx").toLowerCase();
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(targetId)) targetId = currentId || "arcane/agent-fx";
  if (action === "create_code") {
    targetId = uniqueWorkspaceId(targetId);
  }

  // 在真正改动工作区文件与 manifest 前，记录完整快照用于一键 Undo 回撤
  const checkpointId = "CP-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  const targetFileBefore = join(WS_FX_DIR, targetId + ".js");
  const prevFileExisted = existsSync(targetFileBefore) && !isBridgeShimFile(targetFileBefore);
  const sfxFileBefore = join(WS_SFX_DIR, targetId + ".js");
  const prevSfxFileExisted = existsSync(sfxFileBefore);
  const sfxTouched = Boolean(action === "write_sfx" || plan.sfxCode);
  const prevSfxHadOutputs = sfxTouched ? backupSfxOutputsForCheckpoint(checkpointId, targetId) : false;
  const prevManifest = readWorkspaceManifest();

  const checkpoint = pushAgentCheckpoint({
    checkpointId,
    createdAt: new Date().toISOString(),
    prompt,
    action,
    targetId,
    prevSpace: currentSpace || "workspace",
    prevId: currentId || null,
    prevCfg: currentCfg || null,
    prevFileExisted,
    prevCode: prevFileExisted ? readFileSync(targetFileBefore, "utf8") : null,
    sfxTouched,
    prevSfxFileExisted,
    prevSfxCode: prevSfxFileExisted ? readFileSync(sfxFileBefore, "utf8") : null,
    prevSfxHadOutputs,
    prevManifestEntry: prevManifest.effects[targetId]
      ? JSON.parse(JSON.stringify(prevManifest.effects[targetId]))
      : null,
  });

  // 分支 1：纯专属配音脚本生成与多变种编译 (write_sfx)
  if (action === "write_sfx" && !plan.code) {
    if (!plan.sfxCode) {
      throw new Error("模型未返回有效的 JS 配音脚本 (sfxCode)");
    }
    let sfxSaved;
    try {
      sfxSaved = await saveEffectSfxCode({
        id: targetId,
        code: plan.sfxCode,
        selectVariant: plan.selectVariant || null,
        autoForkFromLibrary: true,
        reason: "agent-sfx",
      });
    } catch (sfxErr) {
      // 自动进行 1 轮配音脚本报错自我修复闭环
      const fixPrompt = `${contextBlock}\n\n你刚才生成的 JS 配音脚本运行报错，错误信息如下：\n${String(sfxErr.message || sfxErr)}\n\n请确保 await compileEffectVariants 的第一个参数严格为 "${targetId}"，修复上述错误并重新输出完整合法的 JSON 对象（包含修正后的完整 sfxCode）。`;
      rawReply = await callLLMProvider(llmCfg, PIXELFX_SYSTEM_PROMPT, fixPrompt, history);
      plan = extractJsonPayload(rawReply);
      if (!plan.sfxCode) throw sfxErr;
      sfxSaved = await saveEffectSfxCode({
        id: targetId,
        code: plan.sfxCode,
        selectVariant: plan.selectVariant || null,
        autoForkFromLibrary: true,
        reason: "agent-sfx-fix",
      });
    }

    const list = await listWorkspaceEffects();
    return {
      ok: true,
      action: "write_sfx",
      id: targetId,
      checkpointId: checkpoint.checkpointId,
      explanation:
        plan.explanation ||
        `已为 ${targetId} 编写专属配音脚本并编译 ${sfxSaved.sfx.variants.length} 个音效变种。`,
      sfx: sfxSaved.sfx,
      item: list.find((x) => x.id === targetId),
    };
  }

  // 分支 2：仅参数调优 (tune)
  if (action === "tune" && !plan.code) {
    const res = await tuneWorkspaceEffect({
      id: targetId,
      zhName: plan.zhName,
      zhDesc: plan.zhDesc,
      preset: plan.preset || {},
      autoForkFromLibrary: true,
    });
    return {
      ok: true,
      action: "tune",
      id: res.id,
      checkpointId: checkpoint.checkpointId,
      explanation: plan.explanation || "已完成特效参数动态调优。",
      item: res.item,
    };
  }

  // 分支 3：创建或修改视觉特效代码 (create_code / edit_code)，可选同时附带专属配音 sfxCode
  let saved = await saveWorkspaceCode({
    id: targetId,
    code: plan.code,
    zhName: plan.zhName,
    zhDesc: plan.zhDesc,
    preset: plan.preset,
    reason: "agent",
  });

  if (saved.check.errors.length > 0) {
    const fixPrompt = `${contextBlock}\n\n你刚才生成的 JS 代码校验未通过，错误信息如下：\n${saved.check.errors.join("\n")}\n\n请修复上述错误并重新输出完整合法的 JSON 对象（包含修正后的完整 code）。`;
    rawReply = await callLLMProvider(llmCfg, PIXELFX_SYSTEM_PROMPT, fixPrompt, history);
    plan = extractJsonPayload(rawReply);
    if (plan.code) {
      saved = await saveWorkspaceCode({
        id: targetId,
        code: plan.code,
        zhName: plan.zhName,
        zhDesc: plan.zhDesc,
        preset: plan.preset,
        reason: "agent-fix",
      });
    }
  }

  let sfxOut = null;
  if (plan.sfxCode) {
    try {
      const r = await saveEffectSfxCode({
        id: targetId,
        code: plan.sfxCode,
        selectVariant: plan.selectVariant || null,
        autoForkFromLibrary: false,
        reason: "agent-sfx",
      });
      sfxOut = r.sfx;
    } catch {}
  }

  return {
    ok: saved.check.errors.length === 0,
    action,
    id: saved.id,
    checkpointId: checkpoint.checkpointId,
    explanation: plan.explanation || "已完成特效代码生成并热加载到工作区。",
    check: saved.check,
    ...(sfxOut ? { sfx: sfxOut } : {}),
    item: saved.item,
  };
}

// ---- 外部 Agent 待办任务单队列 (workspace/tasks.json) ----
export function listAgentTasks() {
  ensureBaseDirs();
  if (!existsSync(WS_TASKS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(WS_TASKS_FILE, "utf8"));
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch {
    return [];
  }
}

export function enqueueAgentTask({ prompt, targetId, space, zhName, cfg }) {
  const tasks = listAgentTasks();
  const item = {
    taskId: "T-" + Date.now().toString(36).slice(-5).toUpperCase(),
    status: "pending", // "pending" | "done"
    prompt: String(prompt || "").trim(),
    targetId: targetId || null,
    space: space || "workspace",
    zhName: zhName || "",
    cfg: cfg || {},
    createdAt: new Date().toISOString(),
    resultId: null,
    note: "",
  };
  tasks.unshift(item);
  writeFileSync(WS_TASKS_FILE, JSON.stringify({ tasks: tasks.slice(0, 30) }, null, 2), "utf8");
  return item;
}

export function updateAgentTask({ taskId, status = "done", resultId = null, note = "" }) {
  const tasks = listAgentTasks();
  const hit = tasks.find((t) => t.taskId === taskId);
  if (!hit) throw new Error(`未找到任务 ${taskId}`);
  hit.status = status;
  if (resultId) hit.resultId = resultId;
  if (note) hit.note = note;
  hit.completedAt = new Date().toISOString();
  writeFileSync(WS_TASKS_FILE, JSON.stringify({ tasks }, null, 2), "utf8");
  return hit;
}

export function clearCompletedTasks() {
  const tasks = listAgentTasks().filter((t) => t.status !== "done");
  writeFileSync(WS_TASKS_FILE, JSON.stringify({ tasks }, null, 2), "utf8");
  return tasks;
}

// ---- AI Harness 工作区目录 (.agents 技能树 + 实时事件流) ----
function walkRelFiles(baseDir, sub = "") {
  const out = [];
  const fullDir = sub ? join(baseDir, sub) : baseDir;
  if (!existsSync(fullDir)) return out;
  for (const name of readdirSync(fullDir).sort()) {
    const rel = sub ? `${sub}/${name}` : name;
    const fp = join(baseDir, rel);
    const st = statSync(fp);
    if (st.isDirectory()) {
      out.push(...walkRelFiles(baseDir, rel));
    } else {
      out.push({
        relPath: `.agents/${rel}`,
        kind: rel.endsWith("SKILL.md")
          ? "skill"
          : rel.startsWith("rules/")
            ? "rule"
            : rel.includes("/scripts/")
              ? "script"
              : "ref",
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  return out;
}

export function readAgentFeed() {
  if (!existsSync(WS_FEED_FILE)) return [];
  try {
    return JSON.parse(readFileSync(WS_FEED_FILE, "utf8")).events || [];
  } catch {
    return [];
  }
}

export function getHarnessDirectoryInfo() {
  ensureBaseDirs();
  const dotFiles = walkRelFiles(WS_AGENTS_DIR);
  const agentsMd = join(WS_DIR, "AGENTS.md");
  if (existsSync(agentsMd)) {
    const st = statSync(agentsMd);
    dotFiles.unshift({ relPath: "AGENTS.md", kind: "entry", size: st.size, mtimeMs: st.mtimeMs });
  }
  return {
    workspaceDir: WS_DIR,
    dotAgentsDir: WS_AGENTS_DIR,
    files: dotFiles,
    feed: readAgentFeed(),
  };
}

export function readHarnessFile(relPath) {
  const safe = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (safe !== "AGENTS.md" && !safe.startsWith(".agents/")) {
    throw new Error("仅允许访问工作区 AGENTS.md 或 .agents/ 下的文件");
  }
  const full = join(WS_DIR, safe);
  if (!full.startsWith(WS_DIR) || !existsSync(full)) {
    throw new Error(`文件不存在: ${safe}`);
  }
  return { relPath: safe, content: readFileSync(full, "utf8") };
}

export function saveHarnessFile() {
  throw new Error("为保护预设技能规范与基础架构不被篡改，AGENTS.md 与 .agents/ 目录已锁定为只读。");
}

// ---- 专属特效配音与多变种管理引擎 (AI Agent 独立编写 sfx/<cat>/<name>.js -> 多变种 .ogg) ----
function saveSfxScriptSnapshot(id, code, tag = "sfx-edit") {
  const safeId = id.replace(/\//g, "__");
  const dir = join(WS_HISTORY_DIR, safeId);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(dir, `${stamp}_${tag}.sfx.js`), code, "utf8");
}

export function getEffectSfxInfo(id) {
  if (!id || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) {
    return { ok: false, id, hasScript: false, scriptPath: null, activeVariant: null, variants: [] };
  }
  ensureBaseDirs();
  const scriptFile = join(WS_SFX_DIR, id + ".js");
  const hasScript = existsSync(scriptFile);
  const manifestFile = join(WS_SFX_DIR, id, "manifest.json");
  let variants = [];
  if (existsSync(manifestFile)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestFile, "utf8"));
      if (Array.isArray(parsed.variants)) {
        variants = parsed.variants.filter((v) => v && v.id && existsSync(join(WS_SFX_DIR, id, `${v.id}.ogg`)));
      }
    } catch {}
  }

  const wsManifest = readWorkspaceManifest();
  const preferred = wsManifest.effects[id]?.activeSfxVariant || null;
  const activeVariant =
    variants.find((v) => v.id === preferred)?.id ||
    variants[0]?.id ||
    null;

  return {
    ok: true,
    id,
    hasScript,
    scriptPath: hasScript ? `workspace/sfx/${id}.js` : `workspace/sfx/${id}.js (待生成)`,
    activeVariant,
    variants,
  };
}

export function readEffectSfxSource(id) {
  if (!id || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) {
    throw new Error(`非法特效 ID: ${id}`);
  }
  const scriptFile = join(WS_SFX_DIR, id + ".js");
  if (!existsSync(scriptFile)) {
    return { ok: true, id, exists: false, code: "" };
  }
  return { ok: true, id, exists: true, code: readFileSync(scriptFile, "utf8") };
}

export async function compileEffectSfxScript(id, selectVariant = null) {
  if (!id || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) {
    throw new Error(`非法特效 ID: ${id}`);
  }
  ensureBaseDirs();
  const scriptFile = join(WS_SFX_DIR, id + ".js");
  if (!existsSync(scriptFile)) {
    throw new Error(`尚未找到特效 ${id} 的专属配音脚本 workspace/sfx/${id}.js`);
  }

  const stdoutStr = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptFile], { cwd: ROOT });
    const outChunks = [];
    const errChunks = [];
    child.stdout.on("data", (d) => outChunks.push(d));
    child.stderr.on("data", (d) => errChunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(errChunks).toString("utf8").trim() || `配音脚本退出码 ${code}`));
      } else {
        resolve(Buffer.concat(outChunks).toString("utf8").trim());
      }
    });
  });

  const info = getEffectSfxInfo(id);
  if (!info.variants.length) {
    throw new Error(`脚本运行完成但未在 workspace/sfx/${id}/manifest.json 生成任何有效变种，请确认脚本调用了 await compileEffectVariants("${id}", ...)`);
  }

  if (selectVariant || info.activeVariant) {
    const chosen =
      (selectVariant && info.variants.find((v) => v.id === selectVariant)?.id) ||
      info.activeVariant;
    const wsManifest = readWorkspaceManifest();
    const prev = wsManifest.effects[id] || { createdAt: new Date().toISOString() };
    wsManifest.effects[id] = {
      ...prev,
      activeSfxVariant: chosen,
      updatedAt: new Date().toISOString(),
    };
    writeWorkspaceManifest(wsManifest);
    info.activeVariant = chosen;
  }

  return { ok: true, id, stdout: stdoutStr, sfx: info };
}

export async function saveEffectSfxCode({
  id,
  code,
  selectVariant = null,
  autoForkFromLibrary = true,
  reason = "sfx-save",
}) {
  if (!id || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) {
    throw new Error(`特效 ID 格式不合法 (${id})`);
  }
  // 静态安全守卫：严禁配音脚本写入或篡改只读音效参考库、核心引擎或 .agents 技能规范
  if (/(?:sfx-refs|sfx-core|\.agents)\b[\s\S]{0,60}\b(?:writeFile|unlink|rmSync|rmdir|appendFile)/i.test(code)) {
    throw new Error("安全拦截：严禁修改只读音效参考库 (sfx-refs/)、底层引擎 (sfx-core) 或 .agents/ 技能文件！");
  }
  ensureBaseDirs();

  // 若该特效原本只在内置库，自动将其视觉源码同步克隆进工作区，实现视觉+专属配音一体化管理
  const wsFxFile = join(WS_FX_DIR, id + ".js");
  if ((!existsSync(wsFxFile) || isBridgeShimFile(wsFxFile)) && autoForkFromLibrary) {
    const libFxFile = join(FX_DIR, id + ".js");
    if (existsSync(libFxFile)) {
      const jsCode = readFileSync(libFxFile, "utf8");
      ensureCategoryShims(id.split("/")[0], jsCode);
      writeFileSync(wsFxFile, jsCode, "utf8");
      saveSnapshot(id, jsCode, "autofork-sfx");
    }
  }

  const sfxJsFile = join(WS_SFX_DIR, id + ".js");
  mkdirSync(dirname(sfxJsFile), { recursive: true });
  if (existsSync(sfxJsFile)) {
    saveSfxScriptSnapshot(id, readFileSync(sfxJsFile, "utf8"), reason);
  }
  writeFileSync(sfxJsFile, code, "utf8");

  return compileEffectSfxScript(id, selectVariant);
}

export function selectEffectSfxVariant({ id, variantId }) {
  const info = getEffectSfxInfo(id);
  const found = info.variants.find((v) => v.id === variantId);
  if (!found) {
    throw new Error(`特效 ${id} 不存在音效变种 ${variantId}`);
  }
  const wsManifest = readWorkspaceManifest();
  const prev = wsManifest.effects[id] || { createdAt: new Date().toISOString() };
  wsManifest.effects[id] = {
    ...prev,
    activeSfxVariant: variantId,
    updatedAt: new Date().toISOString(),
  };
  writeWorkspaceManifest(wsManifest);
  return getEffectSfxInfo(id);
}
