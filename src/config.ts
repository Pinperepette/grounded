import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { findProjectRoot } from "./utils.js";

export type EnforcementMode = "safe" | "strict" | "autonomous" | "silent";

export interface GroundedConfig {
  /**
   * Global enforcement mode — overrides per-session dynamic thresholds.
   * safe:       default behavior, adaptive via scoring engine
   * strict:     scope warnings become blocks, freshness always blocks
   * autonomous: loop threshold = 1, all checks hard-block, no previews
   * silent:     zero context injection, only hard blocks — production use
   */
  mode: EnforcementMode;
  hooks: {
    promptInject:    boolean;
    preFlight:       boolean;
    editGuard:       boolean;
    readTracker:     boolean;
    loopDetector:    boolean;
    scopeGuard:      boolean;
    freshnessCheck:  boolean;
    confidenceCheck: boolean;
    truthLayer:      boolean;
  };
  loopDetector: {
    threshold:  number;
    windowSize: number;
  };
  freshnessCheck: {
    maxAgeMs: number;
  };
  editGuard: {
    requireReadBeforeEdit: boolean;  // gate 1: block edits on unread files
  };
  scopeGuard: {
    mode:               "warn" | "block";
    extraAllowedRoots:  string[];
    blockedPaths:       string[];
  };
  policies: {
    noEdit:           string[];  // path substrings/globs — always blocked from editing
    requireTestRead:  boolean;   // must read a test file before editing impl files
  };
}

const DEFAULTS: GroundedConfig = {
  mode: "safe",
  hooks: {
    promptInject:    true,
    preFlight:       true,
    editGuard:       true,
    readTracker:     true,
    loopDetector:    true,
    scopeGuard:      true,
    freshnessCheck:  true,
    confidenceCheck: true,
    truthLayer:      true,
  },
  loopDetector: {
    threshold:  3,
    windowSize: 10,
  },
  freshnessCheck: {
    maxAgeMs: 5 * 60 * 1000,
  },
  editGuard: {
    requireReadBeforeEdit: false,
  },
  scopeGuard: {
    mode:              "warn",
    extraAllowedRoots: [],
    blockedPaths:      ["/etc", "/usr", "/bin", "/sbin", "/System", "/Windows"],
  },
  policies: {
    noEdit:          [],
    requireTestRead: false,
  },
};

function deepMerge<T>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const v = override[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      result[key] = deepMerge(base[key] as object, v as object) as T[keyof T];
    } else if (v !== undefined) {
      result[key] = v as T[keyof T];
    }
  }
  return result;
}

export function isSilent(cfg?: GroundedConfig): boolean {
  return (cfg ?? loadConfig()).mode === "silent";
}

export function loadConfig(): GroundedConfig {
  const root = findProjectRoot();
  const candidates = [
    root ? join(root, ".grounded.json") : null,
    join(process.env.HOME ?? "/tmp", ".grounded.json"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const override = JSON.parse(readFileSync(p, "utf-8"));
        return deepMerge(DEFAULTS, override);
      } catch {
        // malformed config → fall through to defaults
      }
    }
  }
  return DEFAULTS;
}
