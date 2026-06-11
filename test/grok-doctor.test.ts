import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { diagnoseGrokProjectionDrift } from "../src/adapters/grok/doctor";
import { GROK_AGENTS_BLOCK_BEGIN, GROK_AGENTS_BLOCK_END } from "../src/adapters/grok/config-patch";
import { diagnoseSomaDoctor } from "../src/onboarding";
import { runSomaCli } from "../src/cli";
import { withTempHome as withSharedTempHome } from "./fixtures/pai-migration-fixtures";

const withTempHome = <T>(fn: (homeDir: string) => Promise<T>): Promise<T> =>
  withSharedTempHome(fn, "soma-grok-doctor-");

// Fixture mirroring the captured `grok inspect --json` shape (grok 0.2.38):
// `projectInstructions[]` entries carry `path`/`scope`, `skills[]` entries
// carry `name` + `source.{type,path}`, `hooks[]` entries carry `target`.
function inspectFixture(homeDir: string, overrides: {
  skills?: { name: string; path: string }[];
  projectInstructions?: { path: string; scope: string }[];
  hooks?: { target: string }[];
} = {}): string {
  const skills = overrides.skills ?? [
    { name: "soma", path: join(homeDir, ".grok/skills/soma/SKILL.md") },
    { name: "the-algorithm", path: join(homeDir, ".grok/skills/the-algorithm/SKILL.md") },
  ];
  const projectInstructions = overrides.projectInstructions ?? [
    { path: join(homeDir, ".grok/AGENTS.md"), scope: "global" },
  ];
  const hooks = overrides.hooks ?? [
    { target: join(homeDir, ".grok/hooks/soma-lifecycle.json") },
  ];
  return JSON.stringify({
    grokVersion: "0.2.38",
    projectInstructions: projectInstructions.map((entry) => ({
      ...entry,
      fileType: "agents_md",
      sizeBytes: 438,
    })),
    hooks: hooks.map((hook) => ({
      event: "SessionStart",
      hookType: "command",
      target: hook.target,
      source: { type: "user", path: join(homeDir, ".grok") },
      matcher: null,
    })),
    skills: skills.map((skill) => ({
      name: skill.name,
      description: `${skill.name} skill`,
      source: { type: "user", path: skill.path },
      userInvocable: true,
    })),
  });
}

async function writePatchedAgentsFile(homeDir: string): Promise<void> {
  await mkdir(join(homeDir, ".grok"), { recursive: true });
  await writeFile(
    join(homeDir, ".grok/AGENTS.md"),
    `# Mine\n\nforeign content\n\n${GROK_AGENTS_BLOCK_BEGIN}\n## Soma\n${GROK_AGENTS_BLOCK_END}\n`,
    "utf8",
  );
}

test("grok doctor reports no findings when the projection and hook are discovered", async () => {
  await withTempHome(async (homeDir) => {
    await writePatchedAgentsFile(homeDir);

    const findings = await diagnoseGrokProjectionDrift({
      homeDir,
      runInspect: async () => inspectFixture(homeDir),
    });

    expect(findings).toEqual([]);
  });
});

test("grok doctor flags an undiscovered Soma skill as projection drift", async () => {
  await withTempHome(async (homeDir) => {
    await writePatchedAgentsFile(homeDir);

    const findings = await diagnoseGrokProjectionDrift({
      homeDir,
      runInspect: async () => inspectFixture(homeDir, {
        skills: [{ name: "the-algorithm", path: join(homeDir, ".grok/skills/the-algorithm/SKILL.md") }],
      }),
    });

    expect(findings).toEqual([{
      id: "grok-projection-stale",
      severity: "warning",
      message: "Grok does not discover the projected skill(s): soma.",
      action: "soma reproject grok",
    }]);
  });
});

test("grok doctor ignores a same-named skill discovered outside ~/.grok/skills", async () => {
  await withTempHome(async (homeDir) => {
    await writePatchedAgentsFile(homeDir);

    // A claude-vendored `soma` skill must not satisfy the projection check.
    const findings = await diagnoseGrokProjectionDrift({
      homeDir,
      runInspect: async () => inspectFixture(homeDir, {
        skills: [
          { name: "soma", path: join(homeDir, ".claude/skills/soma/SKILL.md") },
          { name: "the-algorithm", path: join(homeDir, ".grok/skills/the-algorithm/SKILL.md") },
        ],
      }),
    });

    expect(findings.map((finding) => finding.id)).toEqual(["grok-projection-stale"]);
  });
});

test("grok doctor flags a missing AGENTS.md pointer block as projection drift", async () => {
  await withTempHome(async (homeDir) => {
    // AGENTS.md exists and is discovered, but a user removed the Soma block.
    await mkdir(join(homeDir, ".grok"), { recursive: true });
    await writeFile(join(homeDir, ".grok/AGENTS.md"), "# Mine\n\nforeign content only\n", "utf8");

    const findings = await diagnoseGrokProjectionDrift({
      homeDir,
      runInspect: async () => inspectFixture(homeDir),
    });

    expect(findings).toEqual([{
      id: "grok-projection-stale",
      severity: "warning",
      message: "~/.grok/AGENTS.md is missing the Soma pointer block.",
      action: "soma reproject grok",
    }]);
  });
});

test("grok doctor flags an undiscovered AGENTS.md as projection drift", async () => {
  await withTempHome(async (homeDir) => {
    await writePatchedAgentsFile(homeDir);

    const findings = await diagnoseGrokProjectionDrift({
      homeDir,
      runInspect: async () => inspectFixture(homeDir, { projectInstructions: [] }),
    });

    expect(findings).toEqual([{
      id: "grok-projection-stale",
      severity: "warning",
      message: "Grok does not list ~/.grok/AGENTS.md among its discovered instructions.",
      action: "soma reproject grok",
    }]);
  });
});

test("grok doctor matches Windows extended-length, case-shifted inspect paths", async () => {
  await withTempHome(async (homeDir) => {
    await writePatchedAgentsFile(homeDir);

    // grok 0.2.38 reports e.g. `\\?\C:\Users\...\.grok\Agents.md` — the
    // extended-length prefix, backslash separators, and filesystem casing
    // must all normalize away.
    const windowsForm = `\\\\?\\${join(homeDir, ".grok/Agents.md").replace(/\//g, "\\")}`;

    const findings = await diagnoseGrokProjectionDrift({
      homeDir,
      runInspect: async () => inspectFixture(homeDir, {
        projectInstructions: [{ path: windowsForm, scope: "global" }],
      }),
    });

    expect(findings).toEqual([]);
  });
});

test("grok doctor flags a missing Soma lifecycle hook", async () => {
  await withTempHome(async (homeDir) => {
    await writePatchedAgentsFile(homeDir);

    const findings = await diagnoseGrokProjectionDrift({
      homeDir,
      runInspect: async () => inspectFixture(homeDir, { hooks: [] }),
    });

    expect(findings).toEqual([{
      id: "grok-hook-missing",
      severity: "warning",
      message: "Grok does not register the Soma lifecycle hook.",
      action: "soma install grok --apply",
    }]);
  });
});

test("grok doctor reports an informational finding when no grok binary is installed", async () => {
  await withTempHome(async (homeDir) => {
    const findings = await diagnoseGrokProjectionDrift({ homeDir });

    expect(findings).toEqual([{
      id: "grok-inspect-unavailable",
      severity: "info",
      message: "Grok binary not found — skipped `grok inspect` discovery checks. Install the Grok CLI to enable them.",
      action: "soma doctor --substrate grok",
    }]);
  });
});

test("grok doctor degrades to a warning on unparseable inspect output", async () => {
  await withTempHome(async (homeDir) => {
    const findings = await diagnoseGrokProjectionDrift({
      homeDir,
      runInspect: async () => "grok exploded: not json",
    });

    expect(findings.map((finding) => finding.id)).toEqual(["grok-inspect-unavailable"]);
    expect(findings[0]?.severity).toBe("warning");
  });
});

test("grok doctor degrades to a warning when the inspect probe throws", async () => {
  await withTempHome(async (homeDir) => {
    const findings = await diagnoseGrokProjectionDrift({
      homeDir,
      runInspect: async () => {
        throw new Error("spawn timed out");
      },
    });

    expect(findings.map((finding) => finding.id)).toEqual(["grok-inspect-unavailable"]);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.message).toContain("spawn timed out");
  });
});

test("every grok doctor finding action is an executable soma command (F9)", async () => {
  await withTempHome(async (homeDir) => {
    // Drive every finding path: inspect throws, returns unparseable
    // output, no binary, projection stale, and hook missing.
    const scenarios = [
      diagnoseGrokProjectionDrift({ homeDir }), // no binary (info)
      diagnoseGrokProjectionDrift({ homeDir, runInspect: async () => "not json" }), // unparseable
      diagnoseGrokProjectionDrift({
        homeDir,
        runInspect: async () => {
          throw new Error("spawn timed out");
        },
      }),
      diagnoseGrokProjectionDrift({ homeDir, runInspect: async () => inspectFixture(homeDir, { skills: [] }) }),
      diagnoseGrokProjectionDrift({ homeDir, runInspect: async () => inspectFixture(homeDir, { hooks: [] }) }),
    ];

    const actions = (await Promise.all(scenarios))
      .flat()
      .map((finding) => finding.action)
      .filter((action): action is string => typeof action === "string");

    expect(actions.length).toBeGreaterThan(0);
    // No prose: an agent execs these verbatim, so each must be a `soma`
    // command, not human repair text.
    for (const action of actions) {
      expect(action).toMatch(/^soma /);
    }
  });
});

test("soma doctor --substrate grok no longer rejects as unsupported", async () => {
  await withTempHome(async (homeDir) => {
    // Clean temp home: no grok binary, so the only finding is the
    // informational skip note — which must read as ok, not drift.
    const diagnosis = await diagnoseSomaDoctor({ homeDir, substrate: "grok" });

    expect(diagnosis.status).toBe("ok");
    expect(diagnosis.findings).toEqual([{
      id: "grok-inspect-unavailable",
      severity: "info",
      message: "Grok binary not found — skipped `grok inspect` discovery checks. Install the Grok CLI to enable them.",
      action: "soma doctor --substrate grok",
    }]);
  });
});

test("soma doctor CLI surfaces informational grok notes without reporting drift", async () => {
  await withTempHome(async (homeDir) => {
    const output = await runSomaCli(["doctor", "--substrate", "grok", "--home-dir", homeDir]);

    expect(output).toContain("soma doctor — ok");
    expect(output).toContain("grok-inspect-unavailable");
    expect(output).not.toContain("soma doctor — drift detected");
  });
});
