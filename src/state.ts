import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { findProjectRoot } from "./utils.js";

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
  const root = findProjectRoot();
  if (root) return join(root, ".claude", "grounded-memory.json");
  return join(process.env.HOME ?? "/tmp", ".claude", "grounded-memory.json");
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

export function saveMemory(mem: PersistentMemory): void {
  const p = memoryPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(mem, null, 2));
}
