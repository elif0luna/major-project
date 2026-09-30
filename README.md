# multiplayer-netcode (Phases 1-5)

Setup: install Node.js 20+, then `npm install`.

Run (3 terminals):
1. `npm run server`   (lag compensation ON)   or   `npm run server -- --comp=off`
2. `npm run client`   (Vite dev server)
3. Open TWO separate browser WINDOWS side by side (not tabs; background tabs throttle timers):
   http://localhost:5173/client/   and   http://localhost:5173/client/?lag=50

Client URL flags: `?predict=0` (Phase 1 dumb client), `?interp=0` (no interpolation),
`?lag=50` (test-only 50 ms artificial delay each way; replaced by the Phase 7 proxy).

Checks: `npm run typecheck`, `npm test` (10 game tests + end-to-end smoke test).

Layout:
- shared/  constants, messages, and the ONE movement function used by client and server
- server/game.ts  simulation, validation, history, lag compensation
- server/server.ts  ws, server-side ping, drift-corrected 60 Hz loop
- client/core.ts  DOM-free: prediction, reconciliation, interpolation, clocks (reused by Phase 9 bots)
- client/main.ts + index.html  canvas + keyboard
