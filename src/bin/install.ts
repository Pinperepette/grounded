#!/usr/bin/env node
/**
 * CLI for @pinperepette/grounded.
 *
 * grounded install    — add hooks to ~/.claude/settings.json
 * grounded uninstall  — remove grounded hooks
 * grounded status     — show which hooks are active
 * grounded trace      — show decision log for the current/last session
 * grounded memory     — show persistent memory (learned loop patterns)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { loadMemory, pruneMemory, saveMemory } from "../state.js";
import { findProjectRoot } from "../utils.js";
import { getBehaviorLevel, getMentalState } from "../scoring.js";

const SETTINGS_PATH = join(process.env.HOME ?? "/tmp", ".claude", "settings.json");
const HOOK_TAG = "@pinperepette/grounded";

function distDir(): string {
  return resolve(__dirname, "..", "hooks");
}
function hookCmd(name: string): string {
  return `node "${join(distDir(), name)}.js"`;
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

interface HookEntry {
  matcher?: string;
  _tag?: string;
  hooks: Array<{ type: string; command: string; _tag?: string }>;
}
interface Settings { hooks?: Record<string, HookEntry[]>; [k: string]: unknown }

function loadSettings(): Settings {
  if (!existsSync(SETTINGS_PATH)) return {};
  try { return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")); } catch { return {}; }
}
function saveSettings(s: Settings): void {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}
function isGrounded(e: HookEntry): boolean {
  return e._tag === HOOK_TAG || e.hooks.some((h) => h._tag === HOOK_TAG || h.command.includes("grounded"));
}

const HOOK_DEFS = [
  { event: "UserPromptSubmit",  matcher: undefined,                    cmd: "prompt-inject" },
  { event: "UserPromptSubmit",  matcher: undefined,                    cmd: "pre-flight" },
  { event: "PostToolUse",       matcher: "Read|Grep|Glob",             cmd: "read-tracker" },
  { event: "PostToolUse",       matcher: "Grep",                       cmd: "truth-layer" },
  { event: "PostToolUse",       matcher: ".*",                         cmd: "loop-detector" },
  { event: "PreToolUse",        matcher: ".*",                         cmd: "anti-bypass" },
  { event: "PreToolUse",        matcher: "Edit|Write|MultiEdit",       cmd: "edit-guard" },
  { event: "PreToolUse",        matcher: "Edit|Write|MultiEdit",       cmd: "freshness-check" },
  { event: "PreToolUse",        matcher: "Edit|Write|MultiEdit",       cmd: "policy-guard" },
  { event: "PreToolUse",        matcher: "Edit|Write|MultiEdit|Bash",  cmd: "scope-guard" },
  { event: "Stop",              matcher: undefined,                    cmd: "confidence-check" },
];

function addGrounded(s: Settings): Settings {
  const hooks: Record<string, HookEntry[]> = { ...(s.hooks ?? {}) };
  for (const def of HOOK_DEFS) {
    if (!hooks[def.event]) hooks[def.event] = [];
    hooks[def.event].push({
      ...(def.matcher ? { matcher: def.matcher } : {}),
      _tag: HOOK_TAG,
      hooks: [{ type: "command", command: hookCmd(def.cmd), _tag: HOOK_TAG }],
    });
  }
  return { ...s, hooks };
}

function removeGrounded(s: Settings): Settings {
  if (!s.hooks) return s;
  const cleaned: Record<string, HookEntry[]> = {};
  for (const [ev, entries] of Object.entries(s.hooks)) {
    cleaned[ev] = entries.filter((e) => !isGrounded(e));
  }
  return { ...s, hooks: cleaned };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function install(auto = false): void {
  const s = loadSettings();
  saveSettings(addGrounded(removeGrounded(s)));
  if (!auto) console.log(`✓ @pinperepette/grounded installed → ${SETTINGS_PATH}`);
}

function uninstall(): void {
  saveSettings(removeGrounded(loadSettings()));
  console.log(`✓ @pinperepette/grounded removed from ${SETTINGS_PATH}`);
}

function status(): void {
  const hooks = loadSettings().hooks ?? {};
  let found = 0;
  for (const entries of Object.values(hooks)) found += entries.filter(isGrounded).length;
  if (found > 0) {
    console.log(`✓ @pinperepette/grounded: ${found} hooks active\n`);
    for (const d of HOOK_DEFS) {
      const matcher = d.matcher ? ` / ${d.matcher}` : "";
      console.log(`  [${d.event}${matcher}]  ${d.cmd}`);
    }
  } else {
    console.log(`✗ @pinperepette/grounded not installed. Run: grounded install`);
  }
}

// ─── grounded trace ───────────────────────────────────────────────────────────

const ACTION_COLOR: Record<string, string> = {
  TRACK:     "\x1b[32m",  // green
  APPROVE:   "\x1b[32m",  // green
  INJECT:    "\x1b[36m",  // cyan
  WARN:      "\x1b[33m",  // yellow
  LOOP:      "\x1b[33m",  // yellow
  BLOCK:     "\x1b[31m",  // red
  SENSITIVE: "\x1b[31m",  // red
};
const RESET = "\x1b[0m";
const DIM   = "\x1b[2m";

function fmt(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}

function trace(n: number): void {
  // Find the most recent session state file
  const { execSync } = require("child_process") as typeof import("child_process");
  let stateFile: string | null = null;
  try {
    const files = execSync("ls -t /tmp/grounded-*.json 2>/dev/null", { encoding: "utf-8" })
      .trim().split("\n").filter(Boolean);
    if (files.length > 0) stateFile = files[0];
  } catch { /* no sessions */ }

  if (!stateFile || !existsSync(stateFile)) {
    console.log("No active or recent grounded session found.");
    return;
  }

  let state: { sessionStart: number; decisionLog: Array<{
    ts: number; hook: string; tool: string;
    action: string; target?: string; detail?: string;
  }>; readFiles: Record<string, number>; score?: number; scoreLog?: Array<{
    ts: number; event: string; delta: number; score: number;
  }> };

  try {
    state = JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    console.log("Could not read session state.");
    return;
  }

  const log = (state.decisionLog ?? []).slice(-n);
  const duration = Math.round((Date.now() - state.sessionStart) / 1000);
  const pid = stateFile.match(/grounded-(\d+)\.json/)?.[1] ?? "?";

  console.log(`\n\x1b[1m GROUNDED TRACE — Session ${pid}  (${duration}s ago)\x1b[0m`);
  console.log(` Started: ${new Date(state.sessionStart).toLocaleTimeString()}\n`);

  if (log.length === 0) {
    console.log("  (no decisions recorded yet)\n");
  } else {
    for (const d of log) {
      const color = ACTION_COLOR[d.action] ?? "";
      const action = `${color}${d.action.padEnd(10)}${RESET}`;
      const tool   = d.tool.padEnd(14);
      const target = d.target ? `${DIM}${d.target.slice(-50)}${RESET}` : "";
      const detail = d.detail ? `  ${DIM}→ ${d.detail}${RESET}` : "";
      console.log(`  ${fmt(d.ts)}  ${action}  ${tool}  ${target}${detail}`);
    }
  }

  // Summary
  const all = state.decisionLog ?? [];
  const counts = {
    tracked:   all.filter(d => d.action === "TRACK").length,
    approved:  all.filter(d => d.action === "APPROVE").length,
    blocked:   all.filter(d => d.action === "BLOCK").length,
    loops:     all.filter(d => d.action === "LOOP").length,
    sensitive: all.filter(d => d.action === "SENSITIVE").length,
    warned:    all.filter(d => d.action === "WARN").length,
  };
  const filesRead = Object.keys(state.readFiles ?? {}).length;

  const score = state.score ?? 0;
  const level = getBehaviorLevel(score);
  const levelColor = level === "strict" ? "\x1b[31m" : level === "cautious" ? "\x1b[33m" : "\x1b[32m";

  console.log(`\n ${"─".repeat(60)}`);
  console.log(
    `  Files read: ${filesRead}  │  Tracked: ${counts.tracked}  │  ` +
    `\x1b[32mApproved: ${counts.approved}\x1b[0m  │  ` +
    `\x1b[31mBlocked: ${counts.blocked}\x1b[0m  │  ` +
    `\x1b[33mLoops: ${counts.loops}\x1b[0m  │  ` +
    `\x1b[31mSensitive: ${counts.sensitive}\x1b[0m`
  );
  console.log(
    `  Score: ${score > 0 ? "+" : ""}${score}  │  Level: ${levelColor}${level.toUpperCase()}\x1b[0m`
  );
  console.log();
}

// ─── grounded score ───────────────────────────────────────────────────────────

function showScore(): void {
  const { execSync } = require("child_process") as typeof import("child_process");
  let stateFile: string | null = null;
  try {
    const files = execSync("ls -t /tmp/grounded-*.json 2>/dev/null", { encoding: "utf-8" })
      .trim().split("\n").filter(Boolean);
    if (files.length > 0) stateFile = files[0];
  } catch { /* no sessions */ }

  if (!stateFile || !existsSync(stateFile)) {
    console.log("No active or recent grounded session found.");
    return;
  }

  let state: { score?: number; scoreLog?: Array<{ ts: number; event: string; delta: number; score: number }> };
  try {
    state = JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    console.log("Could not read session state.");
    return;
  }

  const score = state.score ?? 0;
  const level = getBehaviorLevel(score);
  const levelColor = level === "strict" ? "\x1b[31m" : level === "cautious" ? "\x1b[33m" : "\x1b[32m";
  const mental = getMentalState();
  const mentalColor = mental === "failing" ? "\x1b[31m" : mental === "execution" ? "\x1b[36m" : "\x1b[32m";
  const log = (state.scoreLog ?? []).slice(-20);

  console.log(`\n\x1b[1m GROUNDED SCORE\x1b[0m\n`);
  console.log(`  Current score:  ${score > 0 ? "+" : ""}${score}`);
  console.log(`  Behavior level: ${levelColor}${level.toUpperCase()}\x1b[0m`);
  console.log(`  Mental state:   ${mentalColor}${mental.toUpperCase()}\x1b[0m`);
  console.log(`\n  Recent events (last ${log.length}):\n`);

  for (const e of log) {
    const sign = e.delta > 0 ? "\x1b[32m+" : "\x1b[31m";
    console.log(
      `  ${fmt(e.ts)}  ${sign}${e.delta}\x1b[0m  ${DIM}${e.event.padEnd(22)}${RESET}  score → ${e.score}`
    );
  }
  console.log();
}

// ─── grounded explain ─────────────────────────────────────────────────────────

function explain(): void {
  const { execSync } = require("child_process") as typeof import("child_process");
  let stateFile: string | null = null;
  try {
    const files = execSync("ls -t /tmp/grounded-*.json 2>/dev/null", { encoding: "utf-8" })
      .trim().split("\n").filter(Boolean);
    if (files.length > 0) stateFile = files[0];
  } catch { /* no sessions */ }

  if (!stateFile || !existsSync(stateFile)) {
    console.log("No active or recent grounded session found.");
    return;
  }

  let state: {
    decisionLog: Array<{ ts: number; hook: string; tool: string; action: string; target?: string; detail?: string }>;
    score?: number;
    eventCounts?: Record<string, number>;
    notFoundPatterns?: string[];
  };
  try {
    state = JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    console.log("Could not read session state.");
    return;
  }

  const blocks = (state.decisionLog ?? []).filter((d) => d.action === "BLOCK");
  if (blocks.length === 0) {
    console.log("\n  No blocks recorded in the current session.\n");
    return;
  }

  const last = blocks[blocks.length - 1];
  const score = state.score ?? 0;
  const level = getBehaviorLevel(score);
  const levelColor = level === "strict" ? "\x1b[31m" : level === "cautious" ? "\x1b[33m" : "\x1b[32m";
  const age = Math.round((Date.now() - last.ts) / 1000);

  const sameBlocks = blocks.filter((d) => d.hook === last.hook && d.detail === last.detail).length;

  const FIXES: Array<[string, string, string]> = [
    // [detail-substring, score-event, fix]
    ["not read before edit",         "EDIT_WITHOUT_READ",      `Read("${last.target ?? "the file"}") then retry your Edit`],
    ["old_string not found",         "OLD_STRING_NOT_FOUND",   `Read("${last.target ?? "the file"}") to get exact current content, then fix old_string`],
    ["sensitive file",               "SENSITIVE_FILE",         `Do not write to sensitive files — reads are always allowed`],
    ["outside project root",         "SCOPE_VIOLATION",        `Add path to scopeGuard.extraAllowedRoots in .grounded.json`],
    ["system path",                  "SCOPE_VIOLATION",        `Do not modify system paths`],
    ["already confirmed not found",  "TOOL_MISUSE",            `"${last.target}" was already searched — it doesn't exist. Revise your approach`],
    ["using known-not-found",        "ANTI_BYPASS_TRIGGERED",  `Those identifiers don't exist. Find the correct ones via Grep`],
    ["noEdit rule",                  "POLICY_VIOLATION",       `Path is policy-protected. Edit .grounded.json "policies.noEdit" to change`],
    ["requireTestRead",              "POLICY_VIOLATION",       `Read the corresponding test file first (${(last.target ?? "file").replace(/\.(ts|js|py|go)$/, ".test.$1")})`],
  ];

  const match = FIXES.find(([k]) => (last.detail ?? "").includes(k));
  const scoreEvent = match?.[1] ?? "";
  const fix        = match?.[2] ?? "Review the block reason and adjust your approach";
  const eventCount = scoreEvent ? (state.eventCounts?.[scoreEvent] ?? 0) : 0;

  console.log(`\n\x1b[1m GROUNDED — LAST BLOCK EXPLAINED\x1b[0m\n`);
  console.log(`  Time:   ${fmt(last.ts)} (${age}s ago)`);
  console.log(`  Hook:   ${last.hook}`);
  console.log(`  Tool:   ${last.tool}${last.target ? ` on "${last.target}"` : ""}`);
  console.log(`  Reason: ${last.detail ?? "(no detail)"}`);
  console.log();
  console.log(`  Score:  ${score > 0 ? "+" : ""}${score} → ${levelColor}${level.toUpperCase()}\x1b[0m`);
  if (eventCount > 1) {
    console.log(`  ${DIM}This error occurred ${eventCount}× this session (progressive penalty active)${RESET}`);
  }
  if (sameBlocks > 1) {
    console.log(`  ${DIM}Same block triggered ${sameBlocks}× — you are in a loop${RESET}`);
  }
  if ((state.notFoundPatterns ?? []).length > 0) {
    console.log(`  ${DIM}Confirmed NOT FOUND: ${state.notFoundPatterns!.slice(0, 5).join(", ")}${RESET}`);
  }
  console.log();
  console.log(`  \x1b[32mFix:\x1b[0m`);
  console.log(`  → ${fix}`);
  console.log();
}

// ─── grounded memory ──────────────────────────────────────────────────────────

function showMemory(): void {
  const mem = loadMemory();
  const patterns = Object.entries(mem.loopPatterns);

  console.log(`\n\x1b[1m GROUNDED PERSISTENT MEMORY\x1b[0m\n`);

  if (patterns.length === 0) {
    console.log("  No loop patterns recorded yet.\n");
    return;
  }

  console.log(`  Loop patterns learned across sessions:\n`);
  for (const [, rec] of patterns.sort((a, b) => b[1].count - a[1].count)) {
    const age = Math.round((Date.now() - rec.lastSeen) / 3600000);
    console.log(`  \x1b[31m✗\x1b[0m ${rec.preview.slice(0, 70)}`);
    console.log(`    ${DIM}triggered ${rec.count}×  last seen ${age}h ago${RESET}\n`);
  }
}

function cleanMemory(): void {
  const before = loadMemory();
  const after = pruneMemory(before);
  const count = (m: typeof before) =>
    Object.keys(m.loopPatterns).length + Object.keys(m.editErrors).length;
  const beforeCount = count(before);
  const afterCount  = count(after);
  saveMemory(after);
  console.log(
    `\n\x1b[1m GROUNDED MEMORY CLEANUP\x1b[0m\n\n` +
    `  Before:  ${beforeCount} entries\n` +
    `  After:   ${afterCount} entries\n` +
    `  Removed: ${beforeCount - afterCount}\n\n` +
    `  ${DIM}TTL: ${process.env.GROUNDED_MEMORY_TTL_DAYS ?? 30} days  |  ` +
    `Cap: ${process.env.GROUNDED_MEMORY_MAX_ENTRIES ?? 500} entries${RESET}\n`
  );
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DIM2  = "\x1b[2m";

if (args.includes("--auto")) {
  install(true);
} else {
  switch (args[0]) {
    case "uninstall": uninstall(); break;
    case "status":    status();    break;
    case "trace":     trace(Number(args[1]) || 50); break;
    case "memory":
      if (args[1] === "--clean") cleanMemory();
      else showMemory();
      break;
    case "score":     showScore(); break;
    case "explain":   explain();   break;
    default:          install(false); break;
  }
}
