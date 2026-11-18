#!/usr/bin/env node
// 外部 Agent 专用工作区命令行工具 (Antigravity / Claude Code / Cursor / Codex)
//
//   node tools/ws-cli.mjs status                          查看网页当前选中特效、实时参数与待办任务单
//   node tools/ws-cli.mjs tasks                           列出所有网页派发的待办任务
//   node tools/ws-cli.mjs done <taskId> [resultId] [note] 标记任务已完成并通知网页端
//   node tools/ws-cli.mjs fork <srcId> [dstId] --name 名  从内置库或工作区克隆副本到工作区
//   node tools/ws-cli.mjs tune <id> --json '{...}'        动态修改参数预设并推送到网页
//   node tools/ws-cli.mjs check [id]                      检查工作区特效像素越界、尾帧残留与帧耗时
//   node tools/ws-cli.mjs snapshot [id]                   渲染工作区特效分帧预览图 contact.png 供视觉审阅

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, renderFrames, contactSheet, save } from "./lib/fxlib.mjs";
import {
  WS_ACTIVE_FILE,
  listWorkspaceEffects,
  createWorkspaceEffect,
  tuneWorkspaceEffect,
  checkWorkspaceEffect,
  loadWorkspaceModule,
  listAgentTasks,
  updateAgentTask,
} from "./lib/workspace-engine.mjs";

const [cmd = "status", ...rest] = process.argv.slice(2);

function readActive() {
  if (!existsSync(WS_ACTIVE_FILE)) return null;
  try { return JSON.parse(readFileSync(WS_ACTIVE_FILE, "utf8")); } catch { return null; }
}

function parseFlags(arr) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].startsWith("--")) {
      const k = arr[i].slice(2);
      flags[k] = arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[++i] : true;
    } else {
      pos.push(arr[i]);
    }
  }
  return { pos, flags };
}

async function pingServer(path, body) {
  try {
    await fetch(`http://localhost:8080${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {}
}

const { pos, flags } = parseFlags(rest);

if (cmd === "status") {
  const active = readActive();
  const ws = await listWorkspaceEffects();
  const pending = listAgentTasks().filter((t) => t.status === "pending");
  console.log("=== PixelFX 工作台实时焦点 ===");
  console.log(active ? JSON.stringify(active, null, 2) : "(网页尚未打开或未上报焦点)");
  console.log(`\n=== 创作工作区特效 (${ws.length}) ===`);
  for (const x of ws) {
    console.log(`- ${x.id}  [${x.zhName}]  ${x.broken ? "BROKEN: " + x.error : "OK"}`);
  }
  console.log(`\n=== 待处理任务单 (${pending.length}) ===`);
  for (const t of pending) {
    console.log(`- [${t.taskId}] 目标:${t.targetId} (${t.space}) -> ${t.prompt}`);
  }
} else if (cmd === "tasks") {
  console.log(JSON.stringify(listAgentTasks(), null, 2));
} else if (cmd === "done") {
  const [taskId, resultId, ...noteParts] = pos;
  if (!taskId) {
    console.error("用法: node tools/ws-cli.mjs done <taskId> [resultId] [note]");
    process.exit(1);
  }
  const updated = updateAgentTask({
    taskId,
    status: "done",
    resultId: resultId || null,
    note: noteParts.join(" ") || flags.note || "已由外部 Agent 完成处理",
  });
  await pingServer("/api/workspace/tasks/notify", updated);
  console.log("已标记完成:", updated.taskId);
} else if (cmd === "fork") {
  const [srcId, dstId] = pos;
  if (!srcId) {
    console.error("用法: node tools/ws-cli.mjs fork <srcId> [dstId] [--space library|workspace] [--name 中文名]");
    process.exit(1);
  }
  const res = await createWorkspaceEffect({
    id: dstId || srcId,
    zhName: flags.name,
    zhDesc: flags.desc,
    cloneFrom: srcId,
    cloneSpace: flags.space || (existsSync(join(ROOT, "workspace", "fx", srcId + ".js")) ? "workspace" : "library"),
  });
  console.log(`已克隆至 workspace/fx/${res.id}.js`, res.check);
} else if (cmd === "tune") {
  const id = pos[0] || readActive()?.id;
  if (!id || !flags.json) {
    console.error('用法: node tools/ws-cli.mjs tune <id> --json \'{"fps":16,"seed":42}\' [--name 中文名]');
    process.exit(1);
  }
  const preset = JSON.parse(flags.json);
  const res = await tuneWorkspaceEffect({ id, zhName: flags.name, zhDesc: flags.desc, preset });
  await pingServer("/api/workspace/tune", { id: res.id, zhName: flags.name, zhDesc: flags.desc, preset });
  console.log(`已更新工作区预设 -> ${res.id}`);
} else if (cmd === "check") {
  const id = pos[0] || readActive()?.id;
  if (!id) {
    console.error("用法: node tools/ws-cli.mjs check <id>");
    process.exit(1);
  }
  const chk = await checkWorkspaceEffect(id);
  console.log(JSON.stringify(chk, null, 2));
  process.exit(chk.ok ? 0 : 1);
} else if (cmd === "snapshot") {
  const id = pos[0] || readActive()?.id;
  if (!id) {
    console.error("用法: node tools/ws-cli.mjs snapshot <id>");
    process.exit(1);
  }
  const fx = await loadWorkspaceModule(id);
  const manifest = (await listWorkspaceEffects()).find((x) => x.id === id);
  const p = manifest?.preset || {};
  const r = renderFrames(fx, {
    fps: p.fps || fx.meta.fps,
    seed: p.seed ?? fx.meta.options?.seed,
    bg: p.bg === "topstone" || p.bg === "checker" ? fx.meta.bg : (p.bg || fx.meta.bg),
    options: { ...(p.extraOpts || {}), ...(p.palette ? { palette: p.palette } : {}) },
  });
  const outFile = join(ROOT, "records", "workspace", id, "contact.png");
  save(outFile, contactSheet(fx, r, { max: flags.all ? 200 : 16 }));
  console.log(`已输出分帧视觉审阅图: ${outFile}`);
} else {
  console.error(`未知子命令: ${cmd}`);
  process.exit(1);
}
