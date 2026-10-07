/**
 * index.ts — Railway entry point.
 *
 * Replaces the Cloudflare Worker with:
 *  - Express HTTP server (panel + API + health)
 *  - WebSocket server (realtime panel updates)
 *  - Background scheduler (channel discovery every N seconds)
 *  - Bot tick interval (original bot polling every 60 seconds)
 *  - Graceful shutdown (SIGTERM/SIGINT)
 */

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import type { Env } from "./types.js";
import { handleApiRequest } from "./api.js";
import { handleGatewayEvent } from "./gateway.js";
import { runMonitorTick } from "./monitor.js";
import { runBotTick } from "./bot.js";
import { addLog, setBotEnabled as _setBotEnabled } from "./state.js";
import { insertMplusLog } from "./db.js";
import { startDiscoveryScheduler, stopDiscoveryScheduler } from "./scheduler.js";
import { registerWsClient } from "./monitor-do.js";
import { buildHealthReport } from "./health.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Environment ──────────────────────────────────────────────────────────────

const PORT           = parseInt(process.env.PORT ?? "3000", 10);
const DATABASE_URL   = process.env.DATABASE_URL;
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN ?? "";
const DISCORD_READ_TOKEN = process.env.DISCORD_READ_TOKEN;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD ?? "";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "change-me-in-production";
const TRUST_PROXY    = process.env.TRUST_PROXY === "1";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const NODE_ENV       = process.env.NODE_ENV ?? "development";

if (!DATABASE_URL) { console.error("FATAL: DATABASE_URL is not set"); process.exit(1); }
if (!DISCORD_TOKEN) { console.error("FATAL: DISCORD_TOKEN is not set"); process.exit(1); }
if (!PANEL_PASSWORD) { console.error("FATAL: PANEL_PASSWORD is not set"); process.exit(1); }
if (!DISCORD_READ_TOKEN) { console.warn("WARN: DISCORD_READ_TOKEN is not set — READ operations will fail"); }

// ─── Database pool ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

// Run schema migrations on startup
async function runMigrations(): Promise<void> {
  const migDir = path.join(__dirname, "..", "migrations");
  if (!fs.existsSync(migDir)) { console.warn("[db] No migrations directory found"); return; }
  const files = fs.readdirSync(migDir).filter(f => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migDir, file), "utf8");
    try {
      await pool.query(sql);
      console.log(`[db] Applied migration: ${file}`);
    } catch (err) {
      // Ignore "already exists" errors from CREATE TABLE IF NOT EXISTS
      const msg = String(err);
      if (!msg.includes("already exists") && !msg.includes("duplicate")) {
        console.error(`[db] Migration error in ${file}:`, msg);
      }
    }
  }
}

// ─── Env object ───────────────────────────────────────────────────────────────

const env: Env = {
  DB:                  pool,
  DISCORD_TOKEN,
  DISCORD_READ_TOKEN,
  PANEL_PASSWORD,
  SESSION_SECRET,
  TELEGRAM_TOKEN,
  DISCORD_PUBLIC_KEY,
};

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

if (TRUST_PROXY) app.set("trust proxy", 1);

app.use(express.json());
app.use(express.text());

// Session (uses PostgreSQL session store)
const PgSession = connectPgSimple(session);
app.use(session({
  store: new PgSession({ pool, tableName: "session", createTableIfMissing: true }),
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly:  true,
    secure:    NODE_ENV === "production" && TRUST_PROXY,
    sameSite:  "strict",
    maxAge:    8 * 60 * 60 * 1000, // 8 hours
  },
}));

// ── CORS preflight ────────────────────────────────────────────────────────────
app.options("*", (req, res) => {
  res.set({
    "Access-Control-Allow-Origin":  req.headers.origin ?? "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
  }).sendStatus(204);
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    const { report, httpStatus } = await buildHealthReport(env);
    res.status(httpStatus).json(report);
  } catch {
    res.status(200).json({ status: "ok" });
  }
});

// ── Gateway webhook ───────────────────────────────────────────────────────────
app.post("/gateway/event", async (req, res) => {
  try {
    // Re-create a minimal Request object that matches our gateway handler signature
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const headers = new Headers();
    Object.entries(req.headers).forEach(([k, v]) => {
      if (typeof v === "string") headers.set(k, v);
    });
    const fakeRequest = new Request(`http://localhost/gateway/event`, {
      method: "POST",
      headers,
      body,
    });
    const response = await handleGatewayEvent(fakeRequest, env);
    res.status(response.status).send(await response.text());
  } catch (err) {
    console.error("[gateway] Error:", String(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── REST API ──────────────────────────────────────────────────────────────────
app.all("/api/*", async (req, res) => {
  try {
    const body = typeof req.body === "object" && req.body
      ? JSON.stringify(req.body)
      : (typeof req.body === "string" ? req.body : undefined);
    const url = `http://localhost${req.originalUrl}`;
    const headers = new Headers({ "Content-Type": "application/json" });
    Object.entries(req.headers).forEach(([k, v]) => {
      if (typeof v === "string") headers.set(k, v);
    });
    // Forward session cookie so isAuthenticated works
    if (req.headers.cookie) headers.set("Cookie", req.headers.cookie);
    const fakeRequest = new Request(url, {
      method:  req.method,
      headers,
      body:    body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    });
    const response = await handleApiRequest(fakeRequest, env, new URL(url).pathname);
    if (!response) { res.status(404).json({ error: "Not found" }); return; }

    // Forward Set-Cookie header for login/logout
    const setCookie = response.headers.get("Set-Cookie");
    if (setCookie) res.setHeader("Set-Cookie", setCookie);

    const data = await response.text();
    res.status(response.status)
       .set("Content-Type", response.headers.get("Content-Type") ?? "application/json")
       .send(data);
  } catch (err) {
    console.error("[api] Unhandled error:", String(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Admin panel HTML ──────────────────────────────────────────────────────────
const PANEL_PATH = path.join(__dirname, "..", "panel.html");
let panelHtml = "<h1>Panel not found</h1>";
if (fs.existsSync(PANEL_PATH)) {
  panelHtml = fs.readFileSync(PANEL_PATH, "utf8");
}

app.get(["/", "/panel", "/panel.html"], (_req, res) => {
  res.set({
    "Content-Type":              "text/html; charset=utf-8",
    "X-Content-Type-Options":    "nosniff",
    "X-Frame-Options":           "DENY",
    "Referrer-Policy":           "strict-origin-when-cross-origin",
    "Content-Security-Policy":   "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' wss:",
  }).send(panelHtml);
});

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("[ws] Client connected");
  registerWsClient(ws as unknown as import("ws").WebSocket);
});

// ─── Background loops ─────────────────────────────────────────────────────────

// Monitor tick — runs every 60 seconds (acceptance polling + processActiveChannels)
let monitorTimer: ReturnType<typeof setInterval> | null = null;
function startMonitorTick(): void {
  monitorTimer = setInterval(async () => {
    try {
      await runMonitorTick(env);
    } catch (err) {
      console.error("[monitor tick] Error:", String(err));
      await insertMplusLog(env, "error", "SYSTEM", `Monitor tick error: ${String(err)}`).catch(() => {});
    }
  }, 60_000);
  // Run once immediately
  runMonitorTick(env).catch((err) => console.error("[monitor tick] Initial error:", String(err)));
}

// Bot tick — original KV-based bot, runs every 60 seconds
let botTimer: ReturnType<typeof setInterval> | null = null;
function startBotTick(): void {
  botTimer = setInterval(async () => {
    try {
      await runBotTick(env);
    } catch (err) {
      console.error("[bot tick] Error:", String(err));
      await addLog(env, "error", `Bot tick error: ${String(err)}`).catch(() => {});
    }
  }, 60_000);
}

// ─── Startup ─────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  console.log("[startup] Discord Bot Railway — starting…");

  // Test DB connection
  try {
    await pool.query("SELECT 1");
    console.log("[db] PostgreSQL connected.");
  } catch (err) {
    console.error("[db] FATAL: Cannot connect to PostgreSQL:", String(err));
    process.exit(1);
  }

  // Run migrations
  await runMigrations();

  // Start HTTP server
  await new Promise<void>((resolve) => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`[http] Server listening on 0.0.0.0:${PORT}`);
      resolve();
    });
  });

  // Start background workers
  startDiscoveryScheduler(env);
  startMonitorTick();
  startBotTick();

  console.log("[startup] All services started. Ready.");
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] Received ${signal} — shutting down gracefully…`);

  stopDiscoveryScheduler();
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  if (botTimer)     { clearInterval(botTimer);     botTimer     = null; }

  wss.close(() => console.log("[ws] WebSocket server closed."));

  server.close(async () => {
    console.log("[http] HTTP server closed.");
    await pool.end();
    console.log("[db] Database pool closed.");
    console.log("[shutdown] Shutdown complete.");
    process.exit(0);
  });

  // Force-exit after 10 seconds
  setTimeout(() => { console.error("[shutdown] Force-exit."); process.exit(1); }, 10_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ─── Run ──────────────────────────────────────────────────────────────────────
start().catch((err) => {
  console.error("[startup] FATAL:", String(err));
  process.exit(1);
});
