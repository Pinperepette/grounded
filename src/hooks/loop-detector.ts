#!/usr/bin/env node
/**
 * PostToolUse hook — matcher: .*
 *
 * v2: Uses persistent memory to escalate faster on known-bad patterns.
 * If this exact tool+input hash has caused loops in previous sessions,
 * the threshold drops from 3 to 1.
 */
import { loadState, saveState, logDecision, loadMemory, saveMemory } from "../state.js";
import { postOk, readStdin, simpleHash, superviseHook } from "../utils.js";
import { loadConfig } from "../config.js";
import { recordEvent, getSessionScore } from "../scoring.js";

interface RecoveryStrategy { diagnosis: string; suggestion: string; }

function getRecovery(tool: string, input: Record<string, unknown>): RecoveryStrategy {
  if (tool === "Bash") {
    const cmd = String(input["command"] ?? "");
    if (/\bgrep\b/.test(cmd)) return {
      diagnosis: "You are looping on Bash(grep). The native Grep tool is more reliable.",
      suggestion: `Use the native Grep tool:\n  Grep(pattern="<your pattern>", path="<dir>")`,
    };
    if (/\bcat\b/.test(cmd)) return {
      diagnosis: "You are looping on Bash(cat). Use the native Read tool.",
      suggestion: `Use Read instead:\n  Read(file_path="<path>")`,
    };
    if (/\bfind\b/.test(cmd)) return {
      diagnosis: "You are looping on Bash(find). Use Glob instead.",
      suggestion: `Use Glob:\n  Glob(pattern="**/<filename>", path="<dir>")`,
    };
  }
  if (tool === "Edit" || tool === "Write") {
    const fp = String(input["file_path"] ?? "");
    return {
      diagnosis: `Repeated failed edits to '${fp}'.`,
      suggestion: `Read the file first to get exact current contents:\n  Read(file_path="${fp}")\nThen retry with the correct old_string.`,
    };
  }
  if (tool === "Read") {
    const fp = String(input["file_path"] ?? "");
    return {
      diagnosis: `Reading '${fp}' repeatedly without progress.`,
      suggestion: "Stop re-reading. Act on the contents you have, or use Grep to find a specific pattern within it.",
    };
  }
  if (tool === "Grep") {
    const pattern = String(input["pattern"] ?? "");
    return {
      diagnosis: `Grep('${pattern}') returning the same result repeatedly.`,
      suggestion: `'${pattern}' either doesn't exist or you already have the result.\nTry a broader pattern, or conclude it's NOT FOUND.`,
    };
  }
  return {
    diagnosis: `Repeated '${tool}' call with identical input.`,
    suggestion: "Change your approach entirely, or ask the user for guidance.",
  };
}

async function main(): Promise<void> {
  const data = (await readStdin()) as {
    tool_name: string;
    tool_input: Record<string, unknown>;
  };

  const cfg = loadConfig();
  const state = loadState();
  const now = Date.now();

  const tool = data.tool_name ?? "";
  const inp = data.tool_input ?? {};
  const hash = simpleHash(tool + JSON.stringify(inp));
  const preview = `${tool}(${JSON.stringify(inp).slice(0, 60)})`;

  state.toolCallLog.push({ tool, hash, ts: now });
  if (state.toolCallLog.length > 200) state.toolCallLog = state.toolCallLog.slice(-200);

  const window = state.toolCallLog.slice(-cfg.loopDetector.windowSize);
  const sessionCount = window.filter((c) => c.hash === hash).length;

  // Lazy-load memory: most PostToolUse calls are nowhere near the loop
  // threshold, so we skip the readFileSync + JSON.parse unless we need it.
  // We need it when (a) we're at the threshold or (b) we're one step away
  // and the known-bad shortcut might trip the threshold early.
  const { thresholds } = getSessionScore();
  const baseThreshold = thresholds.loopThreshold;
  const couldFire = sessionCount >= baseThreshold || sessionCount + 1 >= baseThreshold;
  const memory = couldFire ? loadMemory() : null;
  const knownBad = memory?.loopPatterns[hash];
  const effectiveThreshold = knownBad
    ? Math.max(1, baseThreshold - 1)
    : baseThreshold;

  saveState(state);

  if (sessionCount >= effectiveThreshold) {
    // Write to persistent memory so future sessions know this pattern is risky.
    // memory is guaranteed non-null here: entering this branch implies
    // sessionCount >= baseThreshold - 1, which is exactly the couldFire condition above.
    const mem = memory!;
    mem.loopPatterns[hash] = {
      preview,
      count: (knownBad?.count ?? 0) + 1,
      lastSeen: now,
    };
    saveMemory(mem);

    const { diagnosis, suggestion } = getRecovery(tool, inp);
    const knownBadNote = knownBad
      ? `\n(This pattern has caused loops in ${knownBad.count} previous session(s).)`
      : "";

    recordEvent("LOOP_DETECTED");
    logDecision({ hook: "loop-detector", tool, action: "LOOP",
      target: preview, detail: `count=${sessionCount}` });

    process.stdout.write(JSON.stringify({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalSystemPrompt:
          `LOOP (${sessionCount}/${effectiveThreshold})${knownBadNote}: ${diagnosis}\n→ ${suggestion}`,
      },
    }));
  } else {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

superviseHook("loop-detector", main, postOk);
