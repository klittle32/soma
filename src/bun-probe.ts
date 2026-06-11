/**
 * Bun discovery + pre-flight (soma#73 sage r1; hardened per
 * soma-notes 2026-06-11-006).
 *
 * Two callers in the install/adapter surfaces need the same logic:
 *   - `requireBunInPath` — installer pre-flight; throws + remediation
 *     when no spawnable bun can be resolved
 *   - `resolveBunExecutable` — substrate adapters (grok, codex,
 *     claude-code); returns the validated bun binary path frozen into
 *     hook commands and runtime configs
 *
 * 2026-06-11 hardening (plan 006, R1-R4): the previous resolver
 * trusted `SOMA_BUN_PATH` blindly and probed PATH via `which` — which
 * does not exist on native Windows and, under Git Bash/MSYS, answers
 * in a path dialect (`/c/Users/...`, no `.exe`) that no native
 * Windows spawn can resolve. On Grok's fail-open hook platform a
 * frozen unspawnable path is not an error: the hook never launches
 * and the policy gate silently disables (2026-06-10 incident). The
 * resolver is now incapable of returning a value it has not proven
 * spawnable: every winning candidate — including the env override —
 * is MSYS-normalized, checked on disk, and spawn-probed
 * (`<path> --version`) before it is handed to any freeze site.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Where a candidate bun path came from — named in validation errors. */
export type BunPathSource = "SOMA_BUN_PATH" | "process.execPath" | "where bun" | "which bun";

/**
 * Filesystem/spawn seam (KTD-9 `runInspect` pattern): production uses
 * the real default; tests inject a fixture probe to drive every
 * platform/normalization/validation branch hermetically. Never passed
 * by production callers.
 */
export interface BunPathProbe {
  exists(candidate: string): boolean;
  /** Run `<candidate> --version` (5s timeout). `ok` iff exit 0. */
  spawnVersion(candidate: string): { ok: boolean; detail: string };
  /** First PATH hit from `which bun` / `where bun`, or null. */
  locate(tool: "which" | "where"): string | null;
}

export interface ResolveBunPathInput {
  env?: Record<string, string | undefined>;
  platform?: string;
  execPath?: string;
  runningUnderBun?: boolean;
  probe?: BunPathProbe;
}

const SPAWN_PROBE_TIMEOUT_MS = 5_000;

const defaultProbe: BunPathProbe = {
  exists: (candidate) => existsSync(candidate),
  spawnVersion: (candidate) => {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      timeout: SPAWN_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error) return { ok: false, detail: String(result.error) };
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").trim();
      return { ok: false, detail: `exit ${result.status}${stderr ? `: ${stderr}` : ""}` };
    }
    return { ok: true, detail: (result.stdout ?? "").trim() };
  },
  locate: (tool) => {
    const result = spawnSync(tool, ["bun"], { encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) return null;
    // `where` lists every PATH hit (shims before the real exe is
    // common under scoop) — take the first; validation makes a wrong
    // pick loud instead of latent.
    const first = (result.stdout ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
    return first.length > 0 ? first : null;
  },
};

/**
 * MSYS/Git Bash answers paths in a dialect native Windows spawns
 * cannot resolve: `/c/Users/.../bun` (forward slashes, drive as a
 * root directory, no `.exe`). Normalize to `C:\Users\...\bun.exe`
 * BEFORE validation so a Git Bash-driven install succeeds with a
 * correct value rather than freezing a poisoned one (R2).
 */
function normalizeWin32Candidate(raw: string, probe: BunPathProbe): string {
  let candidate = raw.trim();
  const msys = /^\/(?:cygdrive\/)?([A-Za-z])\/(.*)$/.exec(candidate);
  if (msys) candidate = `${msys[1].toUpperCase()}:\\${msys[2].replace(/\//g, "\\")}`;
  if (!candidate.toLowerCase().endsWith(".exe") && !probe.exists(candidate) && probe.exists(`${candidate}.exe`)) {
    candidate = `${candidate}.exe`;
  }
  return candidate;
}

function validationError(input: { raw: string; candidate: string; source: BunPathSource; failure: string }): Error {
  const rawNote = input.raw === input.candidate ? "" : ` (raw value "${input.raw}")`;
  return new Error(
    [
      "soma#73: refusing to freeze an unspawnable Bun path.",
      "",
      `  candidate: ${input.candidate}${rawNote}`,
      `  source:    ${input.source}`,
      `  failure:   ${input.failure}`,
      "",
      "This value would be frozen into substrate hook commands; on Grok's fail-open",
      "hook platform an unlaunchable hook silently disables Soma's policy gate.",
      "Set SOMA_BUN_PATH to the absolute native path of the bun binary",
      "(Windows: C:\\...\\bun.exe) or ensure `bun` resolves on PATH, then re-run.",
    ].join("\n"),
  );
}

function bunNotFoundError(platform: string): Error {
  const probeName = platform === "win32" ? "`where bun`" : "`which bun`";
  return new Error(
    [
      "soma#73: Bun not found.",
      "",
      `No SOMA_BUN_PATH override, not running under Bun, and ${probeName} found nothing.`,
      "Every substrate hook installed by soma runs under Bun.",
      "Install Bun (https://bun.sh) and re-run, or set SOMA_BUN_PATH to an absolute path.",
    ].join("\n"),
  );
}

/**
 * Resolve and VALIDATE the bun binary path frozen into substrate
 * configs (plan 006, R1-R3). Resolution order:
 *   - win32: SOMA_BUN_PATH -> process.execPath when running under bun
 *     (always a spawn-valid native path, immune to the MSYS dialect
 *     by construction) -> `where bun` first hit. `which` is never
 *     invoked on win32.
 *   - POSIX (unchanged order): SOMA_BUN_PATH -> `which bun` ->
 *     process.execPath when running under bun.
 *
 * The first PRESENT candidate is normalized (win32 MSYS form) and
 * must pass existsSync + a `--version` spawn probe; failure throws an
 * install-blocking error naming the candidate and its source — there
 * is no silent fallthrough past a present-but-broken value, because
 * that is exactly how a wrong path goes latent. No candidate present
 * at all throws the install-bun remediation.
 */
export function resolveValidatedBunPath(input: ResolveBunPathInput = {}): string {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const probe = input.probe ?? defaultProbe;
  const execPath = input.execPath ?? process.execPath;
  const runningUnderBun =
    input.runningUnderBun ?? Boolean((process.versions as Record<string, string | undefined>).bun);

  const fromEnv = (): string | null => {
    const value = env.SOMA_BUN_PATH;
    return value && value.trim().length > 0 ? value : null;
  };
  const fromExecPath = (): string | null => (runningUnderBun && execPath ? execPath : null);
  const fromLocate = (tool: "which" | "where") => (): string | null => probe.locate(tool);

  const producers: Array<{ source: BunPathSource; get: () => string | null }> =
    platform === "win32"
      ? [
          { source: "SOMA_BUN_PATH", get: fromEnv },
          { source: "process.execPath", get: fromExecPath },
          { source: "where bun", get: fromLocate("where") },
        ]
      : [
          { source: "SOMA_BUN_PATH", get: fromEnv },
          { source: "which bun", get: fromLocate("which") },
          { source: "process.execPath", get: fromExecPath },
        ];

  for (const producer of producers) {
    const raw = producer.get();
    if (raw === null) continue;
    const candidate = platform === "win32" ? normalizeWin32Candidate(raw, probe) : raw.trim();
    if (!probe.exists(candidate)) {
      throw validationError({ raw, candidate, source: producer.source, failure: "not found on disk (existsSync)" });
    }
    const version = probe.spawnVersion(candidate);
    if (!version.ok) {
      throw validationError({
        raw,
        candidate,
        source: producer.source,
        failure: `spawn probe \`${candidate} --version\` failed: ${version.detail}`,
      });
    }
    return candidate;
  }

  throw bunNotFoundError(platform);
}

// One spawn probe per process per SOMA_BUN_PATH value: the resolver
// is called from several freeze sites per install and from test
// batteries thousands of times; re-probing an already-validated path
// only adds Windows spawn pressure (the AC-2 panic class). Failures
// are never cached.
const validatedByEnvOverride = new Map<string, string>();

/**
 * Resolve the validated bun binary path for embedding in substrate
 * hook commands and runtime configs. Memoized per process (keyed on
 * the SOMA_BUN_PATH override value). Throws when no spawnable bun
 * resolves — adopters get the same error from `requireBunInPath`.
 */
export function resolveBunExecutable(): string {
  const key = process.env.SOMA_BUN_PATH ?? "";
  const cached = validatedByEnvOverride.get(key);
  if (cached !== undefined) return cached;
  const resolved = resolveValidatedBunPath();
  validatedByEnvOverride.set(key, resolved);
  return resolved;
}

/**
 * Installer pre-flight. Throws with remediation when no VALIDATED bun
 * resolves; returns silently when one does. A set-but-broken
 * `SOMA_BUN_PATH` now fails here (it used to be trusted blindly —
 * an MSYS-dialect override reproduces the exact fail-open incident
 * the override exists to prevent).
 */
export function requireBunInPath(): void {
  resolveBunExecutable();
}
