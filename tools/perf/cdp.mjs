// Minimal Chrome DevTools Protocol client + headless Chrome launcher (no deps).
// Requires Node 22+ (global WebSocket and fetch).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const CHROME_PATH = process.env.CHROME_PATH ||
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "google-chrome");

export async function launchChrome({ headless = true, width = 1280, height = 800, args = [] } = {}) {
  if (typeof WebSocket !== "function") throw new Error("Node 22+ is required (global WebSocket).");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "bbb-perf-"));
  const proc = spawn(CHROME_PATH, [
    headless ? "--headless=new" : null,
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--mute-audio", "--hide-scrollbars",
    "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    `--window-size=${width},${height}`,
    ...args, "about:blank",
  ].filter(Boolean), { stdio: ["ignore", "ignore", "pipe"] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Chrome\n" + buf)), 30000);
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Chrome exited (${code})\n${buf}`)); });
  });
  const port = new URL(wsUrl).port;
  return {
    port,
    async newPage() {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
      const info = await res.json();
      return CDPSession.connect(info.webSocketDebuggerUrl, info.id);
    },
    async close() {
      proc.kill();
      await new Promise((r) => setTimeout(r, 300));
      try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    },
  };
}

export class CDPSession {
  static async connect(wsUrl, targetId) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new CDPSession(ws, targetId);
  }

  constructor(ws, targetId) {
    this.ws = ws;
    this.targetId = targetId;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return () => this.listeners.set(method, this.listeners.get(method).filter((f) => f !== fn));
  }

  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`Timed out waiting for ${method}`)); }, timeoutMs);
      const off = this.on(method, (p) => { clearTimeout(timer); off(); resolve(p); });
    });
  }

  // Evaluate in the main world (or in a given execution context) and return the value.
  async eval(expression, contextId) {
    const res = await this.send("Runtime.evaluate", {
      expression, contextId, awaitPromise: true, returnByValue: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`Evaluation failed: ${(d.exception && d.exception.description) || d.text}`);
    }
    return res.result.value;
  }

  close() { this.ws.close(); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
