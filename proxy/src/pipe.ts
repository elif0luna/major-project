// Phase 7: one FIFO send queue per direction. A single timer serves the head of the
// queue, so messages leave in exactly the order they were scheduled. (One setTimeout per
// message could fire out of order when two send times are within the same millisecond.)
import type { Link } from "./link";

// Read the message type without parsing the whole JSON. Every message is encoded as
// {"t":"...", ...}; anything else falls into the "" stream.
export function streamKeyOf(data: string): string {
  const m = /^\{"t":"(\w{1,16})"/.exec(data);
  return m ? m[1]! : "";
}

export class Pipe {
  private queue: { at: number; data: string }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private link: Link,
    private deliver: (data: string) => void,
    private now: () => number = () => performance.now(),
  ) {}

  push(data: string) {
    if (this.closed) return;
    const t = this.now();
    const at = this.link.schedule(t, streamKeyOf(data));
    if (at === null) return; // dropped

    // Ideal link and nothing waiting: forward synchronously instead of adding a timer tick.
    if (this.queue.length === 0 && at <= t) {
      this.deliver(data);
      return;
    }
    this.queue.push({ at, data });
    this.arm();
  }

  get pending() {
    return this.queue.length;
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }

  private arm() {
    if (this.timer || this.queue.length === 0) return;
    this.timer = setTimeout(() => this.flush(), Math.max(0, this.queue[0]!.at - this.now()));
  }

  private flush() {
    this.timer = null;
    const t = this.now();
    // Timers have ~1 ms granularity, so allow messages due within the next millisecond.
    while (this.queue.length > 0 && this.queue[0]!.at <= t + 1) {
      this.deliver(this.queue.shift()!.data);
    }
    this.arm();
  }
}
