// Change proxy network conditions from the terminal (talks to the proxy control API).
//
//   pnpm netctl status                      relays connected? queue lengths
//   pnpm netctl config                      current config
//   pnpm netctl stats                       measured drop rate and delay per direction
//   pnpm netctl set A delay=100 jitter=10 loss=0.05 [dir=both|up|down] [seed=42]
//   pnpm netctl clear                       every slot back to a perfect network
//
// "up" = client -> server (toServer), "down" = server -> client (toClient). Values are one-way,
// so delay=100 on both directions adds about 200 ms of round trip.
declare const process: { argv: string[]; env: Record<string, string | undefined>; exit(code: number): never };

const API = process.env.PROXY_CONTROL ?? "http://127.0.0.1:8091";

async function call(method: string, path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(API + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    console.error(`cannot reach the proxy control API at ${API} (is "pnpm dev:proxy" running?)`);
    process.exit(1);
  }
  const json = await res.json();
  if (!res.ok) {
    console.error("error:", (json as { error?: string }).error ?? json);
    process.exit(1);
  }
  return json;
}

async function main() {
  const [cmd = "status", ...rest] = process.argv.slice(2);

  if (cmd === "status") return console.log(JSON.stringify(await call("GET", "/health"), null, 2));
  if (cmd === "config") return console.log(JSON.stringify(await call("GET", "/config"), null, 2));
  if (cmd === "stats") return console.log(JSON.stringify(await call("GET", "/stats"), null, 2));

  if (cmd === "clear") {
    const cfg = (await call("GET", "/config")) as { players: Record<string, unknown> };
    const ideal = { delayMs: 0, jitterMs: 0, loss: 0 };
    const players = Object.fromEntries(Object.keys(cfg.players).map((s) => [s, { toServer: ideal, toClient: ideal }]));
    await call("PUT", "/config", { players });
    await call("POST", "/stats/reset");
    return console.log("all slots set to a perfect network");
  }

  if (cmd === "set") {
    const [slot, ...pairs] = rest;
    if (!slot) throw new Error("usage: netctl set <slot> delay=MS jitter=MS loss=0..1 [dir=both|up|down] [seed=N]");
    const kv = Object.fromEntries(pairs.map((p) => p.split("=") as [string, string]));
    const dir = kv.dir ?? "both";
    const d: Record<string, number> = {};
    if (kv.delay !== undefined) d.delayMs = Number(kv.delay);
    if (kv.jitter !== undefined) d.jitterMs = Number(kv.jitter);
    if (kv.loss !== undefined) d.loss = Number(kv.loss);
    const seed = kv.seed !== undefined ? Number(kv.seed) : undefined;

    const player: Record<string, unknown> = {};
    if (dir === "both" || dir === "up") player.toServer = { ...d, ...(seed !== undefined ? { seed } : {}) };
    if (dir === "both" || dir === "down") player.toClient = { ...d, ...(seed !== undefined ? { seed: seed + 1 } : {}) };
    if (!player.toServer && !player.toClient) throw new Error(`dir must be both, up or down (got "${dir}")`);

    const cfg = (await call("PUT", "/config", { players: { [slot]: player } })) as { players: Record<string, unknown> };
    return console.log(JSON.stringify({ [slot]: cfg.players[slot] }, null, 2));
  }

  throw new Error(`unknown command "${cmd}" (status | config | stats | set | clear)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
