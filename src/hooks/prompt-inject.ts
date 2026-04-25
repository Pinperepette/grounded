#!/usr/bin/env node
/**
 * UserPromptSubmit hook.
 *
 * v2: Smart co-pilot mode.
 * 1. Re-injects CLAUDE.md to prevent instruction drift.
 * 2. Extracts code identifiers from the user's prompt and suggests
 *    specific Grep queries — before the model starts answering.
 */
import { findProjectRoot, postOk, readClaudeMd, readStdin, superviseHook } from "../utils.js";
import { loadConfig } from "../config.js";

const ENFORCEMENT_RULES = `\
[GROUNDED — Tool Enforcement Active]
Rules that apply to every response:
1. Before claiming any function/class/file exists → use Grep or Read to verify.
2. Before editing an existing file → call Read on that file first.
3. If a search returns nothing → say "NOT FOUND: <identifier>". Do not invent.
4. Prefer native tools (Read, Grep, Glob) over Bash(cat/grep/find) for file access.
5. Never fabricate commit SHAs, file paths, function signatures, or package names.
`;

// Patterns that suggest code-specific identifiers worth searching for
const IDENTIFIER_PATTERNS: Array<[RegExp, string]> = [
  [/`([A-Za-z_]\w{2,})`/g,                "backtick"],
  [/\b([A-Z][a-z]+(?:[A-Z][a-z]*)+)\b/g,  "CamelCase"],
  [/\b([a-z]{2,}_[a-z_]{2,})\b/g,         "snake_case"],
  [/\b([\w/-]+\.(?:ts|js|py|go|rs|java|rb|cpp|cs))\b/g, "file"],
];

// Words that look like identifiers but aren't worth grepping
const NOISE = new Set([
  "the", "and", "for", "not", "can", "use", "add", "get", "set", "run",
  "file", "code", "type", "user", "data", "list", "item", "next", "prev",
  "true", "false", "null", "none", "self", "this", "from", "into", "with",
  "that", "then", "when", "what", "will", "your", "their", "very", "just",
  "test", "main", "base", "node", "root", "path", "name", "make", "call",
]);

function extractIdentifiers(prompt: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const [pattern] of IDENTIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(prompt)) !== null) {
      const id = m[1];
      if (id.length >= 3 && !NOISE.has(id.toLowerCase()) && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
  }

  return result.slice(0, 8); // cap to avoid bloat
}

async function main(): Promise<void> {
  const data = (await readStdin()) as { prompt?: string };

  const cfg = loadConfig();
  const prompt = data?.prompt ?? "";
  const root = findProjectRoot();

  // ── 1. Base enforcement rules (always injected) ───────────────────────────
  let injection = ENFORCEMENT_RULES;

  if (cfg.mode !== "silent") {
    // ── 2. Re-inject CLAUDE.md (prevents instruction drift after ~5 turns) ──
    if (root) {
      const md = readClaudeMd(root);
      if (md) {
        const snippet = md.length > 800 ? md.slice(0, 800) + "\n...[truncated]" : md;
        injection += `\n[Project CLAUDE.md — re-injected to prevent drift]\n${snippet}\n`;
      }
    }

    // ── 3. Smart grep suggestions based on what the user mentioned ───────────
    const identifiers = extractIdentifiers(prompt);
    if (identifiers.length > 0 && root) {
      const suggestions = identifiers
        .map((id) => `  Grep(pattern="${id}", path="${root}")`)
        .join("\n");
      injection +=
        `\n[GROUNDED — Suggested searches based on your prompt]\n` +
        `The following identifiers were detected. Search for them before answering:\n` +
        suggestions + "\n";
    }
  }

  process.stdout.write(
    JSON.stringify({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalSystemPrompt: injection,
      },
    })
  );
}

superviseHook("prompt-inject", main, postOk);
