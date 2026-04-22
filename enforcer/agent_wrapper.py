"""
AgentWrapper — the top-level orchestrator.

Sits between the caller and the Claude API.  Every user question goes through:
  invoke → enforcement check → semantic validation → retry if rejected → answer

Nothing leaves this class without passing both gates.
"""
from typing import List, Optional, Tuple

import anthropic

from .config import Config
from .enforcement_engine import EnforcementEngine
from .logger import StructuredLogger
from .prompt_protocol import STRICT_SYSTEM_PROMPT
from .retry_controller import RetryController, RunResult
from .semantic_validator import SemanticValidator
from .tool_proxy import ToolProxy
from .tools_definition import TOOLS


class AgentWrapper:
    """
    Public interface: AgentWrapper(codebase_path).ask(question) -> dict

    Guarantees:
      • Model MUST use grep_search before answering.
      • All code identifiers in the answer MUST exist in the codebase.
      • Non-compliant responses are retried with corrective feedback.
    """

    def __init__(self, codebase_path: str, config: Optional[Config] = None):
        self.codebase_path = codebase_path
        self.config = config or Config()

        self.logger = StructuredLogger(self.config.log_file)
        self.proxy = ToolProxy(self.logger, self.config.search_timeout)
        self.enforcement = EnforcementEngine(self.logger, self.config.min_tool_calls)
        self.validator = SemanticValidator(self.proxy, self.logger, codebase_path)
        self.retry_ctrl = RetryController(self.logger, self.config.max_retries)
        self.client = anthropic.Anthropic()

    # ------------------------------------------------------------------ #
    # Public                                                               #
    # ------------------------------------------------------------------ #

    def ask(self, question: str) -> dict:
        """
        Ask a question about the codebase.

        Returns a dict:
          {
            "status":      "success" | "failure",
            "answer":      str | None,
            "attempts":    int,
            "tool_calls":  list of {name, input, output},
          }
        """
        result: RunResult = self.retry_ctrl.run(
            original_question=question,
            invoke_fn=self._invoke,
            enforcement=self.enforcement,
            validator=self.validator,
        )

        last = result.attempts[-1] if result.attempts else None
        return {
            "status": "success" if result.succeeded else "failure",
            "answer": result.answer,
            "attempts": len(result.attempts),
            "tool_calls": last.tool_calls if last else [],
            "rejection_summary": result.rejection_summary(),
        }

    # ------------------------------------------------------------------ #
    # Private — one complete agentic turn (tool loop → final text)        #
    # ------------------------------------------------------------------ #

    def _invoke(self, messages: List[dict]) -> Tuple[str, List[dict]]:
        """
        Runs the agentic tool-use loop until the model stops calling tools.
        Returns (final_text, accumulated_tool_calls).
        """
        tool_calls_log: List[dict] = []
        current_messages = self._inject_path_hint(messages)

        while True:
            # Force at least one tool on the first API call of each attempt.
            # Once tools have been used, let the model decide when to stop.
            tool_choice = (
                {"type": "any"}
                if not tool_calls_log
                else {"type": "auto"}
            )

            response = self.client.messages.create(
                model=self.config.model,
                max_tokens=self.config.max_tokens,
                system=STRICT_SYSTEM_PROMPT,
                tools=TOOLS,
                tool_choice=tool_choice,
                messages=current_messages,
            )

            tool_use_blocks = [b for b in response.content if b.type == "tool_use"]
            text_blocks = [b for b in response.content if b.type == "text"]

            if not tool_use_blocks:
                # Model issued no more tool calls → collect text and return
                final_text = "\n".join(b.text for b in text_blocks)
                return final_text, tool_calls_log

            # Execute each tool call and collect results
            tool_results = []
            for block in tool_use_blocks:
                output = self._execute_tool(block.name, block.input)
                tool_calls_log.append({
                    "name": block.name,
                    "input": block.input,
                    "output": output,
                })
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output,
                })

            # Extend conversation with assistant turn + tool results
            current_messages = current_messages + [
                {"role": "assistant", "content": response.content},
                {"role": "user", "content": tool_results},
            ]

    def _execute_tool(self, name: str, inputs: dict) -> str:
        if name == "grep_search":
            result = self.proxy.search(
                pattern=inputs["pattern"],
                path=inputs.get("path", self.codebase_path),
                case_sensitive=inputs.get("case_sensitive", False),
            )
            return result.to_string(self.config.max_matches_per_search)

        if name == "read_file":
            content = self.proxy.read_file(
                inputs["path"],
                self.config.max_file_read_chars,
            )
            return content if content is not None else f"ERROR: file not found: {inputs['path']}"

        if name == "list_files":
            files = self.proxy.list_files(
                inputs["path"],
                inputs.get("pattern", "*"),
            )
            return "\n".join(files[:100]) if files else f"No files found in {inputs['path']}"

        return f"ERROR: unknown tool '{name}'"

    def _inject_path_hint(self, messages: List[dict]) -> List[dict]:
        """Appends the codebase path to the first user message so the model knows where to search."""
        if not messages or messages[0]["role"] != "user":
            return messages
        updated = list(messages)
        original_content = updated[0]["content"]
        updated[0] = {
            **updated[0],
            "content": f"{original_content}\n\n[CODEBASE PATH: {self.codebase_path}]",
        }
        return updated
