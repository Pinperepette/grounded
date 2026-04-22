import re
from dataclasses import dataclass, field
from typing import List, Set, Tuple

from .tool_proxy import ToolProxy


@dataclass
class Claim:
    raw_text: str       # The matched snippet from the response
    identifier: str     # The specific name being claimed
    claim_type: str     # "function" | "class" | "file" | "identifier"


@dataclass
class ValidationResult:
    passed: bool
    verified: List[Claim] = field(default_factory=list)
    failed: List[Tuple[Claim, str]] = field(default_factory=list)   # (claim, reason)
    skipped: List[Claim] = field(default_factory=list)              # noise / too generic


# Patterns that extract specific code identifiers from prose.
# Each tuple: (regex, capture_group_index, claim_type)
_CLAIM_PATTERNS: List[Tuple[str, int, str]] = [
    # "function foo" / "method foo" / "def foo"
    (r'(?:function|method|def)\s+`?([A-Za-z_]\w+)`?', 1, "function"),
    # "class Foo" (capitalised)
    (r'class\s+`?([A-Z]\w+)`?', 1, "class"),
    # Backtick-wrapped identifier (most common in markdown responses)
    (r'`([A-Za-z_]\w+(?:\.\w+)*)`', 1, "identifier"),
    # "in file.py" or "src/foo/bar.py"
    (r'\b([\w./-]+\.(?:py|js|ts|go|rs|java|c|cpp|rb|php|cs))\b', 1, "file"),
]

# Python/JS/Go builtins and very common words that are not codebase-specific.
_NOISE: Set[str] = {
    "true", "false", "none", "null", "undefined", "self", "this", "super",
    "int", "str", "bool", "list", "dict", "set", "tuple", "float", "bytes",
    "object", "type", "any", "void", "async", "await", "return", "yield",
    "import", "from", "class", "def", "for", "while", "if", "else", "try",
    "except", "with", "pass", "break", "continue", "raise", "assert",
    "main", "args", "kwargs", "key", "val", "value", "values", "items",
    "name", "path", "data", "text", "line", "file", "func", "init",
    "app", "api", "err", "error", "msg", "log", "info", "warn", "debug",
    "test", "mock", "util", "utils", "base", "node", "root", "next", "prev",
    "index", "count", "size", "len", "get", "set", "add", "run", "stop",
}


def _should_validate(identifier: str) -> bool:
    if len(identifier) < 4:
        return False
    if identifier.lower() in _NOISE:
        return False
    # Skip things that look like generic file extensions
    if re.fullmatch(r'\.[a-z]{1,6}', identifier):
        return False
    return True


class SemanticValidator:
    """
    Extracts code-specific claims from a model response and verifies each one
    exists in the actual codebase via search.  Any claim that cannot be found
    is flagged as a hallucination.
    """

    def __init__(self, proxy: ToolProxy, logger, codebase_path: str):
        self.proxy = proxy
        self.logger = logger
        self.codebase_path = codebase_path

    def validate(
        self,
        response_text: str,
        tool_calls: List[dict],
        attempt: int = 1,
    ) -> ValidationResult:
        claims = self._extract_claims(response_text)
        already_evidenced = self._evidence_set(tool_calls)

        verified: List[Claim] = []
        failed: List[Tuple[Claim, str]] = []
        skipped: List[Claim] = []

        seen_identifiers: Set[str] = set()

        for claim in claims:
            ident = claim.identifier

            # De-duplicate — no need to verify the same name twice per response
            if ident in seen_identifiers:
                continue
            seen_identifiers.add(ident)

            if not _should_validate(ident):
                skipped.append(claim)
                continue

            # Already present in tool output → accepted without extra search
            if ident in already_evidenced or ident.lower() in {e.lower() for e in already_evidenced}:
                verified.append(claim)
                continue

            # For file claims: check existence directly
            if claim.claim_type == "file":
                exists = self.proxy.file_exists(ident) or self.proxy.file_exists(
                    f"{self.codebase_path}/{ident}"
                )
                if exists:
                    verified.append(claim)
                else:
                    # Try a search for the filename pattern
                    result = self.proxy.search(
                        pattern=re.escape(ident.split("/")[-1]),
                        path=self.codebase_path,
                    )
                    if result.found():
                        verified.append(claim)
                    else:
                        reason = f"FILE_NOT_FOUND: '{ident}' does not exist and was not found by search"
                        failed.append((claim, reason))
                        self.logger.hallucination_detected(attempt, ident, reason)
                continue

            # General identifier: search for it
            result = self.proxy.search(
                pattern=rf'\b{re.escape(ident)}\b',
                path=self.codebase_path,
                case_sensitive=True,
            )
            if result.found():
                verified.append(claim)
            else:
                reason = f"IDENTIFIER_NOT_FOUND: '{ident}' not present in codebase"
                failed.append((claim, reason))
                self.logger.hallucination_detected(attempt, ident, reason)

        return ValidationResult(
            passed=len(failed) == 0,
            verified=verified,
            failed=failed,
            skipped=skipped,
        )

    # ------------------------------------------------------------------ #
    # Private helpers                                                      #
    # ------------------------------------------------------------------ #

    def _extract_claims(self, text: str) -> List[Claim]:
        seen: Set[str] = set()
        claims: List[Claim] = []
        for pattern, group, ctype in _CLAIM_PATTERNS:
            for m in re.finditer(pattern, text, re.IGNORECASE):
                raw = m.group(0)
                ident = m.group(group).strip("`'\"")
                if ident not in seen:
                    seen.add(ident)
                    claims.append(Claim(raw_text=raw, identifier=ident, claim_type=ctype))
        return claims

    @staticmethod
    def _evidence_set(tool_calls: List[dict]) -> Set[str]:
        """
        Collect all tokens from tool outputs that could serve as evidence.
        We extract word-tokens of length >= 4 from every tool output string.
        """
        tokens: Set[str] = set()
        for tc in tool_calls:
            output = str(tc.get("output", ""))
            for word in re.findall(r'[A-Za-z_]\w+', output):
                if len(word) >= 4:
                    tokens.add(word)
        return tokens
