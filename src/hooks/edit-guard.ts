#!/usr/bin/env node
/**
 * PreToolUse hook — matcher: Edit|Write|MultiEdit
 *
 * v3: Three enforcement layers:
 * 1. Read-before-edit gate (must have read the file in this session)
 * 2. old_string verification (must match actual file content — catches hallucinated edits)
 * 3. Grep→Read→Edit sequence bonus (+15 score for correct workflow)
 *
 * Active correction mode: on block, injects actual file contents so the model
 * can formulate the correct edit immediately without an extra round trip.
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { loadState, logDecision } from "../state.js";
import { blockWithHint, approve, readStdin } from "../utils.js";
import { loadConfig } from "../config.js";
import { recordEvent, getSessionScore } from "../scoring.js";

const PREVIEW_CHARS = 4000;

function extractTarget(tool: string, inp: Record<string, unknown>): string {
  if (tool === "MultiEdit") {
    const edits = (inp["edits"] as Array<{ file_path: string }>) ?? [];
    return edits[0]?.file_path ?? "";
  }
  return (inp["file_path"] as string) ?? "";
}

function extractOldString(tool: string, inp: Record<string, unknown>): string | undefined {
  if (tool === "Edit") return (inp["old_string"] as string) || undefined;
  if (tool === "MultiEdit") {
    const edits = (inp["edits"] as Array<{ old_string?: string }>) ?? [];
    return edits[0]?.old_string || undefined;
  }
  return undefined;
}

function wasRead(target: string, readFiles: Record<string, number>): boolean {
  const abs = resolve(target);
  return Object.keys(readFiles).some((r) => {
    const absR = resolve(r);
    return abs === absR || abs.startsWith(absR + "/") || absR.startsWith(abs + "/");
  });
}

function hadGrepReadSequence(recentSequence: string[]): boolean {
  const last = recentSequence.slice(-6);
  return last.includes("Grep") && last.includes("Read");
}

async function main(): Promise<void> {
  const data = (await readStdin()) as {
    tool_name: string;
    tool_input: Record<string, unknown>;
  };

  const target = extractTarget(data.tool_name, data.tool_input);

  // New file — always allow
  if (!target || !existsSync(target)) {
    logDecision({ hook: "edit-guard", tool: data.tool_name, action: "APPROVE",
      target: target || "(new)", detail: "new file" });
    approve();
    return;
  }

  const state = loadState();
  const { readFiles, recentSequence = [] } = state;

  // ── Gate 1: must have read the file (skippable via config) ──────────────────
  const cfg = loadConfig();
  if (cfg.editGuard.requireReadBeforeEdit && !wasRead(target, readFiles)) {
    recordEvent("EDIT_WITHOUT_READ");
    logDecision({ hook: "edit-guard", tool: data.tool_name, action: "BLOCK", target,
      detail: "not read before edit" });

    const { thresholds } = getSessionScore();
    let hint: string | undefined;

    if (thresholds.editGuardMode === "preview") {
      try {
        const raw = readFileSync(target, "utf-8");
        const truncated = raw.length > PREVIEW_CHARS;
        hint = `FILE CONTENTS OF '${target}'` +
          (truncated ? ` (first ${PREVIEW_CHARS} chars)` : "") +
          `:\n\`\`\`\n` + raw.slice(0, PREVIEW_CHARS) +
          (truncated ? "\n... [truncated — call Read() for full content]" : "") + "\n```";
      } catch { /* ignore */ }
    }

    blockWithHint(`BLOCKED [edit-guard]: Read("${target}") first`, hint);
    return;
  }

  // ── Gate 2: old_string must actually exist in the file ───────────────────────
  const oldString = extractOldString(data.tool_name, data.tool_input);
  if (oldString) {
    let content: string;
    try {
      content = readFileSync(resolve(target), "utf-8");
    } catch {
      content = "";
    }

    if (content && !content.includes(oldString)) {
      recordEvent("OLD_STRING_NOT_FOUND");
      logDecision({ hook: "edit-guard", tool: data.tool_name, action: "BLOCK", target,
        detail: "old_string not found in file" });

      const preview = content.slice(0, PREVIEW_CHARS);
      const hint = `CURRENT FILE CONTENTS:\n\`\`\`\n${preview}` +
        (content.length > PREVIEW_CHARS ? "\n... [truncated]" : "") + "\n```";
      blockWithHint(`BLOCKED [edit-guard]: old_string not in '${target}' — re-read and fix`, hint);
      return;
    }
  }

  // ── Approve: reward correct workflow ─────────────────────────────────────────
  if (hadGrepReadSequence(recentSequence)) {
    recordEvent("GREP_READ_EDIT_SEQUENCE");
  }
  recordEvent("READ_BEFORE_EDIT");
  logDecision({ hook: "edit-guard", tool: data.tool_name, action: "APPROVE", target });
  approve();
}

main().catch(() => process.exit(1));
