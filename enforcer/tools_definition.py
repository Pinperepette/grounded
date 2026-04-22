"""
Anthropic tool schemas exposed to the model.
These are the ONLY tools the model is allowed to use.
"""

TOOLS = [
    {
        "name": "grep_search",
        "description": (
            "Search for a pattern in the codebase using ripgrep (or grep as fallback). "
            "MANDATORY: call this before making ANY factual claim about code. "
            "Returns file paths, line numbers, and matching text. "
            "Returns NOT_FOUND if the pattern does not exist."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Pattern to search for. Supports regex.",
                },
                "path": {
                    "type": "string",
                    "description": "Directory or file path to search within.",
                },
                "case_sensitive": {
                    "type": "boolean",
                    "description": "Set true for case-sensitive search. Default: false.",
                },
            },
            "required": ["pattern", "path"],
        },
    },
    {
        "name": "read_file",
        "description": (
            "Read the full contents of a specific file. "
            "Use after grep_search has identified a relevant file path. "
            "Returns ERROR if the file does not exist."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute or relative path to the file.",
                },
            },
            "required": ["path"],
        },
    },
    {
        "name": "list_files",
        "description": "List all files inside a directory matching an optional glob pattern.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory to list.",
                },
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern, e.g. '*.py'. Default: '*'.",
                },
            },
            "required": ["path"],
        },
    },
]
