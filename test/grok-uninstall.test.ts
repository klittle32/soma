import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSomaForGrok, uninstallSomaForGrok, projectGrok } from "../src/index";
import {
  GROK_AGENTS_BLOCK_BEGIN,
  GROK_AGENTS_BLOCK_END,
  GROK_CONFIG_BLOCK_BEGIN,
  GROK_CONFIG_BLOCK_END,
} from "../src/adapters/grok/config-patch";
import { writeProjection } from "../src/projection";
import { runSomaCli } from "../src/cli";
import { portableProjectionInput } from "./fixtures";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const pathGone = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return false;
  } catch {
    return true;
  }
};

const normalize = (path: string) => path.replace(/\\/g, "/");

test("grok uninstall round-trips a real install", async () => {
  await withTempDir("soma-grok-uninstall-", async (homeDir) => {
    await installSomaForGrok({ homeDir });
    const grokHome = join(homeDir, ".grok");

    const result = await uninstallSomaForGrok({ homeDir });

    const removed = result.removed.map(normalize);
    for (const expected of [
      "skills/soma",
      "skills/the-algorithm",
      "skills/ISA",
      "AGENTS.md",
      "config.toml",
      "hooks/soma-lifecycle.json",
      "hooks/soma-lifecycle.mjs",
      "hooks/soma-lifecycle.config.json",
      "hooks/grok-hook-entry.mjs",
      "hooks/soma-feedback-capture.mjs",
    ]) {
      expect(removed).toContain(normalize(join(grokHome, expected)));
    }
    for (const path of ["skills/soma", "skills/the-algorithm", "skills/ISA", "hooks/soma-lifecycle.json", "hooks/soma-lifecycle.mjs"]) {
      expect(await pathGone(join(grokHome, path))).toBe(true);
    }
    // Install created AGENTS.md/config.toml with only the Soma block, so
    // unpatching leaves nothing to preserve and removes the files.
    expect(await pathGone(join(grokHome, "AGENTS.md"))).toBe(true);
    expect(await pathGone(join(grokHome, "config.toml"))).toBe(true);
  });
});

test("grok uninstall preserves foreign content and user-authored skills", async () => {
  await withTempDir("soma-grok-uninstall-foreign-", async (homeDir) => {
    const grokHome = join(homeDir, ".grok");
    await mkdir(join(grokHome, "skills", "mine"), { recursive: true });
    await writeFile(join(grokHome, "skills", "mine", "SKILL.md"), "---\nname: mine\n---\n\nUser-owned.\n", "utf8");
    await writeFile(join(grokHome, "AGENTS.md"), "# My Grok rules\n\nKeep responses terse.\n", "utf8");
    await writeFile(join(grokHome, "config.toml"), '[ui]\ntheme = "dark"\n', "utf8");
    // A user hook in the shared hooks/ dir must survive (U7 removes only
    // the marker-guarded Soma hook files, never the directory).
    await mkdir(join(grokHome, "hooks"), { recursive: true });
    await writeFile(join(grokHome, "hooks", "my-hook.json"), '{"hooks":{}}\n', "utf8");

    await installSomaForGrok({ homeDir });
    await uninstallSomaForGrok({ homeDir });

    // Foreign bytes survive; only the Soma blocks are excised.
    const agents = await readFile(join(grokHome, "AGENTS.md"), "utf8");
    expect(agents).toContain("# My Grok rules");
    expect(agents).toContain("Keep responses terse.");
    expect(agents).not.toContain(GROK_AGENTS_BLOCK_BEGIN);
    expect(agents).not.toContain(GROK_AGENTS_BLOCK_END);

    const config = await readFile(join(grokHome, "config.toml"), "utf8");
    expect(config).toContain('theme = "dark"');
    expect(config).not.toContain(GROK_CONFIG_BLOCK_BEGIN);
    expect(config).not.toContain(GROK_CONFIG_BLOCK_END);

    expect(await readFile(join(grokHome, "skills", "mine", "SKILL.md"), "utf8")).toContain("User-owned.");
    expect(await readFile(join(grokHome, "hooks", "my-hook.json"), "utf8")).toBe('{"hooks":{}}\n');
    expect(await pathGone(join(grokHome, "hooks", "soma-lifecycle.json"))).toBe(true);
  });
});

test("grok uninstall leaves a user directory that merely shares a Soma name", async () => {
  await withTempDir("soma-grok-uninstall-shared-name-", async (homeDir) => {
    const grokHome = join(homeDir, ".grok");
    // User-authored dirs named like Soma's, with no Soma markers.
    for (const name of ["soma", "the-algorithm", "ISA"]) {
      await mkdir(join(grokHome, "skills", name), { recursive: true });
      await writeFile(join(grokHome, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n\nHand-written.\n`, "utf8");
    }
    // User hook files that merely share the Soma names, without markers.
    await mkdir(join(grokHome, "hooks"), { recursive: true });
    await writeFile(join(grokHome, "hooks", "soma-lifecycle.json"), '{"hooks":{"Stop":[]}}\n', "utf8");
    await writeFile(join(grokHome, "hooks", "grok-hook-entry.mjs"), "// hand-written\n", "utf8");

    const result = await uninstallSomaForGrok({ homeDir });

    expect(result.removed).toEqual([]);
    for (const name of ["soma", "the-algorithm", "ISA"]) {
      expect(await readFile(join(grokHome, "skills", name, "SKILL.md"), "utf8")).toContain("Hand-written.");
    }
    expect(await readFile(join(grokHome, "hooks", "soma-lifecycle.json"), "utf8")).toContain('"Stop"');
    expect(await readFile(join(grokHome, "hooks", "grok-hook-entry.mjs"), "utf8")).toContain("hand-written");
  });
});

test("grok uninstall is an idempotent no-op the second time", async () => {
  await withTempDir("soma-grok-uninstall-idempotent-", async (homeDir) => {
    await installSomaForGrok({ homeDir });

    const first = await uninstallSomaForGrok({ homeDir });
    const second = await uninstallSomaForGrok({ homeDir });

    expect(first.removed.length).toBeGreaterThan(0);
    expect(second.removed).toEqual([]);
  });
});

test("grok uninstall removes the workspace rules overlay, marker-guarded", async () => {
  await withTempDir("soma-grok-uninstall-workspace-", async (workspaceRoot) => {
    // Workspace bundle: <repo>/.grok/rules/soma/ written by projectGrok.
    await writeProjection(projectGrok(portableProjectionInput), workspaceRoot);
    const workspaceGrokHome = join(workspaceRoot, ".grok");
    // A neighboring foreign rules dir must survive.
    await mkdir(join(workspaceGrokHome, "rules", "mine"), { recursive: true });
    await writeFile(join(workspaceGrokHome, "rules", "mine", "rules.md"), "User rules.\n", "utf8");

    const result = await uninstallSomaForGrok({ substrateHome: workspaceGrokHome });

    expect(result.removed.map(normalize)).toContain(normalize(join(workspaceGrokHome, "rules/soma")));
    expect(await pathGone(join(workspaceGrokHome, "rules", "soma"))).toBe(true);
    expect(await readFile(join(workspaceGrokHome, "rules", "mine", "rules.md"), "utf8")).toBe("User rules.\n");
  });
});

test("grok uninstall leaves a rules/soma dir without the Soma README marker", async () => {
  await withTempDir("soma-grok-uninstall-foreign-rules-", async (workspaceRoot) => {
    const workspaceGrokHome = join(workspaceRoot, ".grok");
    await mkdir(join(workspaceGrokHome, "rules", "soma"), { recursive: true });
    await writeFile(join(workspaceGrokHome, "rules", "soma", "README.md"), "# My own soma notes\n", "utf8");

    const result = await uninstallSomaForGrok({ substrateHome: workspaceGrokHome });

    expect(result.removed).toEqual([]);
    expect(await readFile(join(workspaceGrokHome, "rules", "soma", "README.md"), "utf8")).toContain("My own soma notes");
  });
});

test("grok uninstall leaves an unterminated marker block alone (foreign content)", async () => {
  await withTempDir("soma-grok-uninstall-unterminated-", async (homeDir) => {
    const grokHome = join(homeDir, ".grok");
    await mkdir(grokHome, { recursive: true });
    // Begin marker without end: the upsert treats this as foreign, so the
    // unpatch must too.
    const content = `# Mine\n\n${GROK_AGENTS_BLOCK_BEGIN}\nuser kept this around\n`;
    await writeFile(join(grokHome, "AGENTS.md"), content, "utf8");

    const result = await uninstallSomaForGrok({ homeDir });

    expect(result.removed).toEqual([]);
    expect(await readFile(join(grokHome, "AGENTS.md"), "utf8")).toBe(content);
  });
});

test("grok uninstall rethrows non-ENOENT errors", async () => {
  await withTempDir("soma-grok-uninstall-error-", async (homeDir) => {
    const grokHome = join(homeDir, ".grok");
    // AGENTS.md as a directory: readFile fails with EISDIR, not ENOENT.
    await mkdir(join(grokHome, "AGENTS.md"), { recursive: true });

    await expect(uninstallSomaForGrok({ homeDir })).rejects.toThrow();
  });
});

test("soma uninstall grok CLI reports removed paths and a clean no-op", async () => {
  await withTempDir("soma-grok-uninstall-cli-", async (homeDir) => {
    await installSomaForGrok({ homeDir });

    const output = await runSomaCli(["uninstall", "grok", "--home-dir", homeDir]);
    expect(output).toContain("soma uninstall grok");
    expect(output).toContain("Removed:");
    expect(normalize(output)).toContain("skills/soma");

    const second = await runSomaCli(["uninstall", "grok", "--home-dir", homeDir]);
    expect(second).toContain("Nothing to remove");
  });
});
