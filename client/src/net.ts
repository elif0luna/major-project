import { SERVER_PORT, decode, encode, type ClientMessage, type ServerMessage } from "@netcode/shared";
import { config } from "./config";

interface Handlers {
  onOpen: () => void;
  onMessage: (m: ServerMessage) => void;
  onClose: (reason: string) => void;
}

export class Net {
  private ws: WebSocket;
  readonly route: string; // shown in the HUD: "direct :8080" or "proxy :8090 slot A"

  constructor(handlers: Handlers) {
    const envPort = Number(import.meta.env.VITE_SERVER_PORT);
    const port = config.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : SERVER_PORT);
    const query = config.slot ? `?slot=${encodeURIComponent(config.slot)}` : "";
    this.route = port === SERVER_PORT ? `direct :${port}` : `via :${port}${config.slot ? ` slot ${config.slot}` : ""}`;

    this.ws = new WebSocket(`ws://${location.hostname}:${port}/${query}`);
    this.ws.onopen = () => handlers.onOpen();
    this.ws.onclose = (e) => handlers.onClose(e.reason || "connection closed");
    this.ws.onmessage = (e) => {
      const m = decode<ServerMessage>(e.data as string);
      if (m) handlers.onMessage(m);
    };
  }

  send(msg: ClientMessage) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg)); // timestamps are already inside msg
  }
}
