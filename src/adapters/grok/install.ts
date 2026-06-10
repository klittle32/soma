import { isaSkillUnder, type SubstrateInstallSpec } from "../../install-spec";

const GROK_DEFAULT_HOME = ".grok";

/**
 * Static home-file list for the Grok projection, relative to `~/.grok`.
 * Must stay in sync with the file paths emitted by `projectGrokHome`
 * (the active-ISA file is dynamic — omitted when no ISA is active — and
 * therefore is NOT listed here, mirroring `CODEX_HOME_FILES`).
 */
export const GROK_HOME_FILES = [
  "skills/soma/context.md",
  "skills/soma/memory-layout.md",
  "skills/soma/skills.md",
  "skills/soma/policy.md",
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
  uninstall: {
    kind: "reserved",
    reason:
      "Grok uninstall is not implemented yet; marker-guarded removal of ~/.grok Soma files plus AGENTS.md/config.toml unpatch lands in a follow-up (U6).",
  },
};
