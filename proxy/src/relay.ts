// Phase 7: per-player relay slots. Each slot owns two Links (to_server, to_client) whose
// config survives reconnects, so the harness can configure a slot before a bot connects.
import { WebSocket, type RawData } from "ws";
import { IDEAL, Link, validateDirection, type DirectionConfig } from "./link";
import { Pipe } from "./pipe";

export interface PlayerNetworkConfig {
  toServer: DirectionConfig;
  toClient: DirectionConfig;
}

export interface ProxyConfig {
  players: Record<string, PlayerNetworkConfig>;
}

interface Connection {
  client: WebSocket;
  upstream: WebSocket;
  toServer: Pipe;
  toClient: Pipe;
  backlog: string[]; // client messages that left the pipe before the upstream socket opened
  connectedAt: number;
}

interface Slot {
  name: string;
  toServer: Link;
  toClient: Link;
  conn: Connection | null;
}

const SLOT_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const DIRECTIONS = ["toServer", "toClient"] as const;

// Close codes 1005/1006 are reserved and cannot be sent on the wire.
const sendableCode = (code: number) => (code === 1005 || code === 1006 ? 1000 : code);
const text = (data: RawData) => (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)).toString();

export class Relay {
  private slots = new Map<string, Slot>();

  constructor(private upstreamUrl: string, defaultSlots: string[] = ["A", "B"]) {
    for (const name of defaultSlots) this.slot(name);
  }

  private slot(name: string): Slot {
    let s = this.slots.get(name);
    if (!s) {
      s = { name, toServer: new Link(IDEAL), toClient: new Link({ ...IDEAL, seed: 2 }), conn: null };
      this.slots.set(name, s);
    }
    return s;
  }

  // ---------- WebSocket side ----------

  accept(client: WebSocket, requestedSlot: string | null) {
    let slot: Slot | undefined;
    if (requestedSlot !== null) {
      if (!SLOT_NAME.test(requestedSlot)) return client.close(1008, "invalid slot name");
      slot = this.slot(requestedSlot);
      if (slot.conn) return client.close(1013, `slot ${requestedSlot} is in use`);
    } else {
      slot = [...this.slots.values()].find((s) => !s.conn);
      if (!slot) return client.close(1013, "no free proxy slot");
    }

    const upstream = new WebSocket(this.upstreamUrl);
    slot.toServer.resetQueue();
    slot.toClient.resetQueue();

    const conn: Connection = {
      client,
      upstream,
      backlog: [],
      connectedAt: Date.now(),
      toServer: new Pipe(slot.toServer, (data) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
        else conn.backlog.push(data);
      }),
      toClient: new Pipe(slot.toClient, (data) => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
      }),
    };
    slot.conn = conn;
    const s = slot;
    console.log(`[proxy] slot ${s.name}: client connected`);

    upstream.on("open", () => {
      for (const data of conn.backlog) upstream.send(data);
      conn.backlog = [];
    });
    client.on("message", (data) => conn.toServer.push(text(data)));
    upstream.on("message", (data) => conn.toClient.push(text(data)));

    const teardown = (why: string, code: number, reason: string) => {
      if (s.conn !== conn) return;
      s.conn = null;
      conn.toServer.close();
      conn.toClient.close();
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(sendableCode(code), reason);
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, "client left");
      else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      console.log(`[proxy] slot ${s.name}: ${why}`);
    };
    client.on("close", () => teardown("client disconnected", 1000, ""));
    upstream.on("close", (code, reason) => teardown(`server closed (${code} ${reason})`, code, reason.toString()));
    upstream.on("error", () => teardown("server unreachable", 1011, "proxy cannot reach game server"));
    client.on("error", () => teardown("client socket error", 1011, ""));
  }

  // ---------- control API side ----------

  getConfig(): ProxyConfig {
    const players: Record<string, PlayerNetworkConfig> = {};
    for (const s of this.slots.values()) players[s.name] = { toServer: s.toServer.config, toClient: s.toClient.config };
    return { players };
  }

  // Validates everything first, then applies all changes, so a bad request changes nothing.
  // Directions may be partial ({ "delayMs": 50 }); missing fields keep their current value.
  // Every direction mentioned is re-seeded (its random stream restarts).
  updateConfig(body: unknown): { ok: true; config: ProxyConfig } | { ok: false; error: string } {
    if (!body || typeof body !== "object" || !("players" in body)) return { ok: false, error: "body must be { players: {...} }" };
    const players = (body as { players: unknown }).players;
    if (!players || typeof players !== "object") return { ok: false, error: "players must be an object" };

    const changes: { slot: string; dir: (typeof DIRECTIONS)[number]; cfg: DirectionConfig }[] = [];
    for (const [name, value] of Object.entries(players)) {
      if (!SLOT_NAME.test(name)) return { ok: false, error: `invalid slot name "${name}"` };
      if (!value || typeof value !== "object") return { ok: false, error: `players.${name} must be an object` };
      const current = this.slots.get(name);
      for (const dir of DIRECTIONS) {
        const partial = (value as Record<string, unknown>)[dir];
        if (partial === undefined) continue;
        if (!partial || typeof partial !== "object") return { ok: false, error: `players.${name}.${dir} must be an object` };
        const base = current ? current[dir].config : IDEAL;
        const merged = { ...base, ...(partial as object) } as DirectionConfig;
        const err = validateDirection(merged);
        if (err) return { ok: false, error: `players.${name}.${dir}: ${err}` };
        changes.push({ slot: name, dir, cfg: merged });
      }
    }

    for (const c of changes) this.slot(c.slot)[c.dir].setConfig(c.cfg);
    if (changes.length) console.log(`[proxy] config updated: ${changes.map((c) => `${c.slot}.${c.dir}`).join(", ")}`);
    return { ok: true, config: this.getConfig() };
  }

  health() {
    return {
      ok: true,
      upstream: this.upstreamUrl,
      slots: [...this.slots.values()].map((s) => ({
        slot: s.name,
        connected: s.conn !== null,
        upstreamOpen: s.conn?.upstream.readyState === WebSocket.OPEN,
        pendingToServer: s.conn?.toServer.pending ?? 0,
        pendingToClient: s.conn?.toClient.pending ?? 0,
      })),
    };
  }

  stats() {
    const out: Record<string, unknown> = {};
    for (const s of this.slots.values()) out[s.name] = { toServer: s.toServer.stats, toClient: s.toClient.stats };
    return out;
  }

  resetStats() {
    for (const s of this.slots.values()) {
      s.toServer.resetStats();
      s.toClient.resetStats();
    }
  }
}
