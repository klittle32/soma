import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isEnoent } from "../../fs-errors";

/**
 * Marker-guarded patches for the two user-owned files in the Grok home:
 * `~/.grok/AGENTS.md` (verified auto-loaded — KTD-4a) and
 * `~/.grok/config.toml`. Soma owns only the bytes between its markers;
 * everything outside them is foreign content that install must preserve
 * and uninstall (U6) must leave untouched. AGENTS.md markers are HTML
 * comments (invisible to the model); config.toml markers are TOML
 * comments.
 */
export const GROK_AGENTS_BLOCK_BEGIN = "<!-- soma:grok:agents:begin -->";
export const GROK_AGENTS_BLOCK_END = "<!-- soma:grok:agents:end -->";
export const GROK_CONFIG_BLOCK_BEGIN = "# soma:grok:config:begin";
export const GROK_CONFIG_BLOCK_END = "# soma:grok:config:end";

function renderAgentsPointerBlock(somaHome: string): string {
  // Concise by design: the bulk of the projected context lives in the
  // auto-loaded `soma` skill; AGENTS.md only points at it (KTD-4a).
  return [
    GROK_AGENTS_BLOCK_BEGIN,
    "## Soma",
    "",
    "Soma projects portable personal assistant context into this Grok home.",
    "",
    "- Primary context: the `soma` skill (`skills/soma/SKILL.md`); read it before acting as the personal assistant.",
    "- Algorithm mode: the `the-algorithm` skill.",
    `- Source of truth: ${somaHome} — this projection is generated; author changes there and rerun \`soma install grok --apply\`.`,
    GROK_AGENTS_BLOCK_END,
  ].join("\n");
}

function renderConfigPatchBlock(somaHome: string): string {
  // Comment-only at this stage: U4 claims no Grok config behavior. The
  // block exists so install/uninstall own a marked region from day one;
  // lifecycle-hook and policy settings land inside it in later units
  // (U7/U9) without changing the patch/unpatch contract.
  return [
    GROK_CONFIG_BLOCK_BEGIN,
    "# Soma projection marker. Soma-owned Grok settings are added here by",
    "# later Soma versions; uninstall removes only this marked block.",
    `# Source of truth: ${somaHome}`,
    GROK_CONFIG_BLOCK_END,
  ].join("\n");
}

/**
 * Replace the existing marker block in place (preserving every byte
 * outside it) or append the block once. Re-running with the same inputs
 * is byte-stable. A begin marker without its end marker is treated as
 * foreign content and left alone (a fresh block is appended).
 */
function upsertMarkerBlock(existing: string, block: string, begin: string, end: string): string {
  const start = existing.indexOf(begin);
  if (start !== -1) {
    const endIndex = existing.indexOf(end, start);
    if (endIndex !== -1) {
      return `${existing.slice(0, start)}${block}${existing.slice(endIndex + end.length)}`;
    }
  }
  if (existing.trim().length === 0) return `${block}\n`;
  return `${existing.trimEnd()}\n\n${block}\n`;
}

async function patchFileWithMarkerBlock(path: string, block: string, begin: string, end: string): Promise<string> {
  const existing = await readFile(path, "utf8").catch((error: unknown) => {
    if (isEnoent(error)) return "";
    throw error;
  });

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, upsertMarkerBlock(existing, block, begin, end), "utf8");
  return path;
}

export async function configureGrokAgentsPointer(grokHome: string, somaHome: string): Promise<string> {
  return patchFileWithMarkerBlock(
    join(grokHome, "AGENTS.md"),
    renderAgentsPointerBlock(somaHome),
    GROK_AGENTS_BLOCK_BEGIN,
    GROK_AGENTS_BLOCK_END,
  );
}

export async function configureGrokConfigPatch(grokHome: string, somaHome: string): Promise<string> {
  return patchFileWithMarkerBlock(
    join(grokHome, "config.toml"),
    renderConfigPatchBlock(somaHome),
    GROK_CONFIG_BLOCK_BEGIN,
    GROK_CONFIG_BLOCK_END,
  );
}
