import type { NodeRuntimeHost, NodeRuntimeStatus } from '../node-runtime-preflight.js';
/**
 * Type surface for `dkg doctor` (OT-RFC-41 §4.7).
 *
 * The doctor is intentionally pure(-ish): every check is an async
 * function that takes a {@link DoctorDeps} object (file-system,
 * fetch, command runners) and returns a list of {@link Finding}s.
 * The orchestrator in `index.ts` wires real I/O in production and
 * tests inject stub deps without touching the real filesystem or
 * spawning processes.
 *
 * Exit codes (per §4.7):
 *   - 0 = all healthy (zero findings, or only `info` findings)
 *   - 1 = at least one `warning` (no `error`s)
 *   - 2 = at least one `error`
 */

/** Severity of a single finding. */
export type FindingSeverity = 'info' | 'warning' | 'error';

/** A single observation produced by a check. */
export interface Finding {
  /** Identifier of the check that produced this finding (e.g. `orphan-repos`). */
  check: string;
  /** Severity tier — determines `dkg doctor`'s exit code. */
  severity: FindingSeverity;
  /** One-line summary suitable for human display. */
  message: string;
  /**
   * Optional follow-up suggestion / next step. Rendered on a
   * separate line beneath `message` in the human view; emitted
   * verbatim in the JSON view.
   */
  advisory?: string;
  /** Optional path / URI / version / identifier the finding refers to. */
  subject?: string;
  /**
   * Optional structured payload — included verbatim in `--json` output
   * for tooling. Should be JSON-serializable (no functions / cycles).
   */
  details?: Record<string, unknown>;
}

/**
 * §4.7.0 always-reported state summary. Eighteen fields; the agent /
 * operator / support engineer gets the full disambiguation context
 * in one place rather than running five separate commands.
 *
 * Field-by-field semantics are documented in OT-RFC-41 §4.7.0. Any
 * field that cannot be determined reports `null` (or its typed
 * equivalent) — the absence of a value is itself informational and
 * may be cross-referenced by checks below.
 */
export interface StateSummary {
  /** Additive capability snapshot of the CLI/runtime that will launch a worker. */
  runtime?: NodeRuntimeStatus;
  /** ~/.dkg/daemon.pid — `null` if absent. */
  daemon: {
    pid: number | null;
    /** Resolved argv[1] of the running process. `null` if not determinable. */
    entryPoint: string | null;
    /** GET /api/status#version — `null` if daemon unreachable. */
    version: string | null;
    /** GET /api/status#commit — added per §4.9. */
    commit: string | null;
    /** GET /api/status#commitShort — added per §4.9. */
    commitShort: string | null;
    /** GET /api/status#buildTime — added per §4.9. */
    buildTime: string | null;
    /** GET /api/status#distTag — added per §4.9. */
    distTag: string | null;
    /**
     * GET /api/status#installMode — added per §4.3. Falls back to
     * local detection (see {@link detectLocalInstallMode}) if the
     * daemon is unreachable.
     */
    installMode: 'npm-global' | 'npm-local' | 'monorepo' | 'unknown' | null;
    /** ~/.dkg/config.json#nodeRole — defaults to `edge`. */
    nodeRole: 'edge' | 'core' | null;
    /** Reason the daemon is unreachable when version/commit/etc. are null. */
    unreachableReason?: string;
  };
  cli: {
    /** `which dkg` resolution. The global `dkg` binary's path. */
    globalPath: string | null;
    /** `<cli.globalPath> --version` — global CLI's reported version. */
    version: string | null;
  };
  paths: {
    /** Result of `resolveDkgConfigHome({ startDir: cwd })`. */
    dkgHome: string;
    /**
     * `process.env.DKG_HOME` — reported even if `null`; non-null
     * + non-default values warrant operator attention.
     */
    dkgHomeEnv: string | null;
    /**
     * Symlink resolution of `~/.dkg/releases/current`. `null` on
     * Edge (which has no `releases/` directory under RFC-41).
     */
    activeSlot: string | null;
    /**
     * `/usr/local/lib/node_modules/@origintrail-official/dkg/` or
     * platform-equivalent — the npm-global install root. `null` if
     * `npm root -g` resolution fails.
     */
    npmGlobalDkg: string | null;
    /** `~/.dkg/plugins/` — per §4.6.1. */
    pluginsRoot: string;
  };
  autoUpdate: {
    enabled: boolean;
    checkIntervalMinutes: number;
    allowPrerelease: boolean;
    /** `config.autoUpdate.source` — npm by default, git for advanced Core opt-in, monorepo for dev checkouts. */
    source: string | null;
    /** ~/.dkg/auto-update/last-check.json#timestamp — `null` if never checked. */
    lastCheck: string | null;
    /** ~/.dkg/auto-update/last-error.json — truncated to first 1 KB; `null` if no errors. */
    lastError: string | null;
  };
  /**
   * `~/.dkg/previous-version` (Edge) or previous slot's
   * `package.json#version` (Core). `null` if no rollback target.
   */
  previousVersion: string | null;
}

/**
 * Locally-detected install mode for the running CLI. Used as a
 * fallback when the daemon is unreachable.
 */
export type LocalInstallMode = 'npm-global' | 'npm-local' | 'monorepo' | 'unknown';

/**
 * The full report `dkg doctor` produces. Stable schema — agents
 * parse it; changes to its shape are a breaking change.
 */
export interface DoctorReport {
  state: StateSummary;
  findings: Finding[];
  /** 0 = healthy, 1 = warnings only, 2 = at least one error. */
  exitCode: 0 | 1 | 2;
  /** Doctor schema version. Bumped on breaking changes. */
  schemaVersion: 1;
}

/**
 * Dependency surface every check + the state summary uses. Wired to
 * real I/O in production; stubs are injected in tests so each check
 * can be exercised without touching the real filesystem, spawning
 * subprocesses, or hitting the daemon's HTTP port.
 */
export interface DoctorDeps {
  /** Runtime capability source; defaults to the process executing doctor. */
  runtimeHost?: NodeRuntimeHost;
  /** Platform used for static capability checks; defaults to the current process. */
  platform?: NodeJS.Platform;
  /** Resolved DKG home (`~/.dkg/` typically). */
  dkgHome: string;
  /** `process.env.DKG_HOME` at invocation time. */
  dkgHomeEnv: string | null;
  /** Process cwd at invocation time. */
  cwd: string;
  /** `os.homedir()` — the user's home directory. */
  home: string;
  /** Configured / probed API port (default 9200). */
  apiPort: number;
  /**
   * If true, the doctor was invoked from inside a monorepo checkout
   * (`findDkgMonorepoRoot(cwd) !== null`). Influences install-mode
   * detection and the install-layout check's expectations.
   */
  isMonorepo: boolean;
  /** Optional path to the monorepo root, when `isMonorepo === true`. */
  monorepoRoot: string | null;
  /** Operator-configured extra scan roots for §4.7.1 — defaults to []. */
  extraScanRoots: string[];
  /** Operator-configured doctor checks to skip — defaults to []. */
  skipChecks: string[];

  /** `existsSync`-equivalent. Stub for tests. */
  exists(path: string): boolean;
  /** `readFile` (utf-8). Returns `null` on ENOENT or any other read error. */
  readFile(path: string): Promise<string | null>;
  /** `readlink` -> the symlink's target. Returns `null` on failure. */
  readlink(path: string): Promise<string | null>;
  /** `stat`-equivalent. Returns `null` on ENOENT. */
  stat(path: string): Promise<{ mtimeMs: number; uid: number; isDirectory: boolean; isSymbolicLink: boolean } | null>;
  /**
   * `readdir`-equivalent. Returns `[]` on missing / permission-denied.
   * `withFileTypes` is implicit; entries always carry `{ name, isDirectory, isSymbolicLink }`.
   */
  readdir(path: string): Promise<Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>>;
  /**
   * Run a shell command, return `{ stdout, stderr, code }`. Used for
   * `which dkg`, `<cli> --version`, etc. Returns `null` if the command
   * cannot be launched (binary missing, etc.).
   */
  runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number } | null>;
  /**
   * `fetch` wrapper bounded by a timeout (default 2 s). Returns the
   * parsed JSON body on success; `null` on any failure (unreachable,
   * non-2xx, JSON parse error).
   */
  fetchJson(url: string): Promise<Record<string, unknown> | null>;
  /**
   * `fetch` wrapper that returns the raw text body. Used for HTML
   * served-UI inspection. `null` on any failure.
   */
  fetchText(url: string): Promise<string | null>;
}
