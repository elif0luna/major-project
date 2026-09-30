import { WebSocketServer, WebSocket } from "ws";
import { Game } from "./game";
import {
  MAX_MSGS_PER_SEC, PING_INTERVAL_MS, TICK_MS, TICK_RATE,
} from "../shared/protocol";

export const now = (): number => Number(process.hrtime.bigint()) / 1e6; // monotonic ms

export function startServer(port: number, opts: { lagComp?: boolean } = {}) {
  const game = new Game({ lagComp: opts.lagComp ?? true });
  // maxPayload: tiny messages only. (ws already enables TCP_NODELAY on its sockets.)
  const wss = new WebSocketServer({ port, maxPayload: 1024 });
  const sockets = new Map<string, WebSocket>();

  wss.on("connection", (ws) => {
    const id = ["A", "B"].find((x) => !sockets.has(x));
    if (!id) { ws.close(1013, "room full"); return; }
    sockets.set(id, ws);
    game.addPlayer(id);
    ws.send(JSON.stringify({ type: "welcome", playerId: id, tickRate: TICK_RATE }));

    // PHASE 2: server-initiated ping; RTT measured entirely on the server's clock
    const pending = new Map<number, number>();
    let nonce = 0;
    const sendPing = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const n = nonce++;
      const t = now();
      pending.set(n, t);
      if (pending.size > 20) pending.delete(pending.keys().next().value as number);
      ws.send(JSON.stringify({ type: "ping", nonce: n, serverSendTime: t }));
    };
    sendPing();
    const pingTimer = setInterval(sendPing, PING_INTERVAL_MS);

    let count = 0;
    const rateTimer = setInterval(() => { count = 0; }, 1000);

    ws.on("message", (data) => {
      if (++count > MAX_MSGS_PER_SEC) { ws.close(1008, "rate limit"); return; }
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "input": game.handleInput(id, msg); break;
        case "pong": {
          const t0 = pending.get(msg.nonce);
          if (t0 !== undefined) { pending.delete(msg.nonce); game.addRttSample(id, now() - t0); }
          break;
        }
        case "cping": {
          if (typeof msg.clientTime !== "number" || !Number.isFinite(msg.clientTime)) break;
          const t1 = now();
          ws.send(JSON.stringify({ type: "cpong", clientTime: msg.clientTime, serverReceiveTime: t1, serverSendTime: now() }));
          break;
        }
      }
    });
    ws.on("close", () => {
      clearInterval(pingTimer); clearInterval(rateTimer);
      sockets.delete(id); game.removePlayer(id);
    });
    ws.on("error", () => ws.terminate());
  });

  // PHASE 1: drift-corrected fixed-timestep loop (accumulator against a monotonic clock)
  let next = now();
  let running = true;
  let timer: NodeJS.Timeout;
  const loop = () => {
    if (!running) return;
    let ran = 0;
    while (now() >= next && ran < 5) {
      const snaps = game.tick();
      for (const [pid, snap] of snaps) {
        const s = sockets.get(pid);
        if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(snap));
      }
      next += TICK_MS; ran++;
    }
    if (ran === 5) next = now() + TICK_MS; // fell too far behind: resync
    timer = setTimeout(loop, Math.max(1, next - now()));
  };
  loop();

  return {
    game, wss,
    close: () => { running = false; clearTimeout(timer); wss.clients.forEach((c) => c.terminate()); wss.close(); },
  };
}
