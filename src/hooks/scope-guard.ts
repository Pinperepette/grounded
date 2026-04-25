#!/usr/bin/env node
/**
 * PreToolUse hook — matcher: Edit|Write|MultiEdit|Bash
 *
 * v2: Sensitive file protection added.
 * - Hard blocks writes to system paths (/etc, /usr, etc.)
 * - Blocks writes to sensitive files (.env, *.key, *secret*, etc.)
 *   but allows reads (model can see them, can't overwrite them).
 * - Warns or blocks edits outside project root (configurable).
 */
import { existsSync } from "fs";
import { basename, join, resolve } from "path";
import { loadConfig } from "../config.js";
import { loadState, saveState, logDecision } from "../state.js";
import { approve, block, findProjectRoot, isPathUnder, readStdin, superviseHook } from "../utils.js";
import { recordEvent, getSessionScore } from "../scoring.js";

// Sensitive file patterns — matched against the basename
const SENSITIVE_PATTERNS = [
  /^\.env(\.|$)/i,    // .env, .env.local, .env.production
  /\.env$/i,          // app.env, config.env
  /\.(pem|key|p12|pfx|crt|cer)$/i,
  /secret/i,
  /credential/i,
  /password/i,
  /private[_.-]?key/i,
  /api[_.-]?key/i,
  /auth[_.-]?token/i,
  /\.npmrc$/i,
  /\.netrc$/i,
];

function isSensitive(filePath: string): boolean {
  const name = basename(filePath);
  return SENSITIVE_PATTERNS.some((p) => p.test(name));
}

// Matches real write operations. Excludes:
//   \d>  → numbered fd redirects like 2>/dev/null
//   >&   → fd-to-fd like >&2
//   >/dev/ → redirect to /dev/null etc.
const BASH_WRITE_PATTERNS = /(?:(?<!\d)>>?(?!&|\/dev\/)|\btee\b|\bcp\b|\bmv\b|\brm\b|\bmkdir\b|\btouch\b|\bchmod\b|\bchown\b|\bdd\b|\btruncate\b|\binstall\b)/;

function extractPaths(tool: string, inp: Record<string, unknown>): string[] {
  if (tool === "Bash") {
    const cmd = (inp["command"] as string) ?? "";
    if (!BASH_WRITE_PATTERNS.test(cmd)) return [];
    const matches = cmd.match(/(?:^|\s)(\/[\w][\w./-]*)/g) ?? [];
    return matches.map((m) => m.trim())
      .filter((p) => !p.startsWith("/dev/") && existsSync(p));
  }
  if (tool === "MultiEdit") {
    return ((inp["edits"] as Array<{ file_path: string }>) ?? []).map((e) => e.file_path);
  }
  return [(inp["file_path"] as string) ?? ""].filter(Boolean);
}

async function main(): Promise<void> {
  const data = (await readStdin()) as {
    tool_name: string;
    tool_input: Record<string, unknown>;
  };

  const cfg = loadConfig();
  const state = loadState();

  if (!state.projectRoot) {
    state.projectRoot = findProjectRoot() ?? null;
    saveState(state);
  }

  const root = state.projectRoot;
  const paths = extractPaths(data.tool_name, data.tool_input);

  for (const raw of paths) {
    const abs = resolve(raw);

    // ── 1. Sensitive file protection ─────────────────────────────────────────
    if (isSensitive(abs)) {
      recordEvent("SENSITIVE_FILE");
      logDecision({ hook: "scope-guard", tool: data.tool_name, action: "SENSITIVE", target: abs,
        detail: "sensitive file write blocked" });
      block(`BLOCKED [scope]: sensitive file '${basename(abs)}'`);
      return;
    }

    // ── 2. Hard block on system paths ────────────────────────────────────────
    const isSystemPath = cfg.scopeGuard.blockedPaths.some((bp) => abs.startsWith(bp));
    if (isSystemPath) {
      logDecision({ hook: "scope-guard", tool: data.tool_name, action: "BLOCK", target: abs,
        detail: "system path" });
      block(`BLOCKED [scope]: system path '${abs}'`);
      return;
    }

    // ── 3. Out-of-project-root check ─────────────────────────────────────────
    const ALWAYS_ALLOWED = [
      join(process.env.HOME ?? "/tmp", ".claude"),
      join(process.env.HOME ?? "/tmp", "Desktop"),
      "/tmp",
      "/private/tmp",
    ];
    if (root && !isPathUnder(abs, root)) {
      const allowed =
        ALWAYS_ALLOWED.some((r) => isPathUnder(abs, r)) ||
        cfg.scopeGuard.extraAllowedRoots.some((r) => isPathUnder(abs, r));
      if (!allowed) {
        recordEvent("SCOPE_VIOLATION");
        const { thresholds } = getSessionScore();
        const effectiveMode = thresholds.scopeMode;

        if (effectiveMode === "block") {
          logDecision({ hook: "scope-guard", tool: data.tool_name, action: "BLOCK", target: abs,
            detail: "outside project root" });
          block(`BLOCKED [scope]: '${abs}' outside project root`);
          return;
        } else {
          logDecision({ hook: "scope-guard", tool: data.tool_name, action: "WARN", target: abs,
            detail: "outside project root (warn mode)" });
          const warnOut: Record<string, unknown> = { decision: "approve" };
          if (cfg.mode !== "silent") {
            warnOut.hookSpecificOutput = {
              hookEventName: "PreToolUse",
              additionalSystemPrompt: `[scope] '${abs}' is outside project root — confirm this is intentional.`,
            };
          }
          process.stdout.write(JSON.stringify(warnOut));
          return;
        }
      }
    }
  }

  logDecision({ hook: "scope-guard", tool: data.tool_name, action: "APPROVE",
    target: paths[0] });
  approve();
}

superviseHook("scope-guard", main);
