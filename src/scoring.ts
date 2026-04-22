/**
 * Scoring / Policy Engine  v2
 *
 * Three layers of adaptivity:
 *
 * 1. Per-event scoring  — every hook emits events with positive/negative weights
 * 2. Progressive penalties — repeated bad behavior costs exponentially more
 * 3. Sequence bonuses — correct Grep→Read→Edit workflow is rewarded as a unit
 *
 * The accumulated score determines BehaviorLevel:
 *   NORMAL  (score >= 0)   — default thresholds
 *   CAUTIOUS (score < 0)   — loop threshold -1, freshness becomes block
 *   STRICT  (score < -30)  — loop threshold = 1, all warns become blocks
 *
 * The global config.mode acts as a floor:
 *   safe:       adaptive only (default)
 *   strict:     minimum level = CAUTIOUS
 *   autonomous: minimum level = STRICT
 *
 * Mental state (EXPLORATION / EXECUTION / FAILING) is a separate derived
 * dimension used by the pre-flight planner and trace display.
 */

import { loadState, saveState } from "./state.js";
import { loadConfig } from "./config.js";

// ─── Score weights ─────────────────────────────────────────────────────────────

export const SCORE_WEIGHTS = {
  // Good: model is using tools correctly
  READ_BEFORE_EDIT:         +5,
  GREP_READ_EDIT_SEQUENCE:  +15,  // full Grep → Read → Edit workflow
  GREP_USED:                +3,
  READ_USED:                +2,
  CLAIMS_VERIFIED:          +4,

  // Bad: model is misbehaving
  EDIT_WITHOUT_READ:        -10,
  OLD_STRING_NOT_FOUND:     -8,   // edit with wrong/hallucinated old_string
  ANTI_BYPASS_TRIGGERED:    -12,  // used a known-not-found identifier anyway
  EDIT_UNRELATED_TO_GREP:   -7,   // edited a file unrelated to recent Grep targets
  TOOL_MISUSE:              -5,   // useless/redundant tool call
  POLICY_VIOLATION:         -20,  // project policy breach (noEdit, requireTestRead)
  LOOP_DETECTED:            -20,
  HALLUCINATION_FOUND:      -15,
  SENSITIVE_FILE:           -25,
  SCOPE_VIOLATION:          -10,
  STALE_CONTENT_EDIT:       -5,
} as const;

export type ScoreEvent = keyof typeof SCORE_WEIGHTS;

// ─── Progressive penalty multipliers ─────────────────────────────────────────
// Positive events: flat (reward every correct action equally).
// Negative events: 1st × 1.0, 2nd × 2.5, 3rd+ × 5.0

function progressiveDelta(event: ScoreEvent, occurrenceCount: number): number {
  const base = SCORE_WEIGHTS[event];
  if (base >= 0) return base;
  if (occurrenceCount <= 1) return base;
  if (occurrenceCount === 2) return Math.round(base * 2.5);
  return base * 5;
}

// ─── Behavior levels ──────────────────────────────────────────────────────────

export type BehaviorLevel = "normal" | "cautious" | "strict";

export function getBehaviorLevel(score: number): BehaviorLevel {
  if (score < -30) return "strict";
  if (score < 0)   return "cautious";
  return "normal";
}

// ─── Mental state ─────────────────────────────────────────────────────────────
// Orthogonal to BehaviorLevel — describes the phase the model is in.
// Used by pre-flight planner to adjust plan verbosity.

export type MentalState = "exploration" | "execution" | "failing";

export function getMentalState(): MentalState {
  const state = loadState();
  const score = state.score ?? 0;
  if (score < -20) return "failing";
  const edits = (state.recentSequence ?? [])
    .slice(-8)
    .filter((t) => t === "Edit" || t === "Write" || t === "MultiEdit");
  if (edits.length > 0) return "execution";
  return "exploration";
}

// ─── Dynamic thresholds ───────────────────────────────────────────────────────

export interface DynamicThresholds {
  loopThreshold: number;
  freshnessMode: "warn" | "block";
  scopeMode:     "warn" | "block";
  editGuardMode: "preview" | "block-only";
}

export function getThresholds(level: BehaviorLevel): DynamicThresholds {
  const cfg = loadConfig();

  // Global mode acts as a floor — raises the effective level if score alone isn't there yet
  const floor: BehaviorLevel =
    cfg.mode === "autonomous" ? "strict"   :
    cfg.mode === "strict"     ? "cautious" :
    "normal";

  const effective: BehaviorLevel =
    level === "strict"                          ? "strict"   :
    level === "cautious" || floor === "cautious" ? "cautious" :
    floor  === "strict"                          ? "strict"   :
    "normal";

  switch (effective) {
    case "strict":
      return {
        loopThreshold: 1,
        freshnessMode: "block",
        scopeMode:     "block",
        editGuardMode: "block-only",
      };
    case "cautious":
      return {
        loopThreshold: Math.max(1, cfg.loopDetector.threshold - 1),
        freshnessMode: "block",
        scopeMode:     cfg.scopeGuard.mode,
        editGuardMode: "preview",
      };
    default:
      return {
        loopThreshold: cfg.loopDetector.threshold,
        freshnessMode: "warn",
        scopeMode:     cfg.scopeGuard.mode,
        editGuardMode: "preview",
      };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Record a scoring event. Progressive penalty applied for repeated bad events. */
export function recordEvent(event: ScoreEvent): {
  delta: number;
  newScore: number;
  level: BehaviorLevel;
  thresholds: DynamicThresholds;
  mentalState: MentalState;
} {
  const state = loadState();
  state.eventCounts = state.eventCounts ?? {};
  state.eventCounts[event] = (state.eventCounts[event] ?? 0) + 1;
  const count = state.eventCounts[event];

  const delta = progressiveDelta(event, count);
  state.score = (state.score ?? 0) + delta;
  state.scoreLog = state.scoreLog ?? [];
  state.scoreLog.push({ ts: Date.now(), event, delta, score: state.score });
  if (state.scoreLog.length > 500) state.scoreLog = state.scoreLog.slice(-500);
  saveState(state);

  const level = getBehaviorLevel(state.score);
  return {
    delta,
    newScore: state.score,
    level,
    thresholds: getThresholds(level),
    mentalState: getMentalState(),
  };
}

/** Read current score and derived state without writing. */
export function getSessionScore(): {
  score: number;
  level: BehaviorLevel;
  thresholds: DynamicThresholds;
  mentalState: MentalState;
} {
  const state = loadState();
  const score = state.score ?? 0;
  const level = getBehaviorLevel(score);
  return {
    score,
    level,
    thresholds: getThresholds(level),
    mentalState: getMentalState(),
  };
}
