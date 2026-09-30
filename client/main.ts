import { GameClient } from "./core";
import { ARENA_HEIGHT, ARENA_WIDTH, PLAYER_RADIUS, TAG_RADIUS } from "../shared/protocol";

const q = new URLSearchParams(location.search);
const client = new GameClient({
  url: `ws://${location.hostname}:8080`,
  WS: WebSocket,
  now: () => performance.now(),
  predict: q.get("predict") !== "0", // ?predict=0  -> Phase 1 dumb client
  interp: q.get("interp") !== "0",   // ?interp=0   -> render latest snapshot
  fakeLagMs: Number(q.get("lag") ?? 0), // ?lag=50 -> 50 ms each way (testing before the proxy exists)
});
client.connect();

const keys = new Set<string>();
addEventListener("keydown", (e) => { keys.add(e.code); if (e.code === "Space") e.preventDefault(); });
addEventListener("keyup", (e) => keys.delete(e.code));

client.startInputLoop(() => {
  const dx = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
  const dy = (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) - (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0);
  const tag = keys.has("Space");
  return { dx, dy, tag };
});

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const circle = (x: number, y: number, r: number, fill: string, stroke?: string) => {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
};

function draw() {
  ctx.clearRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
  ctx.strokeStyle = "#444"; ctx.strokeRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
  const last = client.snaps[client.snaps.length - 1];
  if (last) {
    // debug ghosts: raw latest server positions (faint)
    for (const p of last.players) circle(p.x, p.y, PLAYER_RADIUS, "", "rgba(150,150,150,0.5)");
    const opp = client.opponentRendered();
    if (opp) { circle(opp.x, opp.y, PLAYER_RADIUS, "#e5484d"); circle(opp.x, opp.y, TAG_RADIUS, "", "rgba(229,72,77,0.4)"); }
  }
  circle(client.local.x, client.local.y, PLAYER_RADIUS, "#3e63dd");
  const lastEv = client.events[client.events.length - 1];
  ctx.fillStyle = "#ddd"; ctx.font = "13px monospace";
  const c = client.corrections;
  ctx.fillText(
    `you: ${client.playerId || "-"}  RTT(client): ${client.clock.rtt.toFixed(0)} ms  offset: ${client.clock.offset.toFixed(0)}  ` +
    `last correction: ${(c[c.length - 1] ?? 0).toFixed(2)}  predict=${q.get("predict") !== "0"} interp=${q.get("interp") !== "0"}`, 10, 18);
  if (lastEv) ctx.fillText(`last tag: ${lastEv.attackerId}->${lastEv.targetId} ${lastEv.accepted ? "HIT" : "miss"}`, 10, 36);
  requestAnimationFrame(draw);
}
draw();
