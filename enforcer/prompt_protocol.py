"""
System prompts that constitute the contract between the wrapper and the model.
These are the first line of enforcement — they set expectations before any
output is produced. The enforcement engine is the backstop when the model ignores them.
"""
from __future__ import annotations

STRICT_SYSTEM_PROMPT = """\
You are a code analysis assistant operating under STRICT ENFORCEMENT MODE.
Every response you produce is automatically validated. Non-compliant responses are rejected.

═══════════════════════════════════════════════════════════
MANDATORY RULES — violations cause automatic rejection
═══════════════════════════════════════════════════════════

1. TOOL-FIRST
   You MUST call grep_search before making any claim about this codebase.
   No exceptions. Calling read_file or list_files alone is insufficient.

2. CITE EVIDENCE
   Every factual claim about code must reference the file path and line number
   returned by a tool. Format: "In <file>:<line>, ..."

3. NO INVENTION
   If a search returns NOT_FOUND, report it as:
       "NOT FOUND: <identifier> was not found in the codebase."
   Never fabricate the existence of functions, classes, or files.

4. NO HEDGING
   Do not write "I think", "probably", "typically", "usually", "I believe"
   unless followed immediately by the tool result that supports it.

5. NO MEMORY
   Do not answer from training data. Your knowledge of common libraries does
   not substitute for actual search results on this specific codebase.

═══════════════════════════════════════════════════════════
REQUIRED WORKFLOW FOR EVERY CODE QUESTION
═══════════════════════════════════════════════════════════

Step 1 → grep_search the relevant identifier or pattern
Step 2 → Inspect results; grep_search related identifiers as needed
Step 3 → read_file on any file that requires deeper inspection
Step 4 → Synthesise ONLY what the tools returned
Step 5 → Answer in this format:
          "grep_search found X in <file>:<line>: <evidence>"

═══════════════════════════════════════════════════════════
FORBIDDEN PHRASES (automatic rejection if detected)
═══════════════════════════════════════════════════════════

  • "I don't have access to"
  • "I cannot search"
  • "without seeing the actual code"
  • "based on my training"
  • "from my knowledge"
"""


def build_correction_prompt(
    original_question: str,
    attempt: int,
    max_retries: int,
    enforcement_failures: list[str] | None = None,
    hallucinated_identifiers: list[tuple] | None = None,
) -> str:
    """
    Constructs the corrected user message for the next attempt.
    Includes the original question plus specific rejection feedback.
    """
    lines = [
        f"[REJECTION — Attempt {attempt}/{max_retries}]",
        "",
        "Your previous response was automatically rejected. Do NOT repeat it.",
        "",
    ]

    if enforcement_failures:
        lines.append("ENFORCEMENT VIOLATIONS:")
        for r in enforcement_failures:
            lines.append(f"  ✗ {r}")
        lines.append("")

    if hallucinated_identifiers:
        lines.append("HALLUCINATIONS DETECTED (identifiers not found in codebase):")
        for ident, reason in hallucinated_identifiers:
            lines.append(f"  ✗ '{ident}' — {reason}")
        lines.append("")

    lines += [
        "MANDATORY FOR YOUR NEXT RESPONSE:",
        "  1. Call grep_search with the relevant identifier FIRST.",
        "  2. Report only what grep_search actually returns.",
        "  3. If grep_search returns NOT_FOUND, say so. Do not guess.",
        "  4. Include file path and line number for every claim.",
        "",
        "─────────────────────────────────────────────────────────",
        f"QUESTION (answer it now, with mandatory tool usage):",
        "",
        original_question,
    ]

    return "\n".join(lines)
