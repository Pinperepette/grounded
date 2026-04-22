from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


class StructuredLogger:
    """All events written as newline-delimited JSON. No rotation, no buffering."""

    def __init__(self, log_file: str):
        self.log_file = Path(log_file)

    # ------------------------------------------------------------------ #
    # Internal                                                             #
    # ------------------------------------------------------------------ #

    def _write(self, event: str, payload: dict) -> None:
        entry = {"ts": time.time(), "event": event, **payload}
        with self.log_file.open("a") as f:
            f.write(json.dumps(entry, default=str) + "\n")

    # ------------------------------------------------------------------ #
    # Public log methods                                                   #
    # ------------------------------------------------------------------ #

    def tool_call(self, tool: str, inputs: dict, output: Any, duration_ms: float) -> None:
        self._write("tool_call", {
            "tool": tool,
            "inputs": inputs,
            "output_preview": str(output)[:400],
            "duration_ms": round(duration_ms, 2),
        })

    def enforcement_failure(self, attempt: int, reasons: list[str], response_preview: str) -> None:
        self._write("enforcement_failure", {
            "attempt": attempt,
            "reasons": reasons,
            "response_preview": response_preview[:300],
        })

    def hallucination_detected(self, attempt: int, identifier: str, reason: str) -> None:
        self._write("hallucination_detected", {
            "attempt": attempt,
            "identifier": identifier,
            "reason": reason,
        })

    def retry(self, attempt: int, total: int, trigger: str) -> None:
        self._write("retry", {
            "attempt": attempt,
            "total": total,
            "trigger": trigger,
        })

    def success(self, attempt: int, tool_call_count: int, claims_verified: int) -> None:
        self._write("success", {
            "attempt": attempt,
            "tool_call_count": tool_call_count,
            "claims_verified": claims_verified,
        })

    def exhausted(self, total_attempts: int) -> None:
        self._write("exhausted", {"total_attempts": total_attempts})
