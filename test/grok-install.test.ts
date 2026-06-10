import { expect, test } from "bun:test";
import { planSomaForGrokInstall, activeIsaProjectionPath } from "../src/index";
import { allInstallSpecs, installSpecFor } from "../src/install-spec-registry";
import { grokInstallSpec } from "../src/adapters/grok/install";
import { isSubstrateId, parseSubstrate } from "../src/cli/substrate";
import {
  parseExportArgs,
  parseInstallArgs,
  parseReprojectArgs,
  parseUninstallArgs,
  parseUpgradeArgs,
} from "../src/cli/substrate-lifecycle";

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
  // Uninstall is reserved until U6 implements the marker-guarded unpatch.
  expect(spec.uninstall.kind).toBe("reserved");
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
