#!/usr/bin/env node
/**
 * UserPromptSubmit hook — pre-flight planner
 *
 * Analyzes the user's prompt BEFORE Claude starts responding.
 * Detects intent (edit/create/explain/debug) and mentioned identifiers,
 * then injects a concrete tool sequence the model should follow.
 *
 * Goal: prevent errors by planning, not just correcting after they happen.
 */
import { findProjectRoot, postOk, readStdin, superviseHook } from "../utils.js";
import { getMentalState } from "../scoring.js";

// ─── Intent detection ─────────────────────────────────────────────────────────

const INTENT_PATTERNS: Array<[RegExp, Intent]> = [
  [/\b(debug|fix bug|broken|error|exception|crash|fail|not work)\b/i,  "debug"],
  [/\b(edit|change|update|modify|refactor|rename|move|replace|rewrite|correct|adjust)\b/i, "edit"],
  [/\b(add|create|implement|write|build|make|generate|introduce|new file|new function)\b/i, "create"],
  [/\b(find|search|where is|locate|which file|grep|look for)\b/i, "find"],
];

type Intent = "edit" | "create" | "debug" | "find" | "explain";

function detectIntent(text: string): Intent {
  for (const [re, intent] of INTENT_PATTERNS) {
    if (re.test(text)) return intent;
  }
  return "explain";
}

// ─── Identifier & file extraction ────────────────────────────────────────────

const NOISE = new Set([
  "the", "and", "for", "not", "can", "use", "add", "get", "set", "run",
  "file", "code", "type", "user", "data", "list", "item", "next", "this",
  "true", "false", "null", "none", "self", "from", "with", "that", "when",
  "test", "main", "base", "node", "root", "path", "name", "make", "call",
  "fix", "bug", "new", "old", "all", "any", "one", "two", "how", "why",
]);

function extractMentions(text: string): { identifiers: string[]; files: string[] } {
  const files: string[] = [];
  const identifiers: string[] = [];
  const seen = new Set<string>();

  // Backtick-wrapped tokens
  const backtick = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  for (const b of backtick) {
    if (seen.has(b)) continue;
    seen.add(b);
    if (/[./]/.test(b) || /\.[a-z]{2,4}$/.test(b)) {
      files.push(b);
    } else if (b.length >= 3 && !NOISE.has(b.toLowerCase())) {
      identifiers.push(b);
    }
  }

  // Bare file-like patterns: src/foo.ts, ./bar.py
  for (const m of text.matchAll(/\b((?:src|lib|app|test|dist|pkg)\/[\w./-]+\.[\w]+)\b/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); files.push(m[1]); }
  }

  // CamelCase identifiers not already captured
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) {
    if (!seen.has(m[1]) && !NOISE.has(m[1].toLowerCase())) {
      seen.add(m[1]); identifiers.push(m[1]);
    }
  }

  // snake_case with parens — function calls
  for (const m of text.matchAll(/\b([a-z][a-z0-9_]{2,})\(\)/g)) {
    if (!seen.has(m[1]) && !NOISE.has(m[1])) {
      seen.add(m[1]); identifiers.push(m[1]);
    }
  }

  return {
    identifiers: identifiers.slice(0, 5),
    files:       files.slice(0, 4),
  };
}

// ─── Plan generation ──────────────────────────────────────────────────────────

function buildPlan(
  intent: Intent,
  identifiers: string[],
  files: string[],
  root: string,
): string {
  const steps: string[] = [];
  let n = 1;

  // Step 1: verify identifiers exist
  for (const id of identifiers.slice(0, 3)) {
    steps.push(`${n++}. Grep("${id}", "${root}") — verify existence and find location`);
  }

  // Step 2: read mentioned files
  for (const f of files.slice(0, 3)) {
    steps.push(`${n++}. Read("${f}") — must read before any modification`);
  }

  // Step 3: intent-specific tail
  if ((intent === "edit" || intent === "debug") && identifiers.length === 0 && files.length === 0) {
    steps.push(`${n++}. Grep relevant identifiers extracted from the prompt`);
    steps.push(`${n++}. Read matching files`);
    steps.push(`${n++}. Edit — only after reading`);
  } else if (intent === "edit" || intent === "debug") {
    steps.push(`${n++}. Edit — only after all reads above are complete`);
  } else if (intent === "create") {
    if (files.length === 0) steps.push(`${n++}. Read similar existing files for context`);
    steps.push(`${n++}. Write new file`);
  }
  // find/explain: just greps and reads — no edit step

  return steps.join("\n");
}

// ─── Mental state prefix ──────────────────────────────────────────────────────

function mentalPrefix(state: ReturnType<typeof getMentalState>): string {
  switch (state) {
    case "failing":
      return `[⚠ FAILING MODE — score is critically low. You MUST follow the plan exactly below.]\n`;
    case "execution":
      return `[EXECUTION MODE — you are mid-task. Confirm all reads are fresh before editing.]\n`;
    default:
      return "";
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const data = (await readStdin()) as { prompt?: string };
  const prompt = data?.prompt ?? "";

  const root = findProjectRoot();
  if (!root) {
    // No project root → nothing useful to plan
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const intent = detectIntent(prompt);
  const { identifiers, files } = extractMentions(prompt);

  // Only inject a plan when there's something concrete to plan for
  const hasTargets = identifiers.length > 0 || files.length > 0;
  const needsPlan = intent !== "explain" || hasTargets;

  if (!needsPlan) {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const mentalState = getMentalState();
  const plan = buildPlan(intent, identifiers, files, root);
  const prefix = mentalPrefix(mentalState);

  const injection =
    `${prefix}` +
    `[GROUNDED — Pre-flight Plan]\n` +
    `Intent: ${intent.toUpperCase()}` +
    (identifiers.length ? `  |  Identifiers: ${identifiers.join(", ")}` : "") +
    (files.length        ? `  |  Files: ${files.join(", ")}`             : "") +
    `\n\nRequired sequence:\n${plan}\n\n` +
    `Do NOT skip steps. Edits without prior Read will be blocked automatically.`;

  process.stdout.write(
    JSON.stringify({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName:          "UserPromptSubmit",
        additionalSystemPrompt: injection,
      },
    })
  );
}

superviseHook("pre-flight", main, postOk);
