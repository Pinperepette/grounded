import {
  appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";

export function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

const ROOT_MARKERS = [
  ".git", "package.json", "CLAUDE.md", "pyproject.toml",
  "Cargo.toml", "go.mod", "pom.xml", "build.gradle",
];

export function findProjectRoot(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function isPathUnder(filePath: string, root: string): boolean {
  const a = resolve(filePath);
  const b = resolve(root);
  return a === b || a.startsWith(b + "/");
}

export function readClaudeMd(projectRoot: string): string | null {
  const p = join(projectRoot, "CLAUDE.md");
  try {
    return existsSync(p) ? readFileSync(p, "utf-8") : null;
  } catch {
    return null;
  }
}

export async function readStdin(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on("error", reject);
  });
}

export function approve(): void {
  process.stdout.write(JSON.stringify({ decision: "approve" }));
}

export function block(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

export function blockWithHint(reason: string, hint?: string): void {
  const out: Record<string, unknown> = { decision: "block", reason };
  if (hint) out.hookSpecificOutput = { hookEventName: "PreToolUse", additionalSystemPrompt: hint };
  process.stdout.write(JSON.stringify(out));
}

export function postOk(): void {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
}

// ─── Hook supervisor ──────────────────────────────────────────────────────────
// Goal: a hook that crashes must NEVER prevent Claude Code from working.
// Strategy: catch any uncaught error, log it to a stable file for diagnosis,
// emit a safe fail-open response, and exit 0 (a non-zero exit can be surfaced
// to the model as a hook failure — we want crashes to be invisible).

const ERROR_LOG_MAX_BYTES = 256 * 1024;

function errorLogPath(): string {
  if (process.env.GROUNDED_ERROR_LOG) return process.env.GROUNDED_ERROR_LOG;
  return join(process.env.HOME ?? "/tmp", ".claude", "grounded-errors.log");
}

export function logHookError(hookName: string, err: unknown): void {
  try {
    const path = errorLogPath();
    mkdirSync(dirname(path), { recursive: true });

    // Naive size-based rotation: keep last half when over cap.
    try {
      if (statSync(path).size > ERROR_LOG_MAX_BYTES) {
        const lines = readFileSync(path, "utf-8").split("\n");
        writeFileSync(path, lines.slice(Math.floor(lines.length / 2)).join("\n"));
      }
    } catch { /* file does not exist yet — first write will create it */ }

    const stack = err instanceof Error && err.stack
      ? err.stack.split("\n").slice(0, 8).join("\n")
      : undefined;
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      hook: hookName,
      error: err instanceof Error ? err.message : String(err),
      stack,
    }) + "\n";
    appendFileSync(path, entry);
  } catch {
    // Best-effort logging only. Never propagate.
  }
}

export type FailOpenWriter = () => void;

/**
 * Wrap a hook's async main():
 * - on success, exit 0
 * - on uncaught error, log + write a safe response + exit 0
 *
 * Pass a `failOpen` writer matching the hook's event:
 *   • PreToolUse / Stop  → approve (default)
 *   • PostToolUse / UserPromptSubmit → postOk
 */
export function superviseHook(
  name: string,
  fn: () => Promise<void>,
  failOpen: FailOpenWriter = approve,
): void {
  let fired = false;
  const handle = (err: unknown): void => {
    if (fired) return;
    fired = true;
    logHookError(name, err);
    try { failOpen(); } catch { /* swallow */ }
    process.exit(0);
  };
  process.on("uncaughtException", handle);
  process.on("unhandledRejection", handle);
  fn().catch(handle);
}
