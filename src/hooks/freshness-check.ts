#!/usr/bin/env node
/**
 * PreToolUse hook — matcher: Edit|Write|MultiEdit
 * Warns if the file being edited has changed on disk since it was last read.
 * This catches the "stale content" bug where Claude edits from an outdated snapshot.
 */
import { existsSync, statSync } from "fs";
import { resolve } from "path";
import { loadState, logDecision } from "../state.js";
import { loadConfig } from "../config.js";
import { readStdin, superviseHook } from "../utils.js";
import { recordEvent, getSessionScore } from "../scoring.js";

function extractTarget(tool: string, inp: Record<string, unknown>): string {
  if (tool === "MultiEdit") {
    const edits = (inp["edits"] as Array<{ file_path: string }>) ?? [];
    return edits[0]?.file_path ?? "";
  }
  return (inp["file_path"] as string) ?? "";
}

async function main(): Promise<void> {
  const data = (await readStdin()) as {
    tool_name: string;
    tool_input: Record<string, unknown>;
  };

  const target = extractTarget(data.tool_name, data.tool_input);

  if (!target || !existsSync(target)) {
    process.stdout.write(JSON.stringify({ decision: "approve" }));
    return;
  }

  const { readFiles } = loadState();
  const cfg = loadConfig();
  const abs = resolve(target);
  const readAt = readFiles[abs] ?? readFiles[target];

  if (!readAt) {
    // edit-guard handles the "not read at all" case — just approve here
    process.stdout.write(JSON.stringify({ decision: "approve" }));
    return;
  }

  let mtime: number;
  try {
    mtime = statSync(abs).mtimeMs;
  } catch {
    process.stdout.write(JSON.stringify({ decision: "approve" }));
    return;
  }

  const fileChangedAfterRead = mtime > readAt;

  if (fileChangedAfterRead) {
    recordEvent("STALE_CONTENT_EDIT");
    const reason = `file was modified on disk after you read it (mtime: ${new Date(mtime).toISOString()}, read at: ${new Date(readAt).toISOString()})`;

    const { thresholds } = getSessionScore();
    logDecision({ hook: "freshness-check", tool: data.tool_name,
      action: thresholds.freshnessMode === "block" ? "BLOCK" : "WARN",
      target, detail: reason });

    if (thresholds.freshnessMode === "block") {
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: `BLOCKED [freshness]: '${target}' changed — re-read first`,
      }));
    } else if (cfg.mode !== "silent") {
      process.stdout.write(JSON.stringify({
        decision: "approve",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalSystemPrompt: `'${target}' may be stale — re-read before editing.`,
        },
      }));
    } else {
      process.stdout.write(JSON.stringify({ decision: "approve" }));
    }
  } else {
    process.stdout.write(JSON.stringify({ decision: "approve" }));
  }
}

superviseHook("freshness-check", main);
