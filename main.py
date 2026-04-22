"""
main.py — entry point and demonstration of the failure → retry → success cycle.

Usage:
    python main.py <codebase_path> [question]

Example:
    python main.py /path/to/myproject "What does the main entry point do?"
"""
import json
import sys
from pathlib import Path

from enforcer import AgentWrapper, Config


# ─────────────────────────────────────────────────────────────────────────────
# Demo: create a small fake codebase so the example is self-contained
# ─────────────────────────────────────────────────────────────────────────────

def create_demo_codebase(base: Path) -> None:
    """Writes a minimal Python project so the demo has something real to search."""
    (base / "src").mkdir(parents=True, exist_ok=True)

    (base / "src" / "config.py").write_text("""\
class AppConfig:
    DEBUG = False
    MAX_RETRIES = 3
    TIMEOUT = 30

def load_config(path: str) -> AppConfig:
    cfg = AppConfig()
    return cfg
""")

    (base / "src" / "processor.py").write_text("""\
from .config import load_config

class DataProcessor:
    def __init__(self, config_path: str):
        self.config = load_config(config_path)
        self._queue = []

    def enqueue(self, item: dict) -> None:
        self._queue.append(item)

    def process_all(self) -> list:
        results = []
        for item in self._queue:
            results.append(self._transform(item))
        self._queue.clear()
        return results

    def _transform(self, item: dict) -> dict:
        return {k: str(v).strip() for k, v in item.items()}
""")

    (base / "main.py").write_text("""\
from src.processor import DataProcessor

def run(config_path: str = "config.yaml") -> None:
    proc = DataProcessor(config_path)
    proc.enqueue({"name": "Alice", "score": 42})
    proc.enqueue({"name": "Bob",   "score": 37})
    results = proc.process_all()
    for r in results:
        print(r)

if __name__ == "__main__":
    run()
""")


# ─────────────────────────────────────────────────────────────────────────────
# Output helpers
# ─────────────────────────────────────────────────────────────────────────────

def print_separator(title: str = "") -> None:
    width = 64
    if title:
        pad = (width - len(title) - 2) // 2
        print("─" * pad + f" {title} " + "─" * pad)
    else:
        print("─" * width)


def print_result(result: dict) -> None:
    print_separator("RESULT")
    print(f"Status   : {result['status'].upper()}")
    print(f"Attempts : {result['attempts']}")
    print(f"Tool calls in final attempt: {len(result['tool_calls'])}")

    if result["tool_calls"]:
        print_separator("Tool Evidence Used")
        for tc in result["tool_calls"]:
            preview = str(tc["output"])[:120].replace("\n", " ")
            print(f"  [{tc['name']}] {list(tc['input'].values())[0]!r}")
            print(f"    → {preview}")

    if result["rejection_summary"]:
        print_separator("Rejection Log (earlier attempts)")
        for entry in result["rejection_summary"]:
            print(f"  {entry}")

    print_separator("Answer")
    if result["answer"]:
        print(result["answer"])
    else:
        print("NO VALID ANSWER produced after all retries.")

    print_separator()


def print_log_tail(log_file: str, n: int = 12) -> None:
    try:
        lines = Path(log_file).read_text().splitlines()
        print_separator(f"Last {n} log entries ({log_file})")
        for raw in lines[-n:]:
            entry = json.loads(raw)
            event = entry.pop("event")
            entry.pop("ts", None)
            print(f"  [{event}] {json.dumps(entry, default=str)[:110]}")
    except FileNotFoundError:
        print("(log file not written yet)")


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    demo_mode = False

    if len(sys.argv) < 2:
        # Self-contained demo: build a tiny codebase and query it
        demo_dir = Path("/tmp/enforcer_demo_codebase")
        create_demo_codebase(demo_dir)
        codebase_path = str(demo_dir)
        question = (
            "What does DataProcessor do and how is it used in the entry point? "
            "List every class and function involved."
        )
        demo_mode = True
        print("No path provided — running self-contained demo.")
        print(f"Demo codebase written to: {codebase_path}\n")
    else:
        codebase_path = sys.argv[1]
        question = sys.argv[2] if len(sys.argv) > 2 else (
            "What does the main entry point of this codebase do? "
            "List the key functions and classes."
        )

    if not Path(codebase_path).exists():
        print(f"ERROR: path does not exist: {codebase_path}")
        sys.exit(1)

    config = Config(
        max_retries=3,
        log_file="enforcer_log.jsonl",
        min_tool_calls=1,
    )

    print("=" * 64)
    print("  SELF-HEALING TOOL-ENFORCED AGENT WRAPPER")
    print("=" * 64)
    print(f"Codebase : {codebase_path}")
    print(f"Question : {question}")
    print(f"Model    : {config.model}")
    print(f"Retries  : {config.max_retries}")
    print_separator()

    wrapper = AgentWrapper(codebase_path=codebase_path, config=config)
    result = wrapper.ask(question)

    print_result(result)
    print_log_tail(config.log_file)


if __name__ == "__main__":
    main()
