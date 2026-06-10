import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isEnoent } from "../../fs-errors";
import { isaSkillUnder, type SubstrateInstallSpec } from "../../install-spec";
import {
  configureGrokAgentsPointer,
  configureGrokConfigPatch,
  removeAgentsImportBlock,
  removeConfigPatchBlock,
} from "./config-patch";

const GROK_DEFAULT_HOME = ".grok";

/**
 * Static home-file list for the Grok projection, relative to `~/.grok`.
 * Must stay in sync with the static file paths emitted by
 * `projectGrokHome` plus the two post-projection patch targets
 * (`AGENTS.md`, `config.toml`) — the grok-install test asserts the
 * union. Dynamic entries (the active-ISA file, portable skill files)
 * are NOT listed here, mirroring `CODEX_HOME_FILES`.
 */
export const GROK_HOME_FILES = [
  "skills/soma/SKILL.md",
  "skills/soma/context.md",
  "skills/soma/memory-layout.md",
  "skills/soma/skills.md",
  "skills/soma/policy.md",
  "skills/the-algorithm/SKILL.md",
  "AGENTS.md",
  "config.toml",
] as const;

/**
 * Skill directories the static projection owns under `~/.grok/skills/`,
 * derived from `GROK_HOME_FILES` so uninstall (and the doctor's
 * discovery checks) can never drift from what install writes.
 */
export const GROK_PROJECTED_SKILL_NAMES = GROK_HOME_FILES
  .map((file) => /^skills\/([^/]+)\/SKILL\.md$/.exec(file)?.[1])
  .filter((name): name is string => name !== undefined);

/**
 * Soma-ownership markers for the removable directories (U6): uninstall
 * deletes a directory only when its identifying file carries the marker
 * the Soma renderer writes, so a user directory that merely shares the
 * name survives. Marker sources: `renderGrokHomeSkill` (soma),
 * `renderAlgorithmRenderingContract` (the-algorithm), the versioned ISA
 * skill body (ISA), and `renderGrokRulesReadme` (the workspace rules
 * overlay).
 */
const GROK_SKILL_DIR_MARKERS: Record<string, { file: string; marker: string }> = {
  "soma": { file: "SKILL.md", marker: "This projection is generated from Soma." },
  "the-algorithm": { file: "SKILL.md", marker: "Soma Algorithm rendering contract" },
  "ISA": { file: "SKILL.md", marker: "Ideal State Artifact" },
  // The project-scoped rules overlay (written by workspace bundles, never
  // by the home projection) — removed so `soma uninstall grok --workspace`
  // round-trips, harmless at home scope where the dir does not exist.
  "rules-soma": { file: "README.md", marker: "# Soma Grok Projection" },
};

async function shouldRemoveGrokDir(target: string): Promise<boolean> {
  const key = basename(dirname(target)) === "rules" ? "rules-soma" : basename(target);
  const guard = GROK_SKILL_DIR_MARKERS[key];
  if (!guard) return false;
  try {
    return (await readFile(join(target, guard.file), "utf8")).includes(guard.marker);
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export const grokInstallSpec: SubstrateInstallSpec<"grok"> = {
  substrate: "grok",
  defaultHome: GROK_DEFAULT_HOME,
  homeFiles: GROK_HOME_FILES,
  isaSkillProjection: {
    // Lands the versioned ISA skill at `~/.grok/skills/ISA` (same shape
    // as Codex's `isaSkillUnder()` → `~/.codex/skills/ISA`).
    destinationDir: isaSkillUnder(),
  },
  postProjection: [
    {
      // Marker-guarded pointer block in the user-owned ~/.grok/AGENTS.md
      // (verified auto-loaded home surface — KTD-4a).
      name: "grok-agents-pointer",
      run: async ({ substrateHome, somaHome }) => [await configureGrokAgentsPointer(substrateHome, somaHome)],
    },
    {
      // Marker-guarded block in the user-owned ~/.grok/config.toml.
      name: "grok-config",
      run: async ({ substrateHome, somaHome }) => [await configureGrokConfigPatch(substrateHome, somaHome)],
    },
  ],
  uninstall: {
    // U6 (R10, KTD-5): real marker-guarded round-trip — remove the
    // Soma-owned directories, unpatch only the Soma blocks from the
    // user-owned AGENTS.md/config.toml, preserve every foreign byte.
    // Portable skills imported from the Soma home project under dynamic
    // `skills/<name>/` paths and are NOT removed (no install manifest to
    // identify them safely — same boundary as claude-code).
    kind: "implemented",
    remove: [
      ...GROK_PROJECTED_SKILL_NAMES.map((name) => `skills/${name}`),
      "skills/ISA",
      "rules/soma",
    ],
    shouldRemove: (target) => shouldRemoveGrokDir(target),
    postRemove: async ({ substrateHome }) => {
      const removed: string[] = [];
      for (const unpatch of [removeAgentsImportBlock, removeConfigPatchBlock]) {
        const path = await unpatch(substrateHome);
        if (path !== null) removed.push(path);
      }
      return removed;
    },
  },
};
