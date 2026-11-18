#!/usr/bin/env node
// PixelFX 本地工作台与实时热更新服务器: node tools/serve.mjs [port]
// 访问地址: http://localhost:8080/gallery/

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { join, extname, normalize, sep } from "node:path";
import { ROOT } from "./lib/fxlib.mjs";
import {
  WS_DIR,
  WS_FX_DIR,
  WS_SFX_DIR,
  WS_AGENTS_DIR,
  WS_STATE_DIR,
  WS_ACTIVE_FILE,
  WS_LEGACY_ACTIVE_FILE,
  WS_UI_CMD_FILE,
  ensureBaseDirs,
  listWorkspaceEffects,
  createWorkspaceEffect,
  saveWorkspaceCode,
  tuneWorkspaceEffect,
  deleteWorkspaceEffect,
  publishWorkspaceToLibrary,
  checkWorkspaceEffect,
  listEffectHistory,
  restoreEffectHistory,
  getAgentConfig,
  saveAgentConfig,
  runWorkspaceAgentChat,
  undoAgentCheckpoint,
  clearAgentCheckpoints,
  listAgentTasks,
  enqueueAgentTask,
  clearCompletedTasks,
  getHarnessDirectoryInfo,
  readHarnessFile,
  getSfxRefsStatus,
  setSfxRefsGlobalEnabled,
  addLocalDirRefLibrary,
  importUploadedRefLibrary,
  toggleRefLibrary,
  rescanRefLibrary,
  removeRefLibrary,
  searchRefs,
  getEffectSfxInfo,
  readEffectSfxSource,
  compileEffectSfxScript,
  saveEffectSfxCode,
  selectEffectSfxVariant,
} from "./lib/workspace-engine.mjs";

const PORT = +(process.argv[2] ?? 8080);
const CUSTOM_META_FILE = join(ROOT, "gallery", "custom-meta.json");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".md": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

ensureBaseDirs();

// ---- SSE 实时事件广播与文件监听 (支持外部 IDE Agent 直接改文件毫秒级热重载) ----
const sseClients = new Set();

function broadcastSSE(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

let watchTimer = null;
let pendingId = null;

function scheduleFsBroadcast(relFile, source) {
  if (!relFile) return;
  const norm = relFile.replace(/\\/g, "/");
  if (norm.includes(".history") || norm.includes("active-context") || norm.includes(".agent-config")) return;
  if (norm.split("/").pop()?.startsWith("_")) return;

  if (norm.endsWith(".js") && norm.includes("/")) {
    pendingId = norm.replace(/\.js$/, "");
  }
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    const id = pendingId;
    pendingId = null;
    broadcastSSE("workspace-sync", { source, changedId: id, ts: Date.now() });
  }, 90);
}

let sfxWatchTimer = null;
let pendingSfxId = null;

try {
  watch(WS_FX_DIR, { recursive: true }, (_evt, filename) => {
    if (filename) scheduleFsBroadcast(String(filename), "fs-fx");
  });
  watch(WS_SFX_DIR, { recursive: true }, (_evt, filename) => {
    if (!filename) return;
    const norm = String(filename).replace(/\\/g, "/");
    const parts = norm.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const cat = parts[0];
      const rawName = parts[1].replace(/\.js$/, "");
      if (/^[a-z0-9-]+\/[a-z0-9-]+$/.test(`${cat}/${rawName}`)) {
        pendingSfxId = `${cat}/${rawName}`;
        clearTimeout(sfxWatchTimer);
        sfxWatchTimer = setTimeout(() => {
          const id = pendingSfxId;
          pendingSfxId = null;
          if (id) {
            broadcastSSE("sfx-sync", { id, sfx: getEffectSfxInfo(id), source: "fs-sfx", ts: Date.now() });
          }
        }, 110);
      }
    }
  });
  watch(WS_AGENTS_DIR, { recursive: true }, (_evt, filename) => {
    if (filename) broadcastSSE("harness-sync", { changedFile: `.agents/${String(filename).replace(/\\/g, "/")}`, ts: Date.now() });
  });
  watch(WS_STATE_DIR, { recursive: false }, async (_evt, filename) => {
    if (filename === "ui-command.json") {
      try {
        const cmd = JSON.parse(await readFile(WS_UI_CMD_FILE, "utf8"));
        broadcastSSE("ui-command", cmd);
      } catch {}
    } else if (filename === "agent-feed.json") {
      broadcastSSE("harness-sync", { source: "feed", ts: Date.now() });
    }
  });
  watch(WS_DIR, { recursive: false }, (_evt, filename) => {
    if (filename === "workspace.json") scheduleFsBroadcast("workspace.json", "fs-meta");
    if (filename === "tasks.json") broadcastSSE("tasks-sync", { ts: Date.now() });
    if (filename === "sfx-refs.json") broadcastSSE("sfx-refs-sync", getSfxRefsStatus());
    if (filename === "AGENTS.md") broadcastSSE("harness-sync", { changedFile: "AGENTS.md", ts: Date.now() });
  });
} catch (e) {
  console.warn("fs.watch warning:", e.message);
}

setInterval(() => {
  for (const c of sseClients) {
    try { c.write(": ping\n\n"); } catch { sseClients.delete(c); }
  }
}, 20000).unref();

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const str = Buffer.concat(chunks).toString("utf8");
        resolve(str ? JSON.parse(str) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res
    .writeHead(status, {
      "content-type": TYPES[".json"],
      "cache-control": "no-store",
    })
    .end(JSON.stringify(data));
}

createServer(async (req, res) => {
  const urlObj = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(urlObj.pathname);

  // 1. SSE 实时热同步流
  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(`event: connected\ndata: {"ts":${Date.now()}}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // 2. 内置库中文自定义名称持久化接口
  if (pathname === "/api/custom-meta") {
    if (req.method === "GET") {
      try {
        const raw = await readFile(CUSTOM_META_FILE, "utf8");
        return res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" }).end(raw);
      } catch {
        return sendJson(res, 200, {});
      }
    }
    if (req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        await writeFile(CUSTOM_META_FILE, JSON.stringify(body, null, 2), "utf8");
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e.message || e) });
      }
    }
  }

  // 3. 创作工作区 API 路由
  if (pathname.startsWith("/api/workspace/")) {
    try {
      if (pathname === "/api/workspace/list" && req.method === "GET") {
        const effects = await listWorkspaceEffects();
        return sendJson(res, 200, { ok: true, effects });
      }

      if (pathname === "/api/workspace/source" && req.method === "GET") {
        const id = urlObj.searchParams.get("id") || "";
        const file = normalize(join(WS_FX_DIR, id + ".js"));
        if (!file.startsWith(WS_FX_DIR + sep) || !existsSync(file)) {
          return sendJson(res, 404, { ok: false, error: "未找到工作区特效源码" });
        }
        const code = await readFile(file, "utf8");
        return sendJson(res, 200, { ok: true, id, code });
      }

      if (pathname === "/api/workspace/create" && req.method === "POST") {
        const body = await readJsonBody(req);
        const created = await createWorkspaceEffect(body);
        broadcastSSE("workspace-sync", { source: "api-create", changedId: created.id, ts: Date.now() });
        return sendJson(res, 200, created);
      }

      if (pathname === "/api/workspace/save-code" && req.method === "POST") {
        const body = await readJsonBody(req);
        const saved = await saveWorkspaceCode(body);
        broadcastSSE("workspace-sync", { source: "api-save", changedId: saved.id, ts: Date.now() });
        return sendJson(res, 200, saved);
      }

      if (pathname === "/api/workspace/tune" && req.method === "POST") {
        const body = await readJsonBody(req);
        const tuned = await tuneWorkspaceEffect(body);
        broadcastSSE("preset-sync", { source: body.source || "agent-tune", changedId: tuned.id, item: tuned.item, ts: Date.now() });
        return sendJson(res, 200, tuned);
      }

      if (pathname === "/api/workspace/check" && req.method === "POST") {
        const body = await readJsonBody(req);
        const check = await checkWorkspaceEffect(body.id);
        return sendJson(res, 200, { ok: true, id: body.id, check });
      }

      if (pathname === "/api/workspace/history" && req.method === "GET") {
        const id = urlObj.searchParams.get("id") || "";
        return sendJson(res, 200, { ok: true, id, history: listEffectHistory(id) });
      }

      if (pathname === "/api/workspace/restore" && req.method === "POST") {
        const body = await readJsonBody(req);
        const restored = await restoreEffectHistory(body.id, body.file);
        broadcastSSE("workspace-sync", { source: "api-restore", changedId: restored.id, ts: Date.now() });
        return sendJson(res, 200, restored);
      }

      if (pathname === "/api/workspace/delete" && req.method === "POST") {
        const body = await readJsonBody(req);
        const del = deleteWorkspaceEffect(body.id);
        broadcastSSE("workspace-sync", { source: "api-delete", deletedId: body.id, ts: Date.now() });
        return sendJson(res, 200, del);
      }

      if (pathname === "/api/workspace/publish" && req.method === "POST") {
        const body = await readJsonBody(req);
        const pub = await publishWorkspaceToLibrary(body.id);
        broadcastSSE("library-published", { id: body.id, ts: Date.now() });
        return sendJson(res, 200, pub);
      }

      if (pathname === "/api/workspace/active-context") {
        if (req.method === "GET") {
          try {
            const raw = await readFile(WS_ACTIVE_FILE, "utf8");
            return res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" }).end(raw);
          } catch {
            return sendJson(res, 200, {});
          }
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const payloadStr = JSON.stringify({ ...body, updatedAt: new Date().toISOString() }, null, 2);
          await writeFile(WS_ACTIVE_FILE, payloadStr, "utf8");
          await writeFile(WS_LEGACY_ACTIVE_FILE, payloadStr, "utf8");
          return sendJson(res, 200, { ok: true });
        }
      }

      if (pathname === "/api/workspace/harness-info" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, ...getHarnessDirectoryInfo() });
      }

      if (pathname === "/api/workspace/agents-file" && req.method === "GET") {
        const rel = urlObj.searchParams.get("path") || "";
        return sendJson(res, 200, { ok: true, readonly: true, ...readHarnessFile(rel) });
      }

      if (pathname === "/api/workspace/ui-command" && req.method === "POST") {
        const body = await readJsonBody(req);
        broadcastSSE("ui-command", body);
        if (body.selectId) {
          broadcastSSE("workspace-sync", { source: "ui-command", changedId: body.selectId, ts: Date.now() });
        }
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === "/api/workspace/tasks") {
        if (req.method === "GET") {
          return sendJson(res, 200, { ok: true, tasks: listAgentTasks() });
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const task = enqueueAgentTask(body);
          broadcastSSE("tasks-sync", { added: task, ts: Date.now() });
          return sendJson(res, 200, { ok: true, task, tasks: listAgentTasks() });
        }
      }

      if (pathname === "/api/workspace/tasks/clear" && req.method === "POST") {
        const tasks = clearCompletedTasks();
        broadcastSSE("tasks-sync", { ts: Date.now() });
        return sendJson(res, 200, { ok: true, tasks });
      }

      if (pathname === "/api/workspace/tasks/notify" && req.method === "POST") {
        const body = await readJsonBody(req);
        broadcastSSE("tasks-sync", { completed: body, ts: Date.now() });
        if (body.resultId) {
          broadcastSSE("workspace-sync", { source: "ext-agent-done", changedId: body.resultId, ts: Date.now() });
        }
        return sendJson(res, 200, { ok: true });
      }
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  // 4. 内置 AI Agent 接口路由
  if (pathname === "/api/agent/config") {
    if (req.method === "GET") {
      return sendJson(res, 200, { ok: true, config: getAgentConfig(false) });
    }
    if (req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { ok: true, config: saveAgentConfig(body) });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e.message || e) });
      }
    }
  }

  if (pathname === "/api/agent/chat" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const reply = await runWorkspaceAgentChat(body);
      broadcastSSE(reply.action === "tune" ? "preset-sync" : "workspace-sync", {
        source: "builtin-agent",
        changedId: reply.id,
        item: reply.item,
        ts: Date.now(),
      });
      if (reply.sfx) {
        broadcastSSE("sfx-sync", {
          id: reply.id,
          sfx: reply.sfx,
          source: "builtin-agent",
          ts: Date.now(),
        });
      }
      return sendJson(res, 200, reply);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  if (pathname === "/api/agent/undo" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const undone = await undoAgentCheckpoint(body.checkpointId || null);
      broadcastSSE("workspace-sync", {
        source: "agent-undo",
        changedId: undone.restoredId,
        ts: Date.now(),
      });
      if (undone.restoredId) {
        broadcastSSE("sfx-sync", {
          id: undone.restoredId,
          sfx: getEffectSfxInfo(undone.restoredId),
          source: "agent-undo",
          ts: Date.now(),
        });
      }
      return sendJson(res, 200, undone);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  if (pathname === "/api/agent/clear-chat" && req.method === "POST") {
    return sendJson(res, 200, clearAgentCheckpoints());
  }

  // 4.5 专属特效配音、动态可选音效参考库管理与当前特效音效变种接口 (一特效一音效集 -> 多变种 .ogg)
  if (pathname.startsWith("/api/sfx/")) {
    try {
      if (pathname === "/api/sfx/refs/status" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, ...getSfxRefsStatus() });
      }

      if (pathname === "/api/sfx/refs/toggle-global" && req.method === "POST") {
        const body = await readJsonBody(req);
        const status = setSfxRefsGlobalEnabled(body.enabled);
        broadcastSSE("sfx-refs-sync", status);
        return sendJson(res, 200, { ok: true, ...status });
      }

      if (pathname === "/api/sfx/refs/add-dir" && req.method === "POST") {
        const body = await readJsonBody(req);
        const status = await addLocalDirRefLibrary(body);
        broadcastSSE("sfx-refs-sync", status);
        return sendJson(res, 200, { ok: true, ...status });
      }

      if (pathname === "/api/sfx/refs/upload" && req.method === "POST") {
        const body = await readJsonBody(req);
        const status = await importUploadedRefLibrary(body);
        broadcastSSE("sfx-refs-sync", status);
        return sendJson(res, 200, { ok: true, ...status });
      }

      if (pathname === "/api/sfx/refs/toggle-lib" && req.method === "POST") {
        const body = await readJsonBody(req);
        const status = toggleRefLibrary(body);
        broadcastSSE("sfx-refs-sync", status);
        return sendJson(res, 200, { ok: true, ...status });
      }

      if (pathname === "/api/sfx/refs/rescan" && req.method === "POST") {
        const body = await readJsonBody(req);
        const status = await rescanRefLibrary(body.id);
        broadcastSSE("sfx-refs-sync", status);
        return sendJson(res, 200, { ok: true, ...status });
      }

      if (pathname === "/api/sfx/refs/remove" && req.method === "POST") {
        const body = await readJsonBody(req);
        const status = removeRefLibrary(body.id);
        broadcastSSE("sfx-refs-sync", status);
        return sendJson(res, 200, { ok: true, ...status });
      }

      if (pathname === "/api/sfx/refs/search" && req.method === "GET") {
        const q = urlObj.searchParams.get("q") || "";
        const libId = urlObj.searchParams.get("libId") || null;
        const limit = Math.min(80, Math.max(1, +(urlObj.searchParams.get("limit") || 24)));
        const status = getSfxRefsStatus();
        return sendJson(res, 200, {
          ok: true,
          ...status,
          results: searchRefs(q, { libId, limit }),
        });
      }

      if (pathname === "/api/sfx/info" && req.method === "GET") {
        const id = urlObj.searchParams.get("id") || "";
        return sendJson(res, 200, getEffectSfxInfo(id));
      }

      if (pathname === "/api/sfx/source" && req.method === "GET") {
        const id = urlObj.searchParams.get("id") || "";
        return sendJson(res, 200, readEffectSfxSource(id));
      }

      if (pathname === "/api/sfx/save-code" && req.method === "POST") {
        const body = await readJsonBody(req);
        const saved = await saveEffectSfxCode(body);
        broadcastSSE("workspace-sync", { source: "api-sfx-save", changedId: saved.id, ts: Date.now() });
        broadcastSSE("sfx-sync", { id: saved.id, sfx: saved.sfx, source: "api-sfx-save", ts: Date.now() });
        return sendJson(res, 200, saved);
      }

      if (pathname === "/api/sfx/compile" && req.method === "POST") {
        const body = await readJsonBody(req);
        const compiled = await compileEffectSfxScript(body.id, body.selectVariant || null);
        broadcastSSE("sfx-sync", { id: compiled.id, sfx: compiled.sfx, source: "api-sfx-compile", ts: Date.now() });
        return sendJson(res, 200, compiled);
      }

      if (pathname === "/api/sfx/select-variant" && req.method === "POST") {
        const body = await readJsonBody(req);
        const sfx = selectEffectSfxVariant(body);
        broadcastSSE("sfx-sync", { id: body.id, sfx, source: "ui-select-variant", ts: Date.now() });
        return sendJson(res, 200, sfx);
      }

      if (pathname === "/api/sfx/notify" && req.method === "POST") {
        const body = await readJsonBody(req);
        const sfx = getEffectSfxInfo(body.id);
        broadcastSSE("sfx-sync", { id: body.id, sfx, source: "harness-cli", ts: Date.now() });
        return sendJson(res, 200, { ok: true, sfx });
      }
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  // 5. 静态资源与 ES Module 透明回退解析
  if (pathname === "/") return res.writeHead(302, { location: "/gallery/" }).end();
  if (pathname.endsWith("/")) pathname += "index.html";

  let file = normalize(join(ROOT, pathname));
  if (!file.startsWith(ROOT + sep)) return res.writeHead(403).end();

  // 工作区模块对 core 与同分类 _lib.js / 跨分类内置特效提供透明回退解析
  if (!existsSync(file)) {
    if (pathname.startsWith("/workspace/core/")) {
      const alt = normalize(join(ROOT, "/src/core/" + pathname.slice("/workspace/core/".length)));
      if (alt.startsWith(ROOT + sep) && existsSync(alt)) file = alt;
    } else if (pathname.startsWith("/workspace/fx/")) {
      const alt = normalize(join(ROOT, "/src/fx/" + pathname.slice("/workspace/fx/".length)));
      if (alt.startsWith(ROOT + sep) && existsSync(alt)) file = alt;
    }
  }

  try {
    const body = await readFile(file);
    res
      .writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      })
      .end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => console.log(`pixelfx workbench + workspace: http://localhost:${PORT}/gallery/`));
