import { isaSkillUnder, type SubstrateInstallSpec } from "../../install-spec";
import { configureGrokAgentsPointer, configureGrokConfigPatch } from "./config-patch";

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
    kind: "reserved",
    reason:
      "Grok uninstall is not implemented yet; marker-guarded removal of ~/.grok Soma files plus AGENTS.md/config.toml unpatch lands in a follow-up (U6).",
  },
};
