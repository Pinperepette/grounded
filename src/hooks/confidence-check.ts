#!/usr/bin/env node
/**
 * Stop hook — matcher: ""
 *
 * Confidence Check: before Claude's response reaches the user, extract every
 * code identifier it claimed (functions, classes, files) and verify each one
 * actually exists in the codebase via rg.
 *
 * If any identifier is NOT FOUND → block the Stop event and force a correction.
 * The model must revise its answer before it's allowed to finish.
 *
 * stop_hook_active=true means we already blocked once this turn — don't loop.
 */
import { execFile, ExecFileException } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import { logDecision, loadState } from "../state.js";
import { findProjectRoot, readStdin } from "../utils.js";
import { recordEvent } from "../scoring.js";

const execFileAsync = promisify(execFile);

// ─── Identifier extraction ────────────────────────────────────────────────────
// We only extract identifiers that appear with explicit claim language.
// This keeps false positives low — we're not checking every backtick, only
// identifiers the model is actively asserting exist in this specific codebase.

const CLAIM_PATTERNS: RegExp[] = [
  // "function `foo`"  "method `foo`"  "def `foo`"
  /(?:function|method|def)\s+`([A-Za-z_]\w+)`/gi,
  // "`foo` function"  "`foo` method"  "`foo` class"
  /`([A-Za-z_]\w+)`\s+(?:function|method|class)/gi,
  // "class `Foo`"
  /\bclass\s+`([A-Z]\w+)`/g,
  // "`foo()`"  — function call syntax signals a concrete claim
  /`([A-Za-z_]\w{2,})\(\)`/g,
  // file paths in backticks
  /`([\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|cpp|cs|swift))`/g,
  // "in `file.ts`"  "at `file.ts`"  "from `file.ts`"
  /(?:in|at|from|inside|see)\s+`([\w./-]+)`/gi,
  // "the `FooBar` class/component/hook/store/service"
  /the\s+`([A-Z]\w+)`\s+(?:class|component|hook|store|service|interface|type|enum)/gi,
];

// Identifiers that are certainly from external libraries or language builtins —
// no point searching the project for these.
const EXTERNAL = new Set([
  "React", "ReactDOM", "useState", "useEffect", "useRef", "useCallback",
  "useMemo", "useContext", "useReducer", "useLayoutEffect",
  "Promise", "Array", "Object", "String", "Number", "Boolean", "Symbol",
  "Map", "Set", "WeakMap", "WeakSet", "Error", "TypeError", "console",
  "process", "Buffer", "setTimeout", "setInterval", "clearTimeout",
  "describe", "it", "test", "expect", "beforeEach", "afterEach", "jest",
  "Express", "Router", "Request", "Response", "NextFunction",
  "prisma", "mongoose", "sequelize", "knex",
  "Component", "PureComponent", "Fragment", "Suspense", "StrictMode",
]);

function extractClaims(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const pattern of CLAIM_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const id = m[1].trim();
      if (
        id.length >= 3 &&
        !seen.has(id) &&
        !EXTERNAL.has(id)
      ) {
        seen.add(id);
        result.push(id);
      }
    }
  }

  return result;
}

// ─── Codebase verification ────────────────────────────────────────────────────

async function existsInCodebase(identifier: string, root: string): Promise<boolean> {
  // Fast path: if it looks like a file path, check the filesystem directly
  if (/[./]/.test(identifier)) {
    if (existsSync(identifier)) return true;
    if (existsSync(`${root}/${identifier}`)) return true;
    // Fall through to rg for relative paths that might be in subdirs
  }

  // Use rg with word-boundary match, bail on first hit for speed
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["--max-count=1", "--no-heading", "-l", `\\b${identifier}\\b`, root],
      { timeout: 5000 }
    );
    return stdout.trim().length > 0;
  } catch (e) {
    const err = e as ExecFileException & { code?: number };
    // rg exits 1 = no match, 2 = error
    if (err.code === 1) return false;
    // On rg error, assume it exists to avoid false-positive blocks
    return true;
  }
}

// ─── Extract last assistant text from transcript ──────────────────────────────

function extractLastResponse(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;

  // Format A: {transcript: [{role, content}]}
  const transcript = d["transcript"];
  if (Array.isArray(transcript)) {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const msg = transcript[i] as Record<string, unknown>;
      if (msg["role"] !== "assistant") continue;
      const content = msg["content"];
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((b: unknown) => (b as Record<string, unknown>)["type"] === "text")
          .map((b: unknown) => (b as Record<string, unknown>)["text"] as string)
          .join("\n");
      }
    }
  }

  // Format B: direct response text on the event
  if (typeof d["response"] === "string") return d["response"];
  if (typeof d["message"] === "string") return d["message"];

  return "";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const data = await readStdin() as Record<string, unknown>;

  // stop_hook_active=true means we already intervened this turn.
  // Approve unconditionally to avoid an infinite block loop.
  if (data["stop_hook_active"] === true) {
    logDecision({ hook: "confidence-check", tool: "Stop", action: "APPROVE",
      detail: "second fire — approving to avoid loop" });
    process.stdout.write(JSON.stringify({ decision: "approve" }));
    return;
  }

  const root = findProjectRoot();
  if (!root) {
    process.stdout.write(JSON.stringify({ decision: "approve" }));
    return;
  }

  const responseText = extractLastResponse(data);
  if (!responseText) {
    process.stdout.write(JSON.stringify({ decision: "approve" }));
    return;
  }

  const claims = extractClaims(responseText);
  if (claims.length === 0) {
    process.stdout.write(JSON.stringify({ decision: "approve" }));
    return;
  }

  // Verify all claims in parallel
  const checks = await Promise.all(
    claims.map(async (id) => ({
      id,
      found: await existsInCodebase(id, root),
    }))
  );

  const hallucinated = checks.filter((c) => !c.found).map((c) => c.id);

  if (hallucinated.length === 0) {
    recordEvent("CLAIMS_VERIFIED");
    logDecision({ hook: "confidence-check", tool: "Stop", action: "APPROVE",
      detail: `verified: ${claims.join(", ")}` });
    process.stdout.write(JSON.stringify({ decision: "approve" }));
    return;
  }

  recordEvent("HALLUCINATION_FOUND");
  logDecision({
    hook: "confidence-check",
    tool: "Stop",
    action: "BLOCK",
    detail: `hallucinated: ${hallucinated.join(", ")}`,
  });

  const list = hallucinated.map((id) => `  - \`${id}\``).join("\n");

  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `BLOCKED [confidence]: hallucinated identifiers: ${hallucinated.join(", ")} — Grep each, then revise`,
    })
  );
}

main().catch(() => {
  // On unexpected error, never block — just approve
  process.stdout.write(JSON.stringify({ decision: "approve" }));
});
