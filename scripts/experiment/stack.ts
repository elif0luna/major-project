// Phase 9: starts and stops one game server + one proxy as child processes.
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function http<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

export interface StackPorts {
  server: number;
  serverControl: number;
  proxy: number;
  proxyControl: number;
}

export interface ServerHealth {
  ok: boolean; lagComp: boolean; damage: boolean; tickRate: number; historyDurationMs: number;
  players: number; tick: number; recording: boolean;
}

export interface ProxyHealth {
  ok: boolean;
  slots: { slot: string; connected: boolean; upstreamOpen: boolean }[];
}

export class Stack {
  private procs: ChildProcess[] = [];
  private logs: string[] = [];

  constructor(readonly name: string, readonly lagComp: boolean, readonly ports: StackPorts) {}

  get proxyUrl() { return `ws://localhost:${this.ports.proxy}`; }
  get serverApi() { return `http://127.0.0.1:${this.ports.serverControl}`; }
  get proxyApi() { return `http://127.0.0.1:${this.ports.proxyControl}`; }

  private launch(file: string, env: Record<string, string>) {
    const child = spawn(process.execPath, ["--import", "tsx", file], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const keep = (d: Buffer) => { this.logs.push(String(d)); if (this.logs.length > 60) this.logs.shift(); };
    child.stdout!.on("data", keep);
    child.stderr!.on("data", keep);
    this.procs.push(child);
  }

  async start() {
    const p = this.ports;
    this.launch("server/src/index.ts", {
      PORT: String(p.server), CONTROL_PORT: String(p.serverControl),
      LAG_COMP: this.lagComp ? "1" : "0", DAMAGE: "0",
    });
    this.launch("proxy/src/index.ts", {
      PROXY_PORT: String(p.proxy), CONTROL_PORT: String(p.proxyControl), UPSTREAM: `ws://localhost:${p.server}`,
    });
    await this.waitFor(() => http<ServerHealth>("GET", `${this.serverApi}/health`), "server");
    await this.waitFor(() => http("GET", `${this.proxyApi}/health`), "proxy");
  }

  private async waitFor(probe: () => Promise<unknown>, what: string) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { await probe(); return; } catch {
        if (Date.now() > deadline) throw new Error(`${this.name} ${what} did not start. Last output:\n${this.logs.join("")}`);
        await sleep(200);
      }
    }
  }

  // Everything disconnected and the server has reset to a fresh world.
  async waitIdle(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [s, px] = await Promise.all([
        http<ServerHealth>("GET", `${this.serverApi}/health`),
        http<ProxyHealth>("GET", `${this.proxyApi}/health`),
      ]);
      if (s.players === 0 && px.slots.every((x) => !x.connected)) return;
      if (Date.now() > deadline) throw new Error(`${this.name} did not become idle (players=${s.players})`);
      await sleep(50);
    }
  }

  async stop() {
    for (const c of this.procs) if (!c.killed) c.kill();
    this.procs = [];
    await sleep(200);
  }
}
