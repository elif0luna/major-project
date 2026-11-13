// Phase 7: application-level network degradation proxy.
//
//   Client A <-> [relay slot A] <-> Server
//   Client B <-> [relay slot B] <-> Server
//
// Clients connect to ws://host:PROXY_PORT/?slot=A (slot optional: first free slot is used).
// For every client the proxy opens its own WebSocket to the game server and relays whole
// messages, delaying or dropping each one per direction. Nothing is done at the OS/TCP level.
//
// Control API (HTTP, localhost only) on CONTROL_PORT:
//   GET  /health        relay status, queue lengths
//   GET  /config        current per-slot, per-direction config
//   PUT  /config        { "players": { "A": { "toServer": {...}, "toClient": {...} } } }
//   GET  /stats         per-direction counters and measured delay distribution
//   POST /stats/reset
import http from "node:http";
import { WebSocketServer } from "ws";
import { Relay } from "./relay";

const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8090);
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 8091);
const UPSTREAM = process.env.UPSTREAM ?? "ws://localhost:8080";
const MAX_BODY = 64 * 1024;

const relay = new Relay(UPSTREAM);

const wss = new WebSocketServer({ port: PROXY_PORT });
wss.on("connection", (ws, req) => {
  const slot = new URL(req.url ?? "/", "http://proxy").searchParams.get("slot");
  relay.accept(ws, slot);
});

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "null"));
      } catch {
        reject(new Error("body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const control = http.createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://proxy").pathname;
  try {
    if (req.method === "GET" && path === "/health") return send(res, 200, relay.health());
    if (req.method === "GET" && path === "/config") return send(res, 200, relay.getConfig());
    if (req.method === "PUT" && path === "/config") {
      const result = relay.updateConfig(await readJson(req));
      return result.ok ? send(res, 200, result.config) : send(res, 400, { error: result.error });
    }
    if (req.method === "GET" && path === "/stats") return send(res, 200, relay.stats());
    if (req.method === "POST" && path === "/stats/reset") {
      relay.resetStats();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: `no route ${req.method} ${path}` });
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

control.listen(CONTROL_PORT, "127.0.0.1");

console.log(`proxy on ws://localhost:${PROXY_PORT} -> ${UPSTREAM}, control API http://127.0.0.1:${CONTROL_PORT}`);
