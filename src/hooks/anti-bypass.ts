#!/usr/bin/env node
/**
 * PreToolUse hook — matcher: .*
 *
 * Anti-bypass: the model can "obey formally" (does the Grep, gets nothing back)
 * then ignores the result and uses the not-found identifier anyway.
 *
 * This hook intercepts every tool call and checks whether the tool input
 * references any identifier that was already confirmed NOT FOUND this session.
 * If it does → inject a warning and penalize the score.
 *
 * Also catches useless Grep calls:
 * - Pattern already confirmed not found → block immediately (no point searching again)
 * - Pattern too generic (< 3 chars) → penalize
 */
import { loadState, logDecision } from "../state.js";
import { readStdin, superviseHook } from "../utils.js";
import { recordEvent } from "../scoring.js";
import { loadConfig } from "../config.js";

// Min identifier length to check — avoids false positives on short tokens
const MIN_PATTERN_LENGTH = 4;

// Common words that appear in code but aren't identifiers
const SKIP_WORDS = new Set([
  "true", "false", "null", "none", "undefined", "void", "any", "string",
  "number", "boolean", "object", "array", "function", "return", "const",
  "let", "var", "type", "interface", "class", "import", "export", "from",
]);

async function main(): Promise<void> {
  const data = (await readStdin()) as {
    tool_name: string;
    tool_input: Record<string, unknown>;
  };

  const state = loadState();
  const notFound = (state.notFoundPatterns ?? []).filter(
    (p) => p.length >= MIN_PATTERN_LENGTH && !SKIP_WORDS.has(p.toLowerCase())
  );

  // ── Special case: Grep on already-confirmed not-found pattern ─────────────────
  if (data.tool_name === "Grep") {
    const pattern = (data.tool_input["pattern"] as string) ?? "";

    // Pattern too generic
    if (pattern.length <= 2) {
      recordEvent("TOOL_MISUSE");
      logDecision({ hook: "anti-bypass", tool: "Grep", action: "WARN",
        target: pattern, detail: "pattern too generic" });
      if (loadConfig().mode !== "silent") {
        process.stdout.write(JSON.stringify({
          decision: "approve",
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalSystemPrompt: `Grep("${pattern}") too generic — use a specific identifier (≥4 chars)`,
          },
        }));
      } else {
        process.stdout.write(JSON.stringify({ decision: "approve" }));
      }
      return;
    }

    // Already confirmed not found — block immediately
    const alreadySearched = notFound.find(
      (p) => p.toLowerCase() === pattern.toLowerCase()
    );
    if (alreadySearched) {
      recordEvent("TOOL_MISUSE");
      logDecision({ hook: "anti-bypass", tool: "Grep", action: "BLOCK",
        target: pattern, detail: "already confirmed not found" });
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: `BLOCKED [anti-bypass]: "${pattern}" already searched — confirmed NOT FOUND`,
      }));
      return;
    }
  }

  // ── General: check if tool input references a known-not-found identifier ──────
  if (notFound.length === 0) {
    process.stdout.write(JSON.stringify({ decision: "approve" }));
    return;
  }

  const inputStr = JSON.stringify(data.tool_input);
  const bypassed = notFound.filter((p) => {
    // Word-boundary-style check: surrounded by non-word chars or at string edges
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "i").test(inputStr);
  });

  if (bypassed.length === 0) {
    process.stdout.write(JSON.stringify({ decision: "approve" }));
    return;
  }

  // Model is using identifiers we confirmed don't exist
  recordEvent("ANTI_BYPASS_TRIGGERED");
  logDecision({
    hook:   "anti-bypass",
    tool:   data.tool_name,
    action: "BLOCK",
    target: bypassed.join(", "),
    detail: "using known-not-found identifiers",
  });

  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: `BLOCKED [anti-bypass]: NOT FOUND: ${bypassed.join(", ")}\n→ Grep for the correct identifier first`,
  }));
}

superviseHook("anti-bypass", main);
