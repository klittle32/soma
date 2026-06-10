import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isEnoent, pathExists } from "../../fs-utils";
import type { SomaDoctorFinding } from "../../types";
import { GROK_AGENTS_BLOCK_BEGIN } from "./config-patch";
import { GROK_HOME_FILES } from "./install";

const execFileAsync = promisify(execFile);

/**
 * Grok doctor (KTD-6): instead of the mtime heuristic the codex doctor
 * uses, ask Grok's own discovery oracle — `grok inspect --json` — whether
 * the Soma projection is actually loaded: the projected skills appear in
 * `skills[]`, the patched `~/.grok/AGENTS.md` appears in
 * `projectInstructions[]` (and still carries the Soma pointer block), and
 * the Soma lifecycle hook appears in `hooks[]`. Tests inject fixture JSON
 * via `runInspect`; nothing here requires a live `grok` binary.
 */

// The skills the projection installs under `~/.grok/skills/`, derived from
// the install spec's static file list so the doctor can never drift from
// what install actually writes.
const REQUIRED_SKILL_NAMES = GROK_HOME_FILES
  .map((file) => /^skills\/([^/]+)\/SKILL\.md$/.exec(file)?.[1])
  .filter((name): name is string => name !== undefined);

// The Soma lifecycle hook (U7) ships as `~/.grok/hooks/soma-lifecycle.json`
// whose commands invoke `soma-lifecycle.mjs`, so this substring in a hook
// entry's target is the "Soma hook is registered" signal.
export const SOMA_GROK_HOOK_TARGET_MARKER = "soma-lifecycle";

const GROK_INSPECT_TIMEOUT_MS = 30_000;
const GROK_INSPECT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Returns `grok inspect --json` stdout, or null when no Grok binary is
 * installed. May throw when the binary exists but the probe fails.
 */
export type GrokInspectRunner = (homeDir: string) => Promise<string | null>;

async function runGrokInspectBinary(homeDir: string): Promise<string | null> {
  const binary = join(homeDir, ".grok/bin", process.platform === "win32" ? "grok.exe" : "grok");
  if (!(await pathExists(binary))) return null;
  const { stdout } = await execFileAsync(binary, ["inspect", "--json"], {
    cwd: homeDir,
    encoding: "utf8",
    timeout: GROK_INSPECT_TIMEOUT_MS,
    maxBuffer: GROK_INSPECT_MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

interface GrokInspectReport {
  projectInstructions: { path: string; scope: string }[];
  skills: { name: string; sourcePath: string }[];
  hooks: { target: string }[];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

function parseInspectReport(raw: string): GrokInspectReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  return {
    projectInstructions: asRecords(record.projectInstructions).map((entry) => ({
      path: asString(entry.path),
      scope: asString(entry.scope),
    })),
    skills: asRecords(record.skills).map((entry) => {
      const source = typeof entry.source === "object" && entry.source !== null
        ? (entry.source as Record<string, unknown>)
        : {};
      return { name: asString(entry.name), sourcePath: asString(source.path) };
    }),
    hooks: asRecords(record.hooks).map((entry) => ({ target: asString(entry.target) })),
  };
}

/**
 * Grok reports discovered paths in OS form — on Windows often with the
 * extended-length `\\?\` prefix and filesystem casing (`Agents.md`).
 * Normalize both sides before comparing: strip the prefix, forward-slash
 * the separators, lowercase.
 */
function normalizeInspectPath(value: string): string {
  return value.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLowerCase();
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function diagnoseGrokProjectionDrift(options: {
  homeDir: string;
  runInspect?: GrokInspectRunner;
}): Promise<SomaDoctorFinding[]> {
  const runInspect = options.runInspect ?? runGrokInspectBinary;

  let raw: string | null;
  try {
    raw = await runInspect(options.homeDir);
  } catch (error) {
    return [{
      id: "grok-inspect-unavailable",
      severity: "warning",
      message: `\`grok inspect --json\` failed: ${error instanceof Error ? error.message : String(error)}`,
      action: "Run `grok inspect --json` manually and repair the Grok install, then re-run soma doctor --substrate grok",
    }];
  }
  if (raw === null) {
    return [{
      id: "grok-inspect-unavailable",
      severity: "info",
      message: "Grok binary not found — skipped `grok inspect` discovery checks.",
      action: "Install the Grok CLI, then re-run soma doctor --substrate grok",
    }];
  }

  const report = parseInspectReport(raw);
  if (report === null) {
    return [{
      id: "grok-inspect-unavailable",
      severity: "warning",
      message: "`grok inspect --json` returned unparseable output.",
      action: "Run `grok inspect --json` manually and repair the Grok install, then re-run soma doctor --substrate grok",
    }];
  }

  const findings: SomaDoctorFinding[] = [];
  const problems: string[] = [];

  const skillsRoot = `${normalizeInspectPath(join(options.homeDir, ".grok/skills"))}/`;
  const discoveredSkills = new Set(
    report.skills
      .filter((skill) => normalizeInspectPath(skill.sourcePath).startsWith(skillsRoot))
      .map((skill) => skill.name.toLowerCase()),
  );
  const missingSkills = REQUIRED_SKILL_NAMES.filter((name) => !discoveredSkills.has(name.toLowerCase()));
  if (missingSkills.length > 0) {
    problems.push(`Grok does not discover the projected skill(s): ${missingSkills.join(", ")}.`);
  }

  const agentsPath = join(options.homeDir, ".grok/AGENTS.md");
  const normalizedAgentsPath = normalizeInspectPath(agentsPath);
  const agentsDiscovered = report.projectInstructions.some(
    (entry) => entry.scope === "global" && normalizeInspectPath(entry.path) === normalizedAgentsPath,
  );
  if (!agentsDiscovered) {
    problems.push("Grok does not list ~/.grok/AGENTS.md among its discovered instructions.");
  }

  const agentsContent = await readFileOrNull(agentsPath);
  if (!agentsContent?.includes(GROK_AGENTS_BLOCK_BEGIN)) {
    problems.push("~/.grok/AGENTS.md is missing the Soma pointer block.");
  }

  if (problems.length > 0) {
    findings.push({
      id: "grok-projection-stale",
      severity: "warning",
      message: problems.join(" "),
      action: "soma reproject grok",
    });
  }

  const hookRegistered = report.hooks.some((hook) => hook.target.includes(SOMA_GROK_HOOK_TARGET_MARKER));
  if (!hookRegistered) {
    findings.push({
      id: "grok-hook-missing",
      severity: "warning",
      message: "Grok does not register the Soma lifecycle hook.",
      action: "soma install grok --apply",
    });
  }

  return findings;
}
