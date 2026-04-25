#!/usr/bin/env node
/**
 * PostToolUse hook — matcher: Grep
 *
 * Continuous truth layer:
 * - If Grep returns nothing: records pattern as NOT FOUND, injects fact immediately
 * - If Grep returns results: records which files matched (for sequence coherence check)
 *
 * Both branches feed the session state used by anti-bypass and edit-guard.
 */
import { loadState, saveState, logDecision } from "../state.js";
import { postOk, readStdin, superviseHook } from "../utils.js";
import { loadConfig } from "../config.js";

const EMPTY_THRESHOLD = 15;

function isEmptyResult(output: unknown): boolean {
  if (output === null || output === undefined) return true;
  const s = typeof output === "string" ? output : JSON.stringify(output);
  const trimmed = s.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < EMPTY_THRESHOLD) return true;
  if (/no matches found|no files were searched|0 matches/i.test(trimmed)) return true;
  return false;
}

// Extract file paths from rg output lines: "src/foo.ts:42:content"
function extractMatchedFiles(output: string): string[] {
  const files = new Set<string>();
  for (const line of output.split("\n")) {
    const m = line.match(/^([^:\n]+\.[a-zA-Z]{1,6}):/);
    if (m && !m[1].includes(" ")) files.add(m[1]);
  }
  return [...files];
}

async function main(): Promise<void> {
  const data = (await readStdin()) as {
    tool_name: string;
    tool_input: Record<string, string>;
    tool_response?: unknown;
  };

  if (data.tool_name !== "Grep") {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const pattern = data.tool_input["pattern"] ?? "";
  const output  = data.tool_response;

  if (!pattern) {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const state = loadState();
  state.notFoundPatterns = state.notFoundPatterns ?? [];
  state.grepResults      = state.grepResults      ?? {};

  if (isEmptyResult(output)) {
    // ── Pattern confirmed NOT FOUND ────────────────────────────────────────
    if (!state.notFoundPatterns.includes(pattern)) {
      state.notFoundPatterns.push(pattern);
      if (state.notFoundPatterns.length > 100) state.notFoundPatterns.shift();
    }
    saveState(state);

    logDecision({ hook: "truth-layer", tool: "Grep", action: "WARN",
      target: pattern, detail: "pattern not found in codebase" });

    process.stdout.write(JSON.stringify({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalSystemPrompt: `NOT FOUND: "${pattern}"\n→ Do not reference it. Revise your plan.`,
      },
    }));
  } else {
    // ── Pattern found — record which files matched (for coherence check) ──
    const outputStr = typeof output === "string" ? output : JSON.stringify(output);
    const matchedFiles = extractMatchedFiles(outputStr);
    if (matchedFiles.length > 0) {
      state.grepResults[pattern] = matchedFiles;
      // Keep only last 20 patterns to avoid unbounded growth
      const keys = Object.keys(state.grepResults);
      if (keys.length > 20) delete state.grepResults[keys[0]];
      saveState(state);
    }

    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

superviseHook("truth-layer", main, postOk);
