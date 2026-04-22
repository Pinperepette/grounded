from dataclasses import dataclass, field
from typing import Callable, List, Optional, Tuple

from .enforcement_engine import EnforcementEngine, EnforcementResult
from .prompt_protocol import build_correction_prompt
from .semantic_validator import SemanticValidator, ValidationResult


@dataclass
class Attempt:
    number: int
    tool_calls: List[dict]
    response_text: str
    enforcement: EnforcementResult
    validation: Optional[ValidationResult] = None
    rejected: bool = True


@dataclass
class RunResult:
    succeeded: bool
    answer: Optional[str]
    attempts: List[Attempt]

    def total_tool_calls(self) -> int:
        if not self.attempts:
            return 0
        return self.attempts[-1].tool_calls.__len__()

    def rejection_summary(self) -> List[str]:
        summary = []
        for a in self.attempts:
            if a.rejected:
                summary.append(f"Attempt {a.number}: {a.enforcement.failure_reasons}")
        return summary


InvokeFn = Callable[[List[dict]], Tuple[str, List[dict]]]
# Signature: invoke_fn(messages) -> (response_text, tool_calls_log)


class RetryController:
    """
    Self-healing loop. On every failure it:
      1. Records the attempt.
      2. Builds corrective feedback specific to what went wrong.
      3. Reconstructs messages from scratch (avoids dangling tool_use blocks).
      4. Re-invokes the model.

    Terminates on first success or when max_retries is exhausted.
    """

    def __init__(self, logger, max_retries: int = 3):
        self.logger = logger
        self.max_retries = max_retries

    def run(
        self,
        original_question: str,
        invoke_fn: InvokeFn,
        enforcement: EnforcementEngine,
        validator: SemanticValidator,
    ) -> RunResult:
        attempts: List[Attempt] = []

        for attempt_num in range(1, self.max_retries + 1):
            self.logger.retry(attempt_num, self.max_retries, "starting")

            # Build clean message list for this attempt (no history pollution)
            messages = self._build_messages(
                original_question, attempt_num, attempts
            )

            response_text, tool_calls = invoke_fn(messages)

            enforcement_result = enforcement.check(tool_calls, response_text, attempt_num)

            if not enforcement_result.passed:
                attempt = Attempt(
                    number=attempt_num,
                    tool_calls=tool_calls,
                    response_text=response_text,
                    enforcement=enforcement_result,
                    rejected=True,
                )
                attempts.append(attempt)
                self.logger.retry(
                    attempt_num, self.max_retries,
                    f"enforcement_failed: {enforcement_result.failure_reasons}"
                )
                continue

            validation_result = validator.validate(response_text, tool_calls, attempt_num)

            if not validation_result.passed:
                attempt = Attempt(
                    number=attempt_num,
                    tool_calls=tool_calls,
                    response_text=response_text,
                    enforcement=enforcement_result,
                    validation=validation_result,
                    rejected=True,
                )
                attempts.append(attempt)
                self.logger.retry(
                    attempt_num, self.max_retries,
                    f"hallucinations: {[c.identifier for c, _ in validation_result.failed]}"
                )
                continue

            # SUCCESS
            attempt = Attempt(
                number=attempt_num,
                tool_calls=tool_calls,
                response_text=response_text,
                enforcement=enforcement_result,
                validation=validation_result,
                rejected=False,
            )
            attempts.append(attempt)
            self.logger.success(
                attempt_num,
                len(tool_calls),
                len(validation_result.verified),
            )
            return RunResult(succeeded=True, answer=response_text, attempts=attempts)

        self.logger.exhausted(self.max_retries)
        return RunResult(succeeded=False, answer=None, attempts=attempts)

    # ------------------------------------------------------------------ #
    # Private                                                              #
    # ------------------------------------------------------------------ #

    def _build_messages(
        self,
        original_question: str,
        attempt_num: int,
        prior_attempts: List[Attempt],
    ) -> List[dict]:
        """
        Each retry starts with a fresh message list.
        Prior rejection context is folded into the user message so the
        conversation history never contains orphaned tool_use blocks.
        """
        if attempt_num == 1 or not prior_attempts:
            return [{"role": "user", "content": original_question}]

        # Collect what went wrong in previous attempts
        enforcement_failures: List[str] = []
        hallucinated: List[tuple] = []

        for prev in prior_attempts:
            enforcement_failures.extend(prev.enforcement.failure_reasons)
            if prev.validation:
                for claim, reason in prev.validation.failed:
                    hallucinated.append((claim.identifier, reason))

        corrected_content = build_correction_prompt(
            original_question=original_question,
            attempt=attempt_num,
            max_retries=self.max_retries,
            enforcement_failures=enforcement_failures or None,
            hallucinated_identifiers=hallucinated or None,
        )
        return [{"role": "user", "content": corrected_content}]
