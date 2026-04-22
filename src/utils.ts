import { existsSync, readFileSync } from "fs";
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
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))));
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
