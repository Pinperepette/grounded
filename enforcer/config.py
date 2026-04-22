from dataclasses import dataclass, field


@dataclass
class Config:
    model: str = "claude-sonnet-4-6"
    max_tokens: int = 4096
    max_retries: int = 3
    search_timeout: int = 30
    # Minimum number of tool calls required per attempt before a response is accepted
    min_tool_calls: int = 1
    log_file: str = "enforcer_log.jsonl"
    # Max matches returned from a single search (prevents context flooding)
    max_matches_per_search: int = 50
    # Max file read size in characters before truncation
    max_file_read_chars: int = 12000
