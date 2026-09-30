import { ARENA_HEIGHT, ARENA_WIDTH, DT, MAX_SPEED, PLAYER_RADIUS } from "./protocol";

export type Kinematic = { x: number; y: number; vx: number; vy: number };

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Returns a finite value clamped to [-1, 1], or null if the input is not a finite number. */
export function sanitizeAxis(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return clamp(v, -1, 1);
}

/** ONE movement function used by BOTH server and client prediction (must stay identical). */
export function stepMovement(p: Kinematic, dx: number, dy: number): void {
  const mag = Math.sqrt(dx * dx + dy * dy);
  let nx = 0;
  let ny = 0;
  if (mag > 0) {
    nx = dx / mag;
    ny = dy / mag;
  }
  p.vx = nx * MAX_SPEED;
  p.vy = ny * MAX_SPEED;
  p.x = clamp(p.x + p.vx * DT, PLAYER_RADIUS, ARENA_WIDTH - PLAYER_RADIUS);
  p.y = clamp(p.y + p.vy * DT, PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS);
}
