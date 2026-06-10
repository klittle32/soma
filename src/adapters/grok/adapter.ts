import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { SomaAdapter, Projection, ProjectionInput, SomaTask } from "../../types";
import { activeIsaBundleFile } from "../../adapter-active-isa";
import { renderAssistantCore, renderMemoryLayout, renderPolicyProjection, renderSkills } from "../shared";

/**
 * Resolve the user-level Grok home (`~/.grok`). `detect()` probes this
 * directory's existence: unlike Codex (`CODEX_HOME`) or Cursor
 * (`CURSOR_TRACE_ID`), Grok exposes no reliable marker env var, so the
 * installed `~/.grok/` tree is the signal. The `homeDir` override keeps
 * `detect()` testable against a temporary home.
 */
export function grokHomeDir(homeDir?: string): string {
  return resolve(homeDir ?? homedir(), ".grok");
}

function renderInstructions(input: ProjectionInput): string {
  return [
    "# Soma Grok Context",
    "",
    "You are running inside the Grok CLI with Soma-projected assistant context.",
    "Treat Soma as the source of truth for personal assistant identity, telos, memory layout, skills, policy, and active ISA context.",
    "Treat Grok as the execution substrate. Keep substrate-specific behavior behind adapter boundaries.",
    "",
    renderAssistantCore(input),
    "",
    "## Operating Rules",
    "- Use the active ISA as the verification contract when present.",
    "- Read memory from the declared file layout before inventing persistent facts.",
    "- Keep personal context out of public templates unless explicitly requested.",
    "- Report verification performed and any substrate limitation encountered.",
  ].join("\n");
}

function renderGrokPolicy(): string {
  return renderPolicyProjection(
    "grok",
    ["Filesystem and tool-call policy when Grok hooks enforce it"],
    [
      "Assistant behavior instructions",
      "Verification reporting",
      "Private context handling",
    ],
  );
}

/**
 * Workspace projection (`soma install grok --workspace`). Mirrors the
 * Codex `.codex/soma/` workspace layout under `.grok/soma/`. The richer
 * home-discovery surface (`~/.grok/skills/soma/SKILL.md` + AGENTS.md
 * block) lands in U4; this skeleton emits the portable context files
 * the parity contract requires.
 */
export function projectGrok(input: ProjectionInput): Projection {
  const instructions = renderInstructions(input);

  return {
    substrate: "grok",
    instructions,
    files: [
      { path: ".grok/soma/context.md", content: instructions },
      { path: ".grok/soma/memory-layout.md", content: renderMemoryLayout(input) },
      { path: ".grok/soma/skills.md", content: renderSkills(input) },
      { path: ".grok/soma/policy.md", content: renderGrokPolicy() },
    ],
  };
}

/**
 * Home projection (`soma install grok`). Files are relative to the Grok
 * home (`~/.grok`) and land under the `skills/soma/` discovery surface.
 * Kept intentionally minimal for U2; U4 expands this into the verified
 * `skills/soma/SKILL.md` + `~/.grok/AGENTS.md` pointer contract.
 */
export function projectGrokHome(input: ProjectionInput): Projection {
  const instructions = renderInstructions(input);

  return {
    substrate: "grok",
    instructions,
    files: [
      { path: "skills/soma/context.md", content: instructions },
      { path: "skills/soma/memory-layout.md", content: renderMemoryLayout(input) },
      { path: "skills/soma/skills.md", content: renderSkills(input) },
      { path: "skills/soma/policy.md", content: renderGrokPolicy() },
      // Active-ISA projection (#37). OMITTED when no active ISA — AC-2.
      ...activeIsaBundleFile("grok", input.activeIsa),
    ],
  };
}

export const grokAdapter: SomaAdapter = {
  name: "grok",
  detect() {
    return Promise.resolve(existsSync(grokHomeDir()));
  },
  project(input) {
    return Promise.resolve(projectGrok(input));
  },
  run(task: SomaTask) {
    return Promise.resolve({
      taskId: task.id,
      substrate: "grok",
      status: "failed",
      summary: "Grok execution is not implemented yet; use project() to generate the substrate bundle.",
    });
  },
};
