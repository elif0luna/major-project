// URL switches, so one build can act as both the control and the treatment:
//   ?pred=0      disable client-side prediction     (Phase 1 behaviour)
//   ?interp=0    disable remote interpolation       (draw latest snapshot)
//   ?port=8090   connect to this port instead of the game server, e.g. the Phase 7 proxy
//   ?slot=A      which proxy relay slot to use (optional; the proxy picks a free one)
const q = new URLSearchParams(location.search);
const port = Number(q.get("port"));

export const config = {
  prediction: q.get("pred") !== "0",
  interpolation: q.get("interp") !== "0",
  port: Number.isInteger(port) && port > 0 ? port : null,
  slot: q.get("slot"),
};
