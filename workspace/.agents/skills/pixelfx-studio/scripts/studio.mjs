#!/usr/bin/env node
// PixelFX 工作区 `.agents` 技能配套工具脚本（供任何 AI Harness 直接调用，实时反馈至全局 UI）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WS_ROOT = join(SCRIPT_DIR, "..", "..", "..", "..");
const REPO_ROOT = join(WS_ROOT, "..");

const { renderFrames, contactSheet, save, allIds, loadEffect } = await import(
  new URL("../../../../../tools/lib/fxlib.mjs", import.meta.url).href
);
const {
  WS_ACTIVE_FILE,
  listWorkspaceEffects,
  createWorkspaceEffect,
  tuneWorkspaceEffect,
  checkWorkspaceEffect,
  loadWorkspaceModule,
  getSfxRefsStatus,
  setSfxRefsGlobalEnabled,
  addLocalDirRefLibrary,
  removeRefLibrary,
  searchRefs,
  compileEffectSfxScript,
} = await import(new URL("../../../../../tools/lib/workspace-engine.mjs", import.meta.url).href);

const STATE_DIR = join(WS_ROOT, "state");
const UI_CMD_FILE = join(STATE_DIR, "ui-command.json");
const FEED_FILE = join(STATE_DIR, "agent-feed.json");
mkdirSync(STATE_DIR, { recursive: true });

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      flags[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else {
      pos.push(argv[i]);
    }
  }
  return { pos, flags };
}

function appendFeed(type, message, targetId = null, extra = {}) {
  let feed = [];
  if (existsSync(FEED_FILE)) {
    try { feed = JSON.parse(readFileSync(FEED_FILE, "utf8")).events || []; } catch {}
  }
  const evt = {
    id: Date.now().toString(36),
    ts: new Date().toISOString(),
    type,
    message,
    targetId,
    ...extra,
  };
  feed.unshift(evt);
  writeFileSync(FEED_FILE, JSON.stringify({ events: feed.slice(0, 40) }, null, 2), "utf8");
  return evt;
}

async function notifyServer(endpoint, payload) {
  const port = process.env.PIXELFX_PORT || 8080;
  try {
    await fetch(`http://localhost:${port}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {}
}

const [cmd = "status", ...rest] = process.argv.slice(2);
const { pos, flags } = parseArgs(rest);

if (cmd === "status") {
  const ctxFile = existsSync(join(STATE_DIR, "ui-context.json"))
    ? join(STATE_DIR, "ui-context.json")
    : WS_ACTIVE_FILE;
  const ctx = existsSync(ctxFile) ? JSON.parse(readFileSync(ctxFile, "utf8")) : null;
  const refs = getSfxRefsStatus();
  const ws = await listWorkspaceEffects();
  console.log("=== 当前 UI 实时状态 ===");
  console.log(ctx ? JSON.stringify(ctx, null, 2) : "(前端暂未上报状态)");
  console.log("\n=== 音效参考库状态 (sfxRefs) ===");
  console.log(
    refs.active
      ? `已启用 (active: true) — ${refs.activeLibraryCount} 个启用参考库 / ${refs.activeSoundCount} 条可用参考音频`
      : `未启用 (active: false, 全局开关=${refs.enabled}, 已导入总音频=${refs.totalSoundCount}) — 当前为纯 JS 程序化合成模式`,
  );
  console.log(`\n=== 工作区特效列表 (${ws.length}) ===`);
  for (const x of ws) {
    const sfxTag = x.sfxVariantCount ? `SFX:${x.sfxVariantCount}变种[${x.activeSfxVariant}]` : "无配音";
    console.log(`- ${x.id} | ${x.zhName} | ${sfxTag} | ${x.broken ? "ERROR: " + x.error : "OK"}`);
  }
} else if (cmd === "search") {
  const q = pos.join(" ").toLowerCase();
  const hits = [];
  for (const id of allIds()) {
    const fx = await loadEffect(id);
    const hay = `${id} ${fx.meta.name} ${fx.meta.desc} ${(fx.meta.tags || []).join(" ")}`.toLowerCase();
    if (!q || hay.includes(q)) {
      hits.push(`${id.padEnd(28)} ${String(fx.meta.size).padEnd(9)} ${fx.meta.loop ? "loop" : "1shot"}  ${fx.meta.desc.slice(0, 68)}`);
    }
  }
  console.log(hits.slice(0, 30).join("\n") || "未找到匹配内置特效");
} else if (cmd === "fork") {
  const [srcId, dstId] = pos;
  if (!srcId) {
    console.error("用法: studio.mjs fork <srcId> [dstId] [--name 中文名] [--desc 描述]");
    process.exit(1);
  }
  const inWs = existsSync(join(WS_ROOT, "fx", srcId + ".js"));
  const res = await createWorkspaceEffect({
    id: dstId || srcId,
    zhName: flags.name,
    zhDesc: flags.desc,
    cloneFrom: srcId,
    cloneSpace: flags.space || (inWs ? "workspace" : "library"),
  });
  appendFeed("fork", `从 ${srcId} 克隆创建 ${res.id}`, res.id);
  await notifyServer("/api/workspace/ui-command", { selectId: res.id, space: "workspace", message: `已克隆创建 ${flags.name || res.id}` });
  console.log(`已克隆至 fx/${res.id}.js`, res.check);
} else if (cmd === "tune") {
  const id = pos[0];
  if (!id || !flags.json) {
    console.error('用法: studio.mjs tune <id> --json \'{"fps":16,"seed":42}\' [--name 中文名]');
    process.exit(1);
  }
  const preset = JSON.parse(flags.json);
  const res = await tuneWorkspaceEffect({ id, zhName: flags.name, zhDesc: flags.desc, preset });
  appendFeed("tune", `动态调优参数 ${res.id}`, res.id);
  await notifyServer("/api/workspace/tune", { id: res.id, zhName: flags.name, zhDesc: flags.desc, preset, source: "harness-cli" });
  console.log(`已同步参数至 UI -> ${res.id}`);
} else if (cmd === "ui") {
  const command = {
    ts: Date.now(),
    ...(flags.space ? { space: flags.space } : {}),
    ...(flags.select ? { selectId: flags.select } : {}),
    ...(flags.view ? { activeView: flags.view } : {}),
    ...(flags.bg ? { bg: flags.bg } : {}),
    ...(flags.theme ? { theme: flags.theme } : {}),
    ...(flags.message ? { message: flags.message } : {}),
  };
  writeFileSync(UI_CMD_FILE, JSON.stringify(command, null, 2), "utf8");
  if (flags.message) appendFeed("agent", flags.message, flags.select || null);
  await notifyServer("/api/workspace/ui-command", command);
  console.log("已向全局 UI 发送实时控制指令:", JSON.stringify(command));
} else if (cmd === "check") {
  const id = pos[0];
  if (!id) {
    console.error("用法: studio.mjs check <id>");
    process.exit(1);
  }
  const chk = await checkWorkspaceEffect(id);
  console.log(JSON.stringify(chk, null, 2));
  process.exit(chk.ok ? 0 : 1);
} else if (cmd === "snapshot") {
  const id = pos[0];
  if (!id) {
    console.error("用法: studio.mjs snapshot <id>");
    process.exit(1);
  }
  const fx = await loadWorkspaceModule(id);
  const item = (await listWorkspaceEffects()).find((x) => x.id === id);
  const p = item?.preset || {};
  const r = renderFrames(fx, {
    fps: p.fps || fx.meta.fps,
    seed: p.seed ?? fx.meta.options?.seed,
    bg: p.bg === "topstone" || p.bg === "checker" ? fx.meta.bg : (p.bg || fx.meta.bg),
    options: { ...(p.extraOpts || {}), ...(p.palette ? { palette: p.palette } : {}) },
  });
  const snapDir = join(STATE_DIR, "snapshots");
  mkdirSync(snapDir, { recursive: true });
  const outFile = join(snapDir, `${id.replace(/\//g, "__")}.png`);
  save(outFile, contactSheet(fx, r, { max: flags.all ? 200 : 16 }));
  console.log(`分帧视觉审阅图已生成: ${outFile}`);
} else if (cmd === "refs") {
  const sub = pos[0] || "list";
  if (sub === "enable" || sub === "on") {
    const st = setSfxRefsGlobalEnabled(true);
    await notifyServer("/api/sfx/refs/toggle-global", { enabled: true });
    console.log("已启用音效参考库:", JSON.stringify(st, null, 2));
  } else if (sub === "disable" || sub === "off") {
    const st = setSfxRefsGlobalEnabled(false);
    await notifyServer("/api/sfx/refs/toggle-global", { enabled: false });
    console.log("已关闭音效参考库（切换为纯程序化合成模式）:", JSON.stringify(st, null, 2));
  } else if (sub === "add-dir") {
    const dirPath = pos[1];
    if (!dirPath) {
      console.error("用法: studio.mjs refs add-dir <本地音频文件夹路径> [--name 显示名称]");
      process.exit(1);
    }
    const st = await addLocalDirRefLibrary({ name: flags.name, dirPath });
    console.log("已挂载本地音效参考目录:", JSON.stringify(st, null, 2));
  } else if (sub === "remove") {
    const libId = pos[1];
    if (!libId) {
      console.error("用法: studio.mjs refs remove <libId>");
      process.exit(1);
    }
    const st = removeRefLibrary(libId);
    console.log("已移除音效参考库:", JSON.stringify(st, null, 2));
  } else {
    console.log(JSON.stringify(getSfxRefsStatus(), null, 2));
  }
} else if (cmd === "search-sfx") {
  const q = pos.join(" ");
  const st = getSfxRefsStatus();
  if (!st.active) {
    console.log(
      `音效参考库当前未启用 (enabled=${st.enabled}, activeSoundCount=${st.activeSoundCount})。\n请勿调用 refLayer/refSample，直接使用 sfx-core 原语进行纯 JS 程序化合成。`,
    );
  } else {
    const limit = +(flags.limit || 24);
    const hits = searchRefs(q, {
      libId: flags.lib || null,
      limit,
    });
    console.log(`=== 已启用音效参考库 (${st.activeLibraryCount} 库 / 共 ${st.activeSoundCount} 条) 检索 "${q}" -> ${hits.length} 条 ===`);
    for (const h of hits) {
      console.log(
        `${h.id.padEnd(48)} | ${String(h.duration + "s").padEnd(7)} | peak@${String(h.peakTime + "s").padEnd(7)}`,
      );
    }
  }
} else if (cmd === "build-sfx" || cmd === "sfx") {
  const id = pos[0];
  if (!id) {
    console.error("用法: studio.mjs build-sfx <category>/<name> [--select <variant_id>]");
    process.exit(1);
  }
  const res = await compileEffectSfxScript(id, flags.select || null);
  const labels = res.sfx.variants.map((v) => `${v.id}(${v.label})`).join(", ");
  appendFeed(
    "sfx",
    `编译专属配音 ${id} (${res.sfx.variants.length} 变种: ${labels})`,
    id,
  );
  await notifyServer("/api/sfx/notify", {
    id,
    selectVariant: res.sfx.activeVariant,
  });
  console.log(`专属配音编译完成 -> ${id} | 当前激活: ${res.sfx.activeVariant}\n变种列表: ${labels}`);
} else {
  console.error(`未知命令: ${cmd}`);
  process.exit(1);
}
