#!/usr/bin/env node
/**
 * PostToolUse hook — matcher: Read|Grep|Glob
 * Tracks files read/searched. Logs every tracking decision.
 */
import { existsSync } from "fs";
import { loadState, saveState, logDecision } from "../state.js";
import { postOk, readStdin, simpleHash, superviseHook } from "../utils.js";
import { recordEvent } from "../scoring.js";

async function main(): Promise<void> {
  const data = (await readStdin()) as {
    tool_name: string;
    tool_input: Record<string, string>;
  };

  const state = loadState();
  const tool = data.tool_name ?? "";
  const inp = data.tool_input ?? {};
  const now = Date.now();

  if (tool === "Read") {
    const fp = inp["file_path"] ?? "";
    if (fp) {
      state.readFiles[fp] = now;
      logDecision({ hook: "read-tracker", tool, action: "TRACK", target: fp });
      recordEvent("READ_USED");
    }
  } else if (tool === "Grep") {
    const pattern = inp["pattern"] ?? "";
    const path = inp["path"] ?? "";
    if (pattern && !state.grepPatterns.includes(pattern)) {
      state.grepPatterns.push(pattern);
    }
    if (path && existsSync(path) && !state.readFiles[path]) {
      state.readFiles[path] = now;
    }
    logDecision({ hook: "read-tracker", tool, action: "TRACK",
      target: pattern, detail: path || undefined });
    recordEvent("GREP_USED");
  } else if (tool === "Glob") {
    state.toolCallLog.push({ tool: "Glob", hash: simpleHash(JSON.stringify(inp)), ts: now });
    logDecision({ hook: "read-tracker", tool, action: "TRACK", detail: "glob exploration" });
  }

  state.toolCallLog.push({ tool, hash: simpleHash(JSON.stringify(inp)), ts: now });
  if (state.toolCallLog.length > 200) state.toolCallLog = state.toolCallLog.slice(-200);

  // Track recent tool sequence for Grep→Read→Edit sequence bonus detection
  state.recentSequence = state.recentSequence ?? [];
  state.recentSequence.push(tool);
  if (state.recentSequence.length > 10) state.recentSequence = state.recentSequence.slice(-10);

  saveState(state);
  postOk();
}

superviseHook("read-tracker", main, postOk);
