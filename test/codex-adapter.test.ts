import { expect, test } from "bun:test";
import { buildCodexContext, codexAdapter, type SomaContextInput } from "../src/index";

const input: SomaContextInput = {
  profile: {
    assistant: {
      name: "soma",
      displayName: "Soma",
      traits: {
        concise: true,
      },
    },
    principal: {
      name: "principal",
      preferredName: "JC",
      profile: {
        timezone: "Europe/Zurich",
      },
    },
    telos: {
      mission: "Keep personal assistant context portable across substrates.",
      goals: ["Prove Codex context generation"],
      principles: ["Substrate adapters translate; they do not own core concepts"],
      commitments: ["Keep memory filesystem-native"],
    },
    memory: {
      root: "MEMORY",
      work: "MEMORY/WORK",
      knowledge: "MEMORY/KNOWLEDGE",
      learning: "MEMORY/LEARNING",
      relationship: "MEMORY/RELATIONSHIP",
      state: "MEMORY/STATE",
    },
    skills: [
      {
        name: "Ledger Update",
        path: "skills/ledger-update",
        description: "Update a project ledger from verified work.",
        triggers: ["ledger", "status update"],
      },
    ],
  },
  activeIsa: {
    slug: "portable-context",
    phase: "build",
    goal: "Build the first Codex context projection.",
    criteria: [
      {
        id: "ISC-CODEX-1",
        text: "Codex receives assistant identity, telos, memory, skills, and ISA.",
        status: "open",
        verification: "bun test",
      },
    ],
  },
};

test("codex adapter builds a portable context bundle", () => {
  const bundle = buildCodexContext(input);

  expect(bundle.substrate).toBe("codex");
  expect(bundle.instructions).toContain("Soma Codex Context");
  expect(bundle.instructions).toContain("Keep personal assistant context portable across substrates.");
  expect(bundle.instructions).toContain("ISC-CODEX-1");
  expect(bundle.files.map((file) => file.path)).toEqual([
    ".codex/soma/context.md",
    ".codex/soma/memory-layout.md",
    ".codex/soma/skills.md",
  ]);
});

test("codex adapter exposes context build before execution", async () => {
  await expect(codexAdapter.buildContext(input)).resolves.toMatchObject({
    substrate: "codex",
  });

  await expect(codexAdapter.run({ id: "task-1", substrate: "codex", prompt: "run" })).resolves.toMatchObject({
    status: "failed",
    summary: expect.stringContaining("not implemented"),
  });
});
