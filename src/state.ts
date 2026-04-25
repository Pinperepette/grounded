import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { claudeHomeFile, findProjectRoot } from "./utils.js";

// Project root never changes within a single hook process. Cache it to avoid
// the up-the-tree existsSync walk on every loadMemory/saveMemory.
let _cachedProjectRoot: string | null | undefined;
function projectRoot(): string | null {
  if (_cachedProjectRoot === undefined) _cachedProjectRoot = findProjectRoot();
  return _cachedProjectRoot;
}

// ─── Session state (ephemeral, per Claude Code process) ───────────────────────

let _cachedSessionId: string | null = null;

function stableSessionId(): string {
  if (_cachedSessionId) return _cachedSessionId;
  const ppid = process.ppid;
  try {
    const { execSync } = require("child_process") as typeof import("child_process");
    // If parent is a shell, Claude Code spawned us via sh -c; use grandparent PID instead
    const cmd = execSync(`ps -o comm= -p ${ppid} 2>/dev/null`, { encoding: "utf-8" }).trim();
    if (/^-?(sh|bash|zsh|fish|dash|ksh|csh|tcsh)$/.test(cmd)) {
      const gppid = execSync(`ps -o ppid= -p ${ppid} 2>/dev/null`, { encoding: "utf-8" }).trim();
      if (/^\d+$/.test(gppid)) { _cachedSessionId = gppid; return gppid; }
    }
  } catch { /* ignore — fall through to ppid */ }
  _cachedSessionId = String(ppid);
  return _cachedSessionId;
}

function sessionFile(): string {
  if (process.env.GROUNDED_STATE_FILE) return process.env.GROUNDED_STATE_FILE;
  return join("/tmp", `grounded-${stableSessionId()}.json`);
}

export interface Decision {
  ts: number;
  hook: string;
  tool: string;
  action: "APPROVE" | "BLOCK" | "WARN" | "TRACK" | "LOOP" | "INJECT" | "SENSITIVE";
  target?: string;
  detail?: string;
}

export interface ScoreEntry {
  ts: number;
  event: string;
  delta: number;
  score: number;
}

export interface SessionState {
  sessionStart: number;
  readFiles: Record<string, number>;   // path → timestamp of last Read
  grepPatterns: string[];
  toolCallLog: Array<{ tool: string; hash: string; ts: number }>;
  decisionLog: Decision[];
  projectRoot: string | null;
  score: number;
  scoreLog: ScoreEntry[];
  // Scoring engine internals
  eventCounts: Record<string, number>;  // ScoreEvent → times fired this session
  recentSequence: string[];             // last 10 tool names for sequence detection
  // Truth layer
  notFoundPatterns: string[];            // Grep patterns confirmed to have 0 results
  grepResults: Record<string, string[]>; // pattern → files that matched (sequence coherence)
}

function emptySession(): SessionState {
  return {
    sessionStart: Date.now(),
    readFiles: {},
    grepPatterns: [],
    toolCallLog: [],
    decisionLog: [],
    projectRoot: null,
    score: 0,
    scoreLog: [],
    eventCounts: {},
    recentSequence: [],
    notFoundPatterns: [],
    grepResults: {},
  };
}

export function loadState(): SessionState {
  try {
    return JSON.parse(readFileSync(sessionFile(), "utf-8")) as SessionState;
  } catch {
    return emptySession();
  }
}

export function saveState(state: SessionState): void {
  writeFileSync(sessionFile(), JSON.stringify(state));
}

export function logDecision(d: Omit<Decision, "ts">): void {
  const state = loadState();
  state.decisionLog.push({ ts: Date.now(), ...d });
  if (state.decisionLog.length > 500) state.decisionLog = state.decisionLog.slice(-500);
  saveState(state);
}

// ─── Persistent memory (survives reboots, per-project) ───────────────────────
// Learns from patterns across sessions. Written to .claude/grounded-memory.json
// in the project root, or ~/.claude/grounded-memory.json globally.

export interface LoopRecord {
  preview: string;
  count: number;
  lastSeen: number;
}

export interface PersistentMemory {
  version: 2;
  loopPatterns: Record<string, LoopRecord>;    // hash → record
  editErrors: Record<string, { count: number; lastSeen: number }>; // file → record
}

function memoryPath(): string {
  if (process.env.GROUNDED_MEMORY_FILE) return process.env.GROUNDED_MEMORY_FILE;
  const root = projectRoot();
  if (root) return join(root, ".claude", "grounded-memory.json");
  return claudeHomeFile("grounded-memory.json");
}

function emptyMemory(): PersistentMemory {
  return { version: 2, loopPatterns: {}, editErrors: {} };
}

export function loadMemory(): PersistentMemory {
  try {
    const raw = JSON.parse(readFileSync(memoryPath(), "utf-8"));
    return raw.version === 2 ? raw : emptyMemory();
  } catch {
    return emptyMemory();
  }
}

// ─── Memory pruning ───────────────────────────────────────────────────────────
// Persistent memory accumulates loop patterns across sessions. Without bounds,
// the file grows forever. We apply two policies on every save:
//   1. TTL: drop entries whose lastSeen is older than N days (default 30)
//   2. Cap: keep only the N most-recent entries per category (default 500)
// Both are tuneable via env vars to support tests and unusual setups.

function memoryTtlMs(): number {
  const days = Number(process.env.GROUNDED_MEMORY_TTL_DAYS ?? 30);
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : Infinity;
}

function memoryMaxEntries(): number {
  const n = Number(process.env.GROUNDED_MEMORY_MAX_ENTRIES ?? 500);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
}

function pruneRecords<T extends { lastSeen: number }>(
  records: Record<string, T>,
  cutoff: number,
  cap: number,
): Record<string, T> {
  // Steady state: nothing expired and we're under cap → return same reference.
  // Avoids rebuilding the whole map on every loop-detector save.
  const keys = Object.keys(records);
  if (keys.length <= cap) {
    let allFresh = true;
    for (const k of keys) {
      if (records[k].lastSeen <= cutoff) { allFresh = false; break; }
    }
    if (allFresh) return records;
  }
  let entries = Object.entries(records).filter(([, r]) => r.lastSeen > cutoff);
  if (entries.length > cap) {
    entries.sort(([, a], [, b]) => b.lastSeen - a.lastSeen);
    entries = entries.slice(0, cap);
  }
  return Object.fromEntries(entries) as Record<string, T>;
}

export function pruneMemory(mem: PersistentMemory): PersistentMemory {
  const cutoff = Date.now() - memoryTtlMs();
  const cap = memoryMaxEntries();
  // Spread mem so future fields are preserved across prunes; don't hard-code version.
  return {
    ...mem,
    loopPatterns: pruneRecords(mem.loopPatterns, cutoff, cap),
    editErrors:   pruneRecords(mem.editErrors,   cutoff, cap),
  };
}

export function saveMemory(mem: PersistentMemory): void {
  const pruned = pruneMemory(mem);
  const p = memoryPath();
  mkdirSync(join(p, ".."), { recursive: true });
  // No pretty-printing: this file is consumed by tools, not read by humans.
  // Doubles write speed and halves disk size at the cap.
  writeFileSync(p, JSON.stringify(pruned));
}
