#!/usr/bin/env node
/**
 * Test harness for grounded hooks.
 *
 * Each hook reads JSON from stdin and writes JSON to stdout.
 * Tests pipe synthetic inputs and assert on the output.
 *
 * Usage: npm test
 */
import { spawnSync } from "child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "fs";
import { join, resolve } from "path";
import { tmpdir, homedir } from "os";

// ── Terminal colors ───────────────────────────────────────────────────────────
const G     = "\x1b[32m✓\x1b[0m";
const R     = "\x1b[31m✗\x1b[0m";
const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const RESET = "\x1b[0m";

// ── Setup ─────────────────────────────────────────────────────────────────────
const HOOKS_DIR = resolve(__dirname, "..", "hooks");
const TMP       = mkdtempSync(join(tmpdir(), "grounded-test-"));
let passed = 0, failed = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionStart:     Date.now(),
    readFiles:        {},
    grepPatterns:     [],
    toolCallLog:      [],
    decisionLog:      [],
    projectRoot:      null,
    score:            0,
    scoreLog:         [],
    eventCounts:      {},
    recentSequence:   [],
    notFoundPatterns: [],
    grepResults:      {},
    ...overrides,
  };
}

function stateFile(id: string): string {
  return join(TMP, `s-${id}.json`);
}

function writeState(id: string, state: Record<string, unknown>): void {
  writeFileSync(stateFile(id), JSON.stringify(state));
}

function readState(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(stateFile(id), "utf-8")) as Record<string, unknown>;
}

interface HookOutput {
  decision?:          string;
  continue?:          boolean;
  hookSpecificOutput?: Record<string, unknown>;
  raw:                string;
}

function runHook(hook: string, input: unknown, stateId: string): HookOutput {
  const result = spawnSync("node", [join(HOOKS_DIR, `${hook}.js`)], {
    input:    JSON.stringify(input),
    env:      { ...process.env, GROUNDED_STATE_FILE: stateFile(stateId) },
    encoding: "utf-8",
    timeout:  8000,
  });
  try {
    const p = JSON.parse(result.stdout) as Record<string, unknown>;
    return {
      decision:           p["decision"] as string | undefined,
      continue:           p["continue"] as boolean | undefined,
      hookSpecificOutput: p["hookSpecificOutput"] as Record<string, unknown> | undefined,
      raw:                result.stdout,
    };
  } catch {
    return { raw: `stdout: ${result.stdout}\nstderr: ${result.stderr}` };
  }
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ${G} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${R} ${name}`);
    console.log(`    ${DIM}${(e as Error).message}${RESET}`);
    failed++;
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// scope-guard
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}scope-guard${RESET}`);

test("blocks .env write (sensitive file)", () => {
  writeState("sg1", emptyState({ projectRoot: TMP }));
  const r = runHook("scope-guard", {
    tool_name: "Write", tool_input: { file_path: join(TMP, ".env") },
  }, "sg1");
  eq(r.decision, "block", "decision");
});

test("blocks secret.key write (sensitive file)", () => {
  writeState("sg2", emptyState({ projectRoot: TMP }));
  const r = runHook("scope-guard", {
    tool_name: "Write", tool_input: { file_path: join(TMP, "secret.key") },
  }, "sg2");
  eq(r.decision, "block", "decision");
});

test("blocks /etc/hosts write (system path)", () => {
  writeState("sg3", emptyState({ projectRoot: TMP }));
  const r = runHook("scope-guard", {
    tool_name: "Write", tool_input: { file_path: "/etc/hosts" },
  }, "sg3");
  eq(r.decision, "block", "decision");
});

test("approves write inside project root", () => {
  writeState("sg4", emptyState({ projectRoot: TMP }));
  const r = runHook("scope-guard", {
    tool_name: "Write", tool_input: { file_path: join(TMP, "src", "foo.ts") },
  }, "sg4");
  eq(r.decision, "approve", "decision");
});

test("approves write to ~/.claude (always allowed)", () => {
  writeState("sg5", emptyState({ projectRoot: TMP }));
  const target = join(homedir(), ".claude", "memory", "test.md");
  const r = runHook("scope-guard", {
    tool_name: "Write", tool_input: { file_path: target },
  }, "sg5");
  eq(r.decision, "approve", "decision");
});

test("warns (not blocks) for out-of-scope path in warn mode", () => {
  writeState("sg6", emptyState({ projectRoot: TMP }));
  // Must be outside ALWAYS_ALLOWED in scope-guard.ts: /tmp, /private/tmp,
  // ~/.claude, ~/Desktop. tmpdir() resolves to /tmp on Linux which is
  // always-allowed, so the path needs to be on a synthetic root that no
  // platform considers allowed.
  const outside = "/opt/grounded-test-out-of-scope/file.ts";
  const r = runHook("scope-guard", {
    tool_name: "Write", tool_input: { file_path: outside },
  }, "sg6");
  eq(r.decision, "approve", "decision — warn mode should approve");
  ok(r.hookSpecificOutput !== undefined, "should inject warning in hookSpecificOutput");
});

test("no false positive: read-only Bash not checked", () => {
  writeState("sg7", emptyState({ projectRoot: TMP }));
  const r = runHook("scope-guard", {
    tool_name: "Bash",
    tool_input: { command: "head -5 /tmp/somefile.csv" },
  }, "sg7");
  eq(r.decision, "approve", "read-only Bash skips scope check");
});

test("scope-guard blocks Bash write to system path", () => {
  writeState("sg8", emptyState({ projectRoot: TMP }));
  const sysPath = "/usr/bin/env";
  const r = runHook("scope-guard", {
    tool_name: "Bash",
    tool_input: { command: "echo test > " + sysPath },
  }, "sg8");
  eq(r.decision, "block", "redirect to system path blocked");
});

test("no false positive: 2>/dev/null not treated as write", () => {
  writeState("sg9", emptyState({ projectRoot: TMP }));
  const r = runHook("scope-guard", {
    tool_name: "Bash",
    tool_input: { command: "grep -q pattern /some/file 2>/dev/null && cat /private/tmp/output.txt" },
  }, "sg9");
  eq(r.decision, "approve", "stderr redirect to /dev/null is not a write");
});

// ─────────────────────────────────────────────────────────────────────────────
// edit-guard
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}edit-guard${RESET}`);

const sampleFile = join(TMP, "sample.ts");
writeFileSync(sampleFile, [
  "export function greet(name: string): string {",
  "  return `Hello, ${name}!`;",
  "}",
].join("\n") + "\n");

test("approves new file write (file does not exist)", () => {
  writeState("eg1", emptyState());
  const r = runHook("edit-guard", {
    tool_name: "Write", tool_input: { file_path: join(TMP, "newfile.ts") },
  }, "eg1");
  eq(r.decision, "approve", "decision");
});

test("approves edit of unread file (gate 1 off by default)", () => {
  writeState("eg2", emptyState());
  // requireReadBeforeEdit defaults to false — gate 1 disabled
  const r = runHook("edit-guard", {
    tool_name: "Edit",
    tool_input: { file_path: sampleFile, old_string: "export function greet", new_string: "export function hi" },
  }, "eg2");
  eq(r.decision, "approve", "decision — gate 1 off, old_string exists");
});

test("blocks edit with wrong old_string", () => {
  writeState("eg3", emptyState({ readFiles: { [sampleFile]: Date.now() - 1000 } }));
  const r = runHook("edit-guard", {
    tool_name: "Edit",
    tool_input: {
      file_path:  sampleFile,
      old_string: "THIS_STRING_DOES_NOT_EXIST_IN_THE_FILE",
      new_string: "replacement",
    },
  }, "eg3");
  eq(r.decision, "block", "decision");
});

test("approves edit with correct old_string after read", () => {
  writeState("eg4", emptyState({ readFiles: { [sampleFile]: Date.now() - 1000 } }));
  const r = runHook("edit-guard", {
    tool_name: "Edit",
    tool_input: {
      file_path:  sampleFile,
      old_string: "export function greet(name: string): string {",
      new_string: "export function greet(name: string): string { // updated",
    },
  }, "eg4");
  eq(r.decision, "approve", "decision");
});

// ─────────────────────────────────────────────────────────────────────────────
// anti-bypass
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}anti-bypass${RESET}`);

test("approves clean tool call (no not-found patterns)", () => {
  writeState("ab1", emptyState());
  const r = runHook("anti-bypass", {
    tool_name: "Edit",
    tool_input: { file_path: "src/auth.ts", old_string: "verifyUser", new_string: "checkUser" },
  }, "ab1");
  eq(r.decision, "approve", "decision");
});

test("blocks tool referencing known-not-found identifier", () => {
  writeState("ab2", emptyState({ notFoundPatterns: ["parseToken"] }));
  const r = runHook("anti-bypass", {
    tool_name: "Edit",
    tool_input: { file_path: "src/auth.ts", old_string: "parseToken()", new_string: "verifyToken()" },
  }, "ab2");
  eq(r.decision, "block", "decision");
  ok(r.raw.includes("parseToken"), "block reason should name the identifier");
});

test("blocks re-grep of confirmed not-found pattern", () => {
  writeState("ab3", emptyState({ notFoundPatterns: ["parseToken"] }));
  const r = runHook("anti-bypass", {
    tool_name: "Grep",
    tool_input: { pattern: "parseToken", path: "." },
  }, "ab3");
  eq(r.decision, "block", "decision");
});

test("approves grep on new (unsearched) pattern", () => {
  writeState("ab4", emptyState({ notFoundPatterns: ["parseToken"] }));
  const r = runHook("anti-bypass", {
    tool_name: "Grep",
    tool_input: { pattern: "verifyJWT", path: "." },
  }, "ab4");
  eq(r.decision, "approve", "decision");
});

test("warns on too-generic grep pattern (≤2 chars)", () => {
  writeState("ab5", emptyState());
  const r = runHook("anti-bypass", {
    tool_name: "Grep",
    tool_input: { pattern: "ab", path: "." },
  }, "ab5");
  eq(r.decision, "approve", "decision — warn, not block");
  ok(r.hookSpecificOutput !== undefined, "should inject warning hint");
});

// ─────────────────────────────────────────────────────────────────────────────
// truth-layer
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}truth-layer${RESET}`);

test("injects NOT FOUND hint on empty grep result", () => {
  writeState("tl1", emptyState());
  const r = runHook("truth-layer", {
    tool_name:     "Grep",
    tool_input:    { pattern: "phantomFunction", path: "." },
    tool_response: "",
  }, "tl1");
  eq(r.continue, true, "continue");
  ok(r.hookSpecificOutput !== undefined, "should inject NOT FOUND hint");
  const prompt = (r.hookSpecificOutput?.["additionalSystemPrompt"] as string) ?? "";
  ok(prompt.includes("phantomFunction"), "hint should name the pattern");
});

test("records pattern in notFoundPatterns state", () => {
  writeState("tl2", emptyState());
  runHook("truth-layer", {
    tool_name:     "Grep",
    tool_input:    { pattern: "phantomFunction", path: "." },
    tool_response: "",
  }, "tl2");
  const state = readState("tl2") as { notFoundPatterns: string[] };
  ok(state.notFoundPatterns.includes("phantomFunction"), "should persist pattern in state");
});

test("silent (no injection) on grep with results", () => {
  writeState("tl3", emptyState());
  const r = runHook("truth-layer", {
    tool_name:     "Grep",
    tool_input:    { pattern: "loadConfig", path: "." },
    tool_response: "src/config.ts:1:export function loadConfig() {",
  }, "tl3");
  eq(r.continue, true, "continue");
  eq(r.hookSpecificOutput, undefined, "should not inject on found pattern");
});

// ─────────────────────────────────────────────────────────────────────────────
// loop-detector
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}loop-detector${RESET}`);

const loopInput = { tool_name: "Grep", tool_input: { pattern: `HARNESS_TEST_${Date.now()}`, path: "." } };

test("approves distinct tool calls (no loop)", () => {
  writeState("ld1", emptyState());
  runHook("loop-detector", { tool_name: "Grep",  tool_input: { pattern: "findUser" } },   "ld1");
  runHook("loop-detector", { tool_name: "Read",  tool_input: { file_path: "src/a.ts" } }, "ld1");
  const r = runHook("loop-detector", { tool_name: "Grep", tool_input: { pattern: "loadUser" } }, "ld1");
  eq(r.hookSpecificOutput, undefined, "should not inject — different calls");
});

test("approves below threshold (2 of 3 identical calls)", () => {
  writeState("ld2", emptyState());
  runHook("loop-detector", loopInput, "ld2");
  const r = runHook("loop-detector", loopInput, "ld2");
  eq(r.continue, true, "continue");
  eq(r.hookSpecificOutput, undefined, "should not inject below threshold");
});

test("injects LOOP warning at threshold (3rd identical call)", () => {
  writeState("ld3", emptyState());
  runHook("loop-detector", loopInput, "ld3");
  runHook("loop-detector", loopInput, "ld3");
  const r = runHook("loop-detector", loopInput, "ld3");
  eq(r.continue, true, "continue");
  ok(r.hookSpecificOutput !== undefined, "should inject LOOP warning");
  const prompt = (r.hookSpecificOutput?.["additionalSystemPrompt"] as string) ?? "";
  ok(/loop/i.test(prompt), "prompt should mention loop");
});

// ─────────────────────────────────────────────────────────────────────────────
// confidence-check (Stop hook: hallucination detection on real codebase)
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}confidence-check${RESET}`);

// Build a tiny isolated codebase. Each test gets its own root so the
// project-root walk doesn't leak into the grounded repo itself.
function makeFixtureCodebase(): string {
  const dir = mkdtempSync(join(tmpdir(), "grounded-cc-"));
  // Marker file so findProjectRoot stops walking here.
  writeFileSync(join(dir, ".git"), "");
  writeFileSync(join(dir, "auth.ts"), [
    "export function verifyUser(token: string): boolean {",
    "  return token.length > 0;",
    "}",
  ].join("\n"));
  writeFileSync(join(dir, "utils.ts"), [
    "export function makeId(): string { return 'id'; }",
  ].join("\n"));
  return dir;
}

function runConfidenceCheck(transcriptText: string, root: string, stateId: string): HookOutput {
  const result = spawnSync("node", [join(HOOKS_DIR, "confidence-check.js")], {
    input: JSON.stringify({
      transcript: [{ role: "assistant", content: transcriptText }],
    }),
    cwd: root, // makes findProjectRoot land on this fixture, not the real repo
    env: { ...process.env, GROUNDED_STATE_FILE: stateFile(stateId) },
    encoding: "utf-8",
    timeout: 8000,
  });
  try {
    const p = JSON.parse(result.stdout) as Record<string, unknown>;
    return {
      decision:           p["decision"] as string | undefined,
      continue:           p["continue"] as boolean | undefined,
      hookSpecificOutput: p["hookSpecificOutput"] as Record<string, unknown> | undefined,
      raw:                result.stdout,
    };
  } catch {
    return { raw: `stdout: ${result.stdout}\nstderr: ${result.stderr}` };
  }
}

test("approves response with no claims to verify", () => {
  const root = makeFixtureCodebase();
  writeState("cc1", emptyState());
  const r = runConfidenceCheck("Done. The change is complete.", root, "cc1");
  eq(r.decision, "approve", "decision");
});

test("approves response when all claimed identifiers exist", () => {
  const root = makeFixtureCodebase();
  writeState("cc2", emptyState());
  const r = runConfidenceCheck(
    "I called the `verifyUser` function and used the `makeId` helper.",
    root, "cc2",
  );
  eq(r.decision, "approve", "decision");
});

test("blocks response containing a hallucinated identifier", () => {
  const root = makeFixtureCodebase();
  writeState("cc3", emptyState());
  const r = runConfidenceCheck(
    "The `parseToken` function in `auth.ts` handles validation.",
    root, "cc3",
  );
  eq(r.decision, "block", "decision");
  ok(r.raw.includes("parseToken"), "block reason should name the hallucinated identifier");
});

test("approves on second fire (stop_hook_active=true) to avoid infinite loop", () => {
  const root = makeFixtureCodebase();
  writeState("cc4", emptyState());
  const result = spawnSync("node", [join(HOOKS_DIR, "confidence-check.js")], {
    input: JSON.stringify({
      stop_hook_active: true,
      transcript: [{ role: "assistant", content: "The `parseToken` function exists." }],
    }),
    cwd: root,
    env: { ...process.env, GROUNDED_STATE_FILE: stateFile("cc4") },
    encoding: "utf-8",
  });
  const parsed = JSON.parse(result.stdout) as { decision?: string };
  eq(parsed.decision, "approve", "second fire must approve unconditionally");
});

test("approves identifiers that exist as files even when not in code", () => {
  const root = makeFixtureCodebase();
  writeState("cc5", emptyState());
  // `auth.ts` exists as a file in the fixture — fast path should catch it.
  const r = runConfidenceCheck(
    "Edited `auth.ts` to add the new check.",
    root, "cc5",
  );
  eq(r.decision, "approve", "decision");
});

// ─────────────────────────────────────────────────────────────────────────────
// memory pruning (TTL + cap)
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}memory${RESET}`);

function runMemoryScript(script: string, env: Record<string, string>): string {
  const result = spawnSync("node", ["-e", script], {
    encoding: "utf-8",
    env:      { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`script failed: ${result.stderr}`);
  }
  return result.stdout;
}

test("saveMemory drops entries older than TTL", () => {
  const memFile = join(TMP, `mem-ttl-${Date.now()}.json`);
  const oldTs = Date.now() - 1000 * 60 * 60 * 24 * 60; // 60 days ago
  const newTs = Date.now() - 1000 * 60 * 60;           // 1 hour ago
  writeFileSync(memFile, JSON.stringify({
    version: 2,
    loopPatterns: {
      old: { preview: "old(...)", count: 1, lastSeen: oldTs },
      fresh: { preview: "fresh(...)", count: 5, lastSeen: newTs },
    },
    editErrors: {},
  }));

  // Trigger save (which prunes) via a one-liner
  const stdout = runMemoryScript(
    `const {loadMemory, saveMemory} = require("${resolve("dist/state.js")}");
     const m = loadMemory(); saveMemory(m);
     console.log(JSON.stringify(loadMemory()));`,
    { GROUNDED_MEMORY_FILE: memFile, GROUNDED_MEMORY_TTL_DAYS: "30" },
  );

  const after = JSON.parse(stdout) as { loopPatterns: Record<string, unknown> };
  ok(after.loopPatterns["fresh"] !== undefined, "fresh entry survives TTL");
  ok(after.loopPatterns["old"]   === undefined, "old entry pruned by TTL");
});

test("saveMemory caps total entries at GROUNDED_MEMORY_MAX_ENTRIES", () => {
  const memFile = join(TMP, `mem-cap-${Date.now()}.json`);
  const now = Date.now();
  const loopPatterns: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) {
    loopPatterns[`k${i}`] = { preview: `k${i}`, count: 1, lastSeen: now - i * 1000 };
  }
  writeFileSync(memFile, JSON.stringify({ version: 2, loopPatterns, editErrors: {} }));

  const stdout = runMemoryScript(
    `const {loadMemory, saveMemory} = require("${resolve("dist/state.js")}");
     const m = loadMemory(); saveMemory(m);
     console.log(JSON.stringify(loadMemory()));`,
    { GROUNDED_MEMORY_FILE: memFile, GROUNDED_MEMORY_MAX_ENTRIES: "5" },
  );

  const after = JSON.parse(stdout) as { loopPatterns: Record<string, unknown> };
  eq(Object.keys(after.loopPatterns).length, 5, "kept exactly the cap");
  ok(after.loopPatterns["k0"] !== undefined, "most recent kept");
  ok(after.loopPatterns["k19"] === undefined, "oldest dropped");
});

// ─────────────────────────────────────────────────────────────────────────────
// supervisor (fail-open contract)
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}supervisor${RESET}`);

function runHookRaw(hook: string, rawInput: string, errorLog?: string): {
  exitCode: number; stdout: string; stderr: string;
} {
  const result = spawnSync("node", [join(HOOKS_DIR, `${hook}.js`)], {
    input:    rawInput,
    env:      {
      ...process.env,
      GROUNDED_STATE_FILE: stateFile("sup"),
      ...(errorLog ? { GROUNDED_ERROR_LOG: errorLog } : {}),
    },
    encoding: "utf-8",
    timeout:  8000,
  });
  return {
    exitCode: result.status ?? -1,
    stdout:   result.stdout,
    stderr:   result.stderr,
  };
}

test("PreToolUse hook fails open with approve on malformed JSON input", () => {
  writeState("sup", emptyState());
  const r = runHookRaw("anti-bypass", "{not valid json");
  eq(r.exitCode, 0, "exit code (must be 0 — non-zero may be surfaced as block)");
  const parsed = JSON.parse(r.stdout) as { decision?: string };
  eq(parsed.decision, "approve", "fail-open response");
});

test("PostToolUse hook fails open with continue:true on malformed JSON input", () => {
  writeState("sup", emptyState());
  const r = runHookRaw("read-tracker", "garbage~~");
  eq(r.exitCode, 0, "exit code");
  const parsed = JSON.parse(r.stdout) as { continue?: boolean };
  eq(parsed.continue, true, "fail-open response");
});

test("Stop hook fails open with approve on malformed JSON input", () => {
  writeState("sup", emptyState());
  const r = runHookRaw("confidence-check", "}}}");
  eq(r.exitCode, 0, "exit code");
  const parsed = JSON.parse(r.stdout) as { decision?: string };
  eq(parsed.decision, "approve", "fail-open response");
});

test("supervisor logs the crash to GROUNDED_ERROR_LOG", () => {
  writeState("sup", emptyState());
  const logPath = join(TMP, "errors.log");
  runHookRaw("anti-bypass", "<<not json>>", logPath);
  const log = readFileSync(logPath, "utf-8");
  ok(log.includes("anti-bypass"), "error log should record hook name");
  ok(/JSON|Unexpected/i.test(log), "error log should describe parse failure");
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(
  `\n${total} tests: ${BOLD}${passed} passed${RESET}` +
  (failed > 0 ? `, ${R} ${BOLD}${failed} failed${RESET}` : "") + "\n"
);
if (failed > 0) process.exit(1);
