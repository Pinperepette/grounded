#!/usr/bin/env node
/**
 * PreToolUse hook — matcher: Edit|Write|MultiEdit
 *
 * Project policy enforcement. Checks .grounded.json "policies" section:
 *
 * noEdit:          path substrings/prefixes that are always blocked
 * requireTestRead: if true, a test file must be read before editing impl files
 *
 * This transforms grounded from a personal tool into a team-usable guardrail:
 * repo-level policies are checked in source control and enforced on all contributors.
 */
import { resolve } from "path";
import { loadConfig } from "../config.js";
import { loadState, logDecision } from "../state.js";
import { block, approve, readStdin } from "../utils.js";
import { recordEvent } from "../scoring.js";

function extractTargets(tool: string, inp: Record<string, unknown>): string[] {
  if (tool === "MultiEdit") {
    return ((inp["edits"] as Array<{ file_path: string }>) ?? []).map((e) => e.file_path);
  }
  const fp = (inp["file_path"] as string) ?? "";
  return fp ? [fp] : [];
}

function matchesNoEdit(abs: string, rules: string[]): string | null {
  for (const rule of rules) {
    if (rule.includes("*")) {
      // Simple glob: * matches any sequence
      const re = new RegExp(rule.replace(/\*/g, ".*").replace(/\//g, "\\/"));
      if (re.test(abs)) return rule;
    } else if (abs.includes(rule)) {
      return rule;
    }
  }
  return null;
}

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[a-z]+$/.test(path) ||
    /\/__tests__\//.test(path) ||
    /\/test\//.test(path) ||
    /\/tests\//.test(path);
}

function isImplFile(path: string): boolean {
  return !isTestFile(path) &&
    /\.(ts|tsx|js|jsx|py|go|rs|java|rb|cpp|cs)$/.test(path);
}

async function main(): Promise<void> {
  const data = (await readStdin()) as {
    tool_name: string;
    tool_input: Record<string, unknown>;
  };

  const cfg = loadConfig();
  const state = loadState();
  const targets = extractTargets(data.tool_name, data.tool_input);

  for (const raw of targets) {
    const abs = resolve(raw);

    // ── Policy 1: noEdit paths ───────────────────────────────────────────────
    const matchedRule = matchesNoEdit(abs, cfg.policies.noEdit);
    if (matchedRule) {
      recordEvent("POLICY_VIOLATION");
      logDecision({ hook: "policy-guard", tool: data.tool_name, action: "BLOCK",
        target: abs, detail: `matches noEdit rule: "${matchedRule}"` });
      block(`BLOCKED [policy]: '${abs}' matches noEdit rule "${matchedRule}"`);
      return;
    }

    // ── Policy 2: requireTestRead ────────────────────────────────────────────
    if (cfg.policies.requireTestRead && isImplFile(abs)) {
      const readPaths = Object.keys(state.readFiles ?? {});
      const hasTestRead = readPaths.some(isTestFile);
      if (!hasTestRead) {
        recordEvent("POLICY_VIOLATION");
        logDecision({ hook: "policy-guard", tool: data.tool_name, action: "BLOCK",
          target: abs, detail: "requireTestRead: no test file read yet" });
        block(`BLOCKED [policy]: read a test file before editing '${abs.split("/").pop()}'`);
        return;
      }
    }
  }

  approve();
}

main().catch(() => process.exit(1));
