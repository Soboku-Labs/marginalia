import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Visible text of an HTML fragment (for titles and search entries). */
export function stripTags(s: string): string {
  return unescapeHtml(s.replace(/<[^>]+>/g, "").replace(/\\\(|\\\)/g, "")).trim();
}

export function sha1(...parts: (string | Buffer)[]): string {
  const h = createHash("sha1");
  for (const p of parts) h.update(p).update("\0");
  return h.digest("hex");
}

export interface RunResult { code: number; stdout: string; stderr: string }

/** Run a command (no shell), optionally feeding it stdin. */
export function run(cmd: string, args: string[], opts: { input?: string; cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "ENOENT" ? new Error(`${cmd} not found: install it and make sure it is on PATH`) : e));
    child.on("close", (code) => resolve({
      code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"),
    }));
    child.stdin.on("error", () => { /* the command may exit before reading all input */ });
    child.stdin.end(opts.input ?? "");
  });
}

/** Run fn over items with at most `limit` at a time; results in input order. */
export async function mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>, limit = availableParallelism()): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** "CS 135" before "CS 1350", "02-x" before "10-x". */
export const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;
