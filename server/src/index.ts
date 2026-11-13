import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  HISTORY_DURATION_MS, MAX_PLAYERS, SERVER_PORT as DEFAULT_SERVER_PORT, TICK_MS, TICK_RATE,
  decode, encode,
  type ClientMessage,
} from "@netcode/shared";
import { Game } from "./game";
import { Recorder } from "./recorder";
import { serverNow } from "./time";

// Experiment variable: LAG_COMP=0 disables compensation (the Phase 9 harness sets this).
const lagComp = process.env.LAG_COMP !== "0";
// Experiments: DAMAGE=0 keeps shots judged and logged but harmless, so OFF/ON trials stay matched.
const damage = process.env.DAMAGE !== "0";
const port = Number(process.env.PORT ?? DEFAULT_SERVER_PORT);
// Phase 8 control API (localhost only). Disabled unless CONTROL_PORT is set.
const controlPort = process.env.CONTROL_PORT ? Number(process.env.CONTROL_PORT) : null;

const recorder = new Recorder();
const newGame = () => new Game({ lagComp, damage, onShot: (rec) => recorder.onShot(rec) });
let game = newGame();
const wss = new WebSocketServer({ port });
const sockets = new Map<WebSocket, number>();

wss.on("connection", (ws) => {
  if (sockets.size >= MAX_PLAYERS) {
    ws.close(1013, "server full"); // 1013 = try again later
    console.log("rejected connection: server full");
    return;
  }

  const id = game.addPlayer();
  sockets.set(ws, id);
  ws.send(encode({ t: "welcome", id, tickRate: TICK_RATE, lagComp }));
  console.log(`player ${id} connected (${sockets.size} online)`);

  ws.on("message", (data) => {
    const msg = decode<ClientMessage>(data.toString());
    if (!msg) return;

    if (msg.t === "input") {
      game.queueInput(id, msg);
    } else if (msg.t === "ping") {
      ws.send(encode({ t: "pong", clientTime: msg.clientTime, serverTime: serverNow() }));
      if (
        typeof msg.offset === "number" && typeof msg.rtt === "number" &&
        Number.isFinite(msg.offset) && Number.isFinite(msg.rtt)
      ) {
        game.setClock(id, msg.offset, msg.rtt);
      }
    }
  });

  ws.on("close", () => {
    game.removePlayer(id);
    sockets.delete(ws);
    console.log(`player ${id} left`);
    // Last player gone: start from a fresh, deterministic world (ids restart at 1, spawns reset).
    if (sockets.size === 0) game = newGame();
  });
});

// Drift-corrected fixed-timestep loop (setInterval drifts and bunches up).
let next = performance.now() + TICK_MS;
function loop() {
  recorder.onTick(performance.now());
  game.update();
  const payload = encode(game.snapshot());
  for (const ws of sockets.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
  next += TICK_MS;
  setTimeout(loop, Math.max(0, next - performance.now()));
}
loop();

if (controlPort !== null) {
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "null")); } catch { resolve(null); }
      });
    });

  http.createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://server").pathname;
    if (req.method === "GET" && path === "/health") {
      return send(res, 200, {
        ok: true, lagComp, damage, tickRate: TICK_RATE, historyDurationMs: HISTORY_DURATION_MS,
        players: sockets.size, tick: game.tick, recording: recorder.active,
      });
    }
    if (req.method === "POST" && path === "/trial/begin") {
      const body = (await readBody(req)) as { trialId?: unknown } | null;
      if (!body || typeof body.trialId !== "string") return send(res, 400, { error: "body must be { trialId: string }" });
      recorder.begin(body.trialId);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/trial/end") {
      const rec = recorder.end();
      return rec ? send(res, 200, rec) : send(res, 409, { error: "no trial is being recorded" });
    }
    send(res, 404, { error: `no route ${req.method} ${path}` });
  }).listen(controlPort, "127.0.0.1");
  console.log(`server control API on http://127.0.0.1:${controlPort}`);
}

console.log(
  `server on ws://localhost:${port} @ ${TICK_RATE} Hz, lag compensation ${lagComp ? "ON" : "OFF"}, damage ${damage ? "ON" : "OFF"}`,
);
