import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectGrok, projectGrokHome, grokAdapter, type Projection } from "../src/index";
import { portableProjectionInput } from "./fixtures";

// Mirrors the portable-semantics contract asserted for every other
// substrate in substrate-adapters.test.ts: the markers all flow from
// the shared renderers fed the portableProjectionInput fixture.
function expectPortableSemantics(bundle: Projection) {
  expect(bundle.instructions).toContain("Soma");
  expect(bundle.instructions).toContain("Keep personal assistant context portable across substrates.");
  expect(bundle.instructions).toContain("Substrate adapters translate; they do not own core concepts");
  expect(bundle.instructions).toContain("ISC-PORTABLE-1");
  expect(bundle.files.some((file) => file.content.includes("MEMORY/LEARNING"))).toBe(true);
  expect(bundle.files.some((file) => file.content.includes("Ledger Update"))).toBe(true);
  expect(bundle.files.some((file) => file.content.includes("Policy Projection"))).toBe(true);
}

test("grok adapter builds a grok-shaped workspace context bundle", () => {
  const bundle = projectGrok(portableProjectionInput);

  expect(bundle.substrate).toBe("grok");
  expect(bundle.files.map((file) => file.path)).toEqual([
    ".grok/soma/context.md",
    ".grok/soma/memory-layout.md",
    ".grok/soma/skills.md",
    ".grok/soma/policy.md",
  ]);
  expectPortableSemantics(bundle);
});

test("grok home projection preserves portable semantics and gates the active ISA", () => {
  const home = projectGrokHome(portableProjectionInput);

  expect(home.substrate).toBe("grok");
  expectPortableSemantics(home);
  // Fixture carries an active ISA → projected under the skills surface.
  expect(home.files.map((file) => file.path)).toContain("skills/soma/active-isa.md");

  const homeNoIsa = projectGrokHome({ ...portableProjectionInput, activeIsa: undefined });
  expect(homeNoIsa.files.map((file) => file.path)).not.toContain("skills/soma/active-isa.md");
});

test("grok adapter exposes context build before execution and stubs run()", async () => {
  await expect(grokAdapter.project(portableProjectionInput)).resolves.toMatchObject({ substrate: "grok" });

  await expect(grokAdapter.run({ id: "task-grok", substrate: "grok", prompt: "run" })).resolves.toMatchObject({
    substrate: "grok",
    status: "failed",
    summary: expect.stringContaining("not implemented"),
  });
});

test("grok adapter detect() reflects ~/.grok presence", async () => {
  const originalUserProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "soma-grok-detect-"));

  try {
    process.env.USERPROFILE = tempHome;
    process.env.HOME = tempHome;

    expect(await grokAdapter.detect()).toBe(false);

    mkdirSync(join(tempHome, ".grok"), { recursive: true });
    expect(await grokAdapter.detect()).toBe(true);
  } finally {
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  }
});
