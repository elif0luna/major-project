// Deletes the experiment database (data/experiments.sqlite) so the next sweep starts clean.
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./stack";

const path = resolve(ROOT, process.argv[2] ?? "data/experiments.sqlite");
for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
console.log(`removed ${path}`);
