import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSomaForGrok, planSomaForGrokInstall, projectGrokHome, activeIsaProjectionPath } from "../src/index";
import { allInstallSpecs, installSpecFor } from "../src/install-spec-registry";
import { GROK_HOME_FILES, grokInstallSpec } from "../src/adapters/grok/install";
import {
  configureGrokAgentsPointer,
  configureGrokConfigPatch,
  GROK_AGENTS_BLOCK_BEGIN,
  GROK_AGENTS_BLOCK_END,
  GROK_CONFIG_BLOCK_BEGIN,
  GROK_CONFIG_BLOCK_END,
} from "../src/adapters/grok/config-patch";
import { writeProjection } from "../src/projection";
import { isSubstrateId, parseSubstrate } from "../src/cli/substrate";
import {
  parseExportArgs,
  parseInstallArgs,
  parseReprojectArgs,
  parseUninstallArgs,
  parseUpgradeArgs,
} from "../src/cli/substrate-lifecycle";
import { portableProjectionInput } from "./fixtures";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("grok is a registered install substrate with adapter-owned facts", () => {
  expect(allInstallSpecs().map((spec) => spec.substrate)).toContain("grok");

  const spec = installSpecFor("grok");
  expect(spec).toBe(grokInstallSpec);
  expect(spec.substrate).toBe("grok");
  expect(spec.defaultHome).toBe(".grok");
  expect(spec.homeFiles.length).toBeGreaterThan(0);
  // ISA skill lands at <substrateHome>/skills/ISA (codex-shaped, no double nesting).
  expect(spec.isaSkillProjection.destinationDir("/tmp/grok-home")).toContain("skills");
  expect(spec.isaSkillProjection.destinationDir("/tmp/grok-home")).toContain("ISA");
  // U6: real marker-guarded uninstall round-trip (R10, KTD-5).
  expect(spec.uninstall.kind).toBe("implemented");
});

test("grok resolves through substrate-id parsing", () => {
  expect(isSubstrateId("grok")).toBe(true);
  expect(parseSubstrate("grok")).toBe("grok");
});

test("every lifecycle verb accepts grok", () => {
  expect(parseInstallArgs(["install", "grok"]).substrate).toBe("grok");
  expect(parseUninstallArgs(["uninstall", "grok"]).substrate).toBe("grok");
  expect(parseReprojectArgs(["reproject", "grok"]).substrate).toBe("grok");
  expect(parseUpgradeArgs(["upgrade", "grok"]).substrate).toBe("grok");
  expect(parseExportArgs(["export", "grok"]).substrate).toBe("grok");
});

test("workspace grok install targets a .grok home, not the .codex fallback", () => {
  // Regression for workspaceSubstrateHome's silent `.codex` else-branch:
  // an unrecognized substrate would have fallen through to `.codex`.
  const parsed = parseInstallArgs(["install", "grok", "--workspace"]);
  expect(parsed.workspace).toBe(true);
  expect(parsed.options.substrateHome).toBeDefined();
  expect(parsed.options.substrateHome).toContain(".grok");
  expect(parsed.options.substrateHome).not.toContain(".codex");
});

test("activeIsaProjectionPath resolves grok without throwing", () => {
  expect(activeIsaProjectionPath("grok")).toBe("skills/soma/active-isa.md");
});

test("planSomaForGrokInstall produces a dry-run plan rooted at the grok home", () => {
  const plan = planSomaForGrokInstall({ homeDir: "/tmp/soma-grok-plan" });

  expect(plan.substrate).toBe("grok");
  expect(plan.apply).toBe(false);
  expect(plan.substrateHome).toContain(".grok");
  expect(plan.substrateFiles.length).toBeGreaterThan(0);
  expect(plan.substrateFiles.every((path) => path.startsWith("/tmp/soma-grok-plan/.grok"))).toBe(true);
});

test("GROK_HOME_FILES equals the static projection set plus the lifecycle and patch targets", () => {
  // Locks the sync contract between the install plan and
  // projectGrokHome: a static file added on either side without the
  // other fails here. Dynamic entries (active-isa, portable skills)
  // are excluded from the plan by design; the lifecycle files are
  // written by the shared lifecycle-projection step and the patch
  // targets by the post-projection steps.
  const staticInput = {
    ...portableProjectionInput,
    activeIsa: undefined,
    profile: { ...portableProjectionInput.profile, skills: [] },
  };
  const staticPaths = projectGrokHome(staticInput, "/tmp/soma-home").files.map((file) => file.path);

  expect(
    new Set([...staticPaths, "skills/soma/startup-context.md", "skills/soma/soma-repo.txt", "AGENTS.md", "config.toml"]),
  ).toEqual(new Set(GROK_HOME_FILES));
});

test("grok AGENTS.md pointer block is appended once, idempotently, preserving foreign content", async () => {
  await withTempDir("soma-grok-agents-", async (grokHome) => {
    const path = join(grokHome, "AGENTS.md");
    await writeFile(path, "# My Grok rules\n\nKeep responses terse.\n", "utf8");

    await configureGrokAgentsPointer(grokHome, "/tmp/soma-home");
    const first = await readFile(path, "utf8");

    // Foreign lines preserved; Soma block appended exactly once.
    expect(first).toContain("# My Grok rules");
    expect(first).toContain("Keep responses terse.");
    expect(first.split(GROK_AGENTS_BLOCK_BEGIN)).toHaveLength(2);
    expect(first).toContain(GROK_AGENTS_BLOCK_END);
    expect(first).toContain("skills/soma/SKILL.md");
    expect(first).toContain("/tmp/soma-home");

    // Re-patch is byte-identical (no duplicate block).
    await configureGrokAgentsPointer(grokHome, "/tmp/soma-home");
    expect(await readFile(path, "utf8")).toBe(first);

    // A changed soma home rewrites only the marked block.
    await configureGrokAgentsPointer(grokHome, "/tmp/other-soma");
    const repatched = await readFile(path, "utf8");
    expect(repatched).toContain("# My Grok rules");
    expect(repatched).toContain("/tmp/other-soma");
    expect(repatched).not.toContain("/tmp/soma-home");
    expect(repatched.split(GROK_AGENTS_BLOCK_BEGIN)).toHaveLength(2);
  });
});

test("grok AGENTS.md pointer block creates the file when missing", async () => {
  await withTempDir("soma-grok-agents-new-", async (grokHome) => {
    await configureGrokAgentsPointer(grokHome, "/tmp/soma-home");
    const content = await readFile(join(grokHome, "AGENTS.md"), "utf8");
    expect(content.startsWith(GROK_AGENTS_BLOCK_BEGIN)).toBe(true);
    expect(content.trimEnd().endsWith(GROK_AGENTS_BLOCK_END)).toBe(true);
  });
});

test("grok config.toml marker block is appended once, idempotently, preserving foreign content", async () => {
  await withTempDir("soma-grok-config-", async (grokHome) => {
    const path = join(grokHome, "config.toml");
    await writeFile(path, '[ui]\ntheme = "dark"\n', "utf8");

    await configureGrokConfigPatch(grokHome, "/tmp/soma-home");
    const first = await readFile(path, "utf8");

    expect(first).toContain('theme = "dark"');
    expect(first.split(GROK_CONFIG_BLOCK_BEGIN)).toHaveLength(2);
    expect(first).toContain(GROK_CONFIG_BLOCK_END);

    await configureGrokConfigPatch(grokHome, "/tmp/soma-home");
    expect(await readFile(path, "utf8")).toBe(first);
  });
});

test("grok projection rejects path escapes", async () => {
  await withTempDir("soma-grok-escape-", async (root) => {
    const escaping = {
      substrate: "grok" as const,
      instructions: "",
      files: [{ path: "../escape.md", content: "nope" }],
    };
    const absolute = {
      substrate: "grok" as const,
      instructions: "",
      files: [{ path: join(root, "abs.md"), content: "nope" }],
    };

    await expect(writeProjection(escaping, root)).rejects.toThrow("escapes root");
    await expect(writeProjection(absolute, root)).rejects.toThrow("must be relative");
  });
});

test("installSomaForGrok applies the plan exactly, idempotently, and preserves user-authored skills", async () => {
  await withTempDir("soma-grok-install-", async (homeDir) => {
    // A user-authored skill that shares the skills/ surface must survive.
    const foreignSkill = join(homeDir, ".grok", "skills", "mine", "SKILL.md");
    await mkdir(join(homeDir, ".grok", "skills", "mine"), { recursive: true });
    await writeFile(foreignSkill, "---\nname: mine\n---\n\nUser-owned.\n", "utf8");

    const plan = planSomaForGrokInstall({ homeDir });
    const result = await installSomaForGrok({ homeDir });

    // Dry-run == apply: the plan's substrate file set matches what the
    // installer wrote (fresh soma home -> no active ISA, no portable
    // skills, so the dynamic entries are absent on both sides). The
    // plan renders with forward slashes while the installer resolves
    // native paths, so compare separator-normalized.
    const normalize = (path: string) => path.replace(/\\/g, "/");
    expect(new Set(result.substrateHome.files.map(normalize))).toEqual(new Set(plan.substrateFiles.map(normalize)));

    const skillPath = join(homeDir, ".grok", "skills", "soma", "SKILL.md");
    const agentsPath = join(homeDir, ".grok", "AGENTS.md");
    const firstSkill = await readFile(skillPath, "utf8");
    const firstAgents = await readFile(agentsPath, "utf8");
    expect(firstSkill).toContain("name: soma");
    expect(firstAgents.split(GROK_AGENTS_BLOCK_BEGIN)).toHaveLength(2);

    // Second install: byte-identical projection, no duplicated AGENTS.md
    // block, foreign skill untouched.
    await installSomaForGrok({ homeDir });
    expect(await readFile(skillPath, "utf8")).toBe(firstSkill);
    expect(await readFile(agentsPath, "utf8")).toBe(firstAgents);
    expect(await readFile(foreignSkill, "utf8")).toContain("User-owned.");
  });
});
