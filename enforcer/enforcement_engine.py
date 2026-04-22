import re
from dataclasses import dataclass, field
from typing import List


@dataclass
class EnforcementResult:
    passed: bool
    failure_reasons: List[str] = field(default_factory=list)
    tools_used: List[str] = field(default_factory=list)
    tool_call_count: int = 0


# These phrases in a final response without any tool evidence are red flags.
_EVASION_PATTERNS: List[tuple] = [
    (r"I don't have access to", "MODEL_CLAIMS_NO_ACCESS"),
    (r"I cannot search", "MODEL_CLAIMS_CANT_SEARCH"),
    (r"I don't have the ability to", "MODEL_CLAIMS_NO_ABILITY"),
    (r"without seeing the actual code", "MODEL_ADMITS_NO_CODE"),
    (r"I would need to see the", "MODEL_ADMITS_NO_CODE"),
    (r"I'm not able to access", "MODEL_CLAIMS_NO_ACCESS"),
    (r"I cannot access", "MODEL_CLAIMS_NO_ACCESS"),
    (r"based on my training", "MODEL_USING_TRAINING_DATA"),
    (r"from my knowledge", "MODEL_USING_TRAINING_DATA"),
]

# These indicate the model is guessing instead of reporting tool evidence.
_HEDGING_PATTERNS: List[str] = [
    r"\bI think\b",
    r"\bI believe\b",
    r"\bprobably\b",
    r"\blikely\b",
    r"\btypically\b",
    r"\bgenerally speaking\b",
    r"\busually\b",
]

_SEARCH_TOOL_NAMES = {"grep_search", "search_code"}


class EnforcementEngine:
    """
    Gate that rejects model responses lacking tool evidence.
    Checks are deterministic — no fuzzy scoring.
    """

    def __init__(self, logger, min_tool_calls: int = 1):
        self.logger = logger
        self.min_tool_calls = min_tool_calls

    def check(
        self,
        tool_calls: List[dict],
        final_response: str,
        attempt: int = 1,
    ) -> EnforcementResult:
        """
        tool_calls: list of {"name": str, "input": dict, "output": str}
        final_response: the model's final text answer
        """
        failures: List[str] = []
        tools_used = [tc["name"] for tc in tool_calls]

        # --- Rule 1: Minimum tool usage ---
        if len(tool_calls) < self.min_tool_calls:
            failures.append(
                f"NO_TOOL_USAGE: model produced an answer without calling any tools "
                f"(required minimum: {self.min_tool_calls})"
            )

        # --- Rule 2: A search tool must have been called ---
        search_calls = [tc for tc in tool_calls if tc["name"] in _SEARCH_TOOL_NAMES]
        if len(tool_calls) >= self.min_tool_calls and not search_calls:
            failures.append(
                "NO_SEARCH_TOOL: tools were called but none were grep_search — "
                "at least one search is mandatory before answering"
            )

        # --- Rule 3: Evasion phrases are forbidden ---
        for pattern, code in _EVASION_PATTERNS:
            if re.search(pattern, final_response, re.IGNORECASE):
                failures.append(
                    f"{code}: forbidden phrase detected matching r'{pattern}'"
                )

        # --- Rule 4: Hedging without evidence ---
        # Accept hedging only if there is concrete file/line citation in the response.
        has_file_cite = bool(
            re.search(r'\b[\w/.-]+\.\w{1,6}:\d+\b', final_response)
        )
        if not has_file_cite and not search_calls:
            for pattern in _HEDGING_PATTERNS:
                if re.search(pattern, final_response, re.IGNORECASE):
                    failures.append(
                        f"HEDGING_WITHOUT_EVIDENCE: '{pattern}' used without any "
                        f"file:line citation or search results"
                    )
                    break  # one flag is enough per response

        if failures:
            self.logger.enforcement_failure(attempt, failures, final_response)

        return EnforcementResult(
            passed=len(failures) == 0,
            failure_reasons=failures,
            tools_used=tools_used,
            tool_call_count=len(tool_calls),
        )
