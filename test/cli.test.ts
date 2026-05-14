import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-cli-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("cli dry-runs codex install without writing files", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli(["install", "codex", "--home-dir", homeDir]);

    expect(output).toContain("mode: dry-run");
    expect(output).toContain(join(homeDir, ".soma/profile/assistant.md"));
    expect(output).toContain(join(homeDir, ".codex/rules/soma.rules"));
    await expect(stat(join(homeDir, ".soma"))).rejects.toThrow();
    await expect(stat(join(homeDir, ".codex"))).rejects.toThrow();
  });
});

test("cli applies codex install only with explicit apply flag", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli(["install", "codex", "--apply", "--home-dir", homeDir]);

    expect(output).toContain("Soma install applied");
    expect(output).toContain(`somaHome: ${join(homeDir, ".soma")}`);
    expect(output).toContain(`substrateHome: ${join(homeDir, ".codex")}`);
    await expect(readFile(join(homeDir, ".soma/profile/assistant.md"), "utf8")).resolves.toContain("Name: soma");
    await expect(readFile(join(homeDir, ".codex/rules/soma.rules"), "utf8")).resolves.toContain("Soma default availability");
  });
});

test("cli rejects unsupported commands", async () => {
  await expect(runSomaCli(["install", "claude-code"])).rejects.toThrow("Usage:");
});
