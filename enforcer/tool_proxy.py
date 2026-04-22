import json
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional


@dataclass
class SearchMatch:
    file: str
    line_number: int
    text: str


@dataclass
class SearchResult:
    tool_used: str          # "rg" or "grep"
    pattern: str
    path: str
    matches: List[SearchMatch] = field(default_factory=list)
    success: bool = True
    error: Optional[str] = None
    duration_ms: float = 0.0

    def found(self) -> bool:
        return self.success and bool(self.matches)

    def to_string(self, max_matches: int = 50) -> str:
        if not self.success:
            return f"SEARCH_ERROR: {self.error}"
        if not self.matches:
            return f"NOT_FOUND: pattern='{self.pattern}' path='{self.path}'"
        shown = self.matches[:max_matches]
        lines = [f"FOUND {len(self.matches)} match(es) for '{self.pattern}':"]
        for m in shown:
            lines.append(f"  {m.file}:{m.line_number}: {m.text}")
        if len(self.matches) > max_matches:
            lines.append(f"  ... ({len(self.matches) - max_matches} more)")
        return "\n".join(lines)


class ToolProxy:
    """
    Subprocess wrapper for rg/grep.
    Falls back from rg to grep automatically if rg is absent.
    Normalises results into SearchResult regardless of backend.
    """

    def __init__(self, logger, timeout: int = 30):
        self.logger = logger
        self.timeout = timeout
        self._use_rg = shutil.which("rg") is not None
        self._use_grep = shutil.which("grep") is not None

        if not self._use_rg and not self._use_grep:
            raise RuntimeError("Neither rg nor grep is available; cannot run searches.")

    # ------------------------------------------------------------------ #
    # Public API                                                           #
    # ------------------------------------------------------------------ #

    def search(
        self,
        pattern: str,
        path: str,
        case_sensitive: bool = False,
    ) -> SearchResult:
        start = time.time()
        result = (
            self._rg(pattern, path, case_sensitive)
            if self._use_rg
            else self._grep(pattern, path, case_sensitive)
        )
        result.duration_ms = (time.time() - start) * 1000
        self.logger.tool_call(
            "search",
            {"pattern": pattern, "path": path, "case_sensitive": case_sensitive},
            result.to_string(),
            result.duration_ms,
        )
        return result

    def read_file(self, path: str, max_chars: int = 12000) -> Optional[str]:
        start = time.time()
        try:
            content = Path(path).read_text(errors="replace")
        except (IOError, OSError) as exc:
            self.logger.tool_call("read_file", {"path": path}, f"ERROR: {exc}", 0)
            return None
        truncated = content[:max_chars]
        if len(content) > max_chars:
            truncated += "\n... [truncated]"
        self.logger.tool_call(
            "read_file",
            {"path": path},
            f"{len(content)} chars",
            (time.time() - start) * 1000,
        )
        return truncated

    def list_files(self, path: str, pattern: str = "*") -> List[str]:
        start = time.time()
        try:
            if self._use_rg:
                proc = subprocess.run(
                    ["rg", "--files", "--glob", pattern, path],
                    capture_output=True, text=True, timeout=self.timeout,
                )
                files = [l.strip() for l in proc.stdout.splitlines() if l.strip()]
            else:
                files = [str(p) for p in Path(path).rglob(pattern)]
        except Exception as exc:
            files = []
        self.logger.tool_call(
            "list_files",
            {"path": path, "pattern": pattern},
            f"{len(files)} files",
            (time.time() - start) * 1000,
        )
        return files

    def file_exists(self, path: str) -> bool:
        return Path(path).is_file()

    # ------------------------------------------------------------------ #
    # Private backends                                                     #
    # ------------------------------------------------------------------ #

    def _rg(self, pattern: str, path: str, case_sensitive: bool) -> SearchResult:
        cmd = ["rg", "--json"]
        if not case_sensitive:
            cmd.append("-i")
        cmd += [pattern, path]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=self.timeout)
            # rg exits 0 = matches found, 1 = no matches, >1 = error
            if proc.returncode > 1:
                return SearchResult("rg", pattern, path, [], False, proc.stderr.strip())
            return SearchResult("rg", pattern, path, self._parse_rg_json(proc.stdout), True)
        except subprocess.TimeoutExpired:
            return SearchResult("rg", pattern, path, [], False, "timeout")
        except Exception as exc:
            return SearchResult("rg", pattern, path, [], False, str(exc))

    def _grep(self, pattern: str, path: str, case_sensitive: bool) -> SearchResult:
        cmd = ["grep", "-rn"]
        if not case_sensitive:
            cmd.append("-i")
        cmd += [pattern, path]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=self.timeout)
            if proc.returncode > 1:
                return SearchResult("grep", pattern, path, [], False, proc.stderr.strip())
            return SearchResult("grep", pattern, path, self._parse_grep(proc.stdout), True)
        except subprocess.TimeoutExpired:
            return SearchResult("grep", pattern, path, [], False, "timeout")
        except Exception as exc:
            return SearchResult("grep", pattern, path, [], False, str(exc))

    @staticmethod
    def _parse_rg_json(output: str) -> List[SearchMatch]:
        matches: List[SearchMatch] = []
        for line in output.splitlines():
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "match":
                continue
            data = obj["data"]
            matches.append(SearchMatch(
                file=data["path"]["text"],
                line_number=data["line_number"],
                text=data["lines"]["text"].rstrip("\n"),
            ))
        return matches

    @staticmethod
    def _parse_grep(output: str) -> List[SearchMatch]:
        matches: List[SearchMatch] = []
        for line in output.splitlines():
            parts = line.split(":", 2)
            if len(parts) < 3:
                continue
            try:
                matches.append(SearchMatch(
                    file=parts[0],
                    line_number=int(parts[1]),
                    text=parts[2],
                ))
            except ValueError:
                continue
        return matches
