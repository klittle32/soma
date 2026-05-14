import type { SomaAdapter, SomaContextBundle, SomaContextInput, SomaTask } from "../types";

function formatList(items: string[]): string {
  return items.length === 0 ? "- None declared" : items.map((item) => `- ${item}`).join("\n");
}

function formatRecord(record: Record<string, unknown> | undefined): string {
  if (!record || Object.keys(record).length === 0) {
    return "- None declared";
  }

  return Object.entries(record)
    .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
    .join("\n");
}

function renderActiveIsa(input: SomaContextInput): string {
  if (!input.activeIsa) {
    return "No active ISA was provided.";
  }

  const criteria = input.activeIsa.criteria
    .map((criterion) => {
      const verification = criterion.verification ? ` Verification: ${criterion.verification}` : "";
      return `- [${criterion.status}] ${criterion.id}: ${criterion.text}${verification}`;
    })
    .join("\n");

  return [
    `Slug: ${input.activeIsa.slug}`,
    `Phase: ${input.activeIsa.phase}`,
    `Goal: ${input.activeIsa.goal}`,
    "",
    "Criteria:",
    criteria || "- None declared",
  ].join("\n");
}

function renderInstructions(input: SomaContextInput): string {
  const { profile } = input;

  return [
    "# Soma Codex Context",
    "",
    "You are running inside Codex with Soma-projected assistant context.",
    "Treat Soma as the source of truth for personal assistant identity, telos, memory layout, skills, policy, and active ISA context.",
    "Treat Codex as the execution substrate. Keep substrate-specific behavior behind adapter boundaries.",
    "",
    "## Assistant",
    `Name: ${profile.assistant.name}`,
    profile.assistant.displayName ? `Display name: ${profile.assistant.displayName}` : undefined,
    "",
    "Traits:",
    formatRecord(profile.assistant.traits),
    "",
    "## Principal",
    `Name: ${profile.principal.name}`,
    profile.principal.preferredName ? `Preferred name: ${profile.principal.preferredName}` : undefined,
    "",
    "Profile:",
    formatRecord(profile.principal.profile),
    "",
    "## Telos",
    profile.telos.mission ? `Mission: ${profile.telos.mission}` : "Mission: None declared",
    "",
    "Goals:",
    formatList(profile.telos.goals),
    "",
    "Principles:",
    formatList(profile.telos.principles),
    "",
    "Commitments:",
    formatList(profile.telos.commitments),
    "",
    "## Active ISA",
    renderActiveIsa(input),
    "",
    "## Operating Rules",
    "- Use the active ISA as the verification contract when present.",
    "- Read memory from the declared file layout before inventing persistent facts.",
    "- Keep personal context out of public templates unless explicitly requested.",
    "- Report verification performed and any substrate limitation encountered.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderMemoryLayout(input: SomaContextInput): string {
  const { memory } = input.profile;

  return [
    "# Soma Memory Layout",
    "",
    `Root: ${memory.root}`,
    `Work: ${memory.work}`,
    `Knowledge: ${memory.knowledge}`,
    `Learning: ${memory.learning}`,
    `Relationship: ${memory.relationship}`,
    `State: ${memory.state}`,
  ].join("\n");
}

function renderSkills(input: SomaContextInput): string {
  const skills = input.profile.skills.map((skill) =>
    [`## ${skill.name}`, "", skill.description, "", `Path: ${skill.path}`, "", "Triggers:", formatList(skill.triggers)].join("\n"),
  );

  return ["# Soma Skills", "", skills.length === 0 ? "No Soma skills were declared." : skills.join("\n\n")].join("\n");
}

export function buildCodexContext(input: SomaContextInput): SomaContextBundle {
  const instructions = renderInstructions(input);

  return {
    substrate: "codex",
    instructions,
    files: [
      {
        path: ".codex/soma/context.md",
        content: instructions,
      },
      {
        path: ".codex/soma/memory-layout.md",
        content: renderMemoryLayout(input),
      },
      {
        path: ".codex/soma/skills.md",
        content: renderSkills(input),
      },
    ],
  };
}

export const codexAdapter: SomaAdapter = {
  name: "codex",
  async detect() {
    return Boolean(process.env.CODEX_SANDBOX || process.env.CODEX_HOME);
  },
  async buildContext(input) {
    return buildCodexContext(input);
  },
  async run(task: SomaTask) {
    return {
      taskId: task.id,
      substrate: "codex",
      status: "failed",
      summary: "Codex execution is not implemented yet; use buildContext() to generate the substrate bundle.",
    };
  },
};
