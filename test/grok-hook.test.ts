import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { installSomaForGrok, somaWorkRegistryPaths } from "../src/index";
import { GROK_ALGORITHM_UPDATED_MATCHER } from "../src/adapters/grok/adapter";
import { renderStartupContextSummary } from "../src/adapters/grok/hooks/grok-hook-entry.mjs";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-grok-hook-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function waitForFileContaining(path: string, text: string): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      last = await readFile(path, "utf8");
      if (last.includes(text)) return last;
    } catch {
      last = "";
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

interface GrokHookTestOutput {
  continue?: boolean;
  systemMessage?: string;
  stopReason?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    additionalContext?: string;
  };
}

// KTD-9: hook behavior tests spawn the shipped hook via system Node
// (Node-as-parent is proven safe for the detached bun children, soma#73)
// and assert on the stdout JSON contract. Nothing launches a live grok.
// HOME *and* USERPROFILE are pinned so `homedir()` resolves to the temp
// home on POSIX and Windows alike.
function runGrokHook(
  hook: string,
  event: string,
  homeDir: string,
  input: unknown,
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number | null; output: GrokHookTestOutput } {
  const result = spawnSync("node", [hook, event], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ...extraEnv,
    },
    input: JSON.stringify(input),
    encoding: "utf8",
  });

  return {
    status: result.status,
    output: JSON.parse(result.stdout) as GrokHookTestOutput,
  };
}

test("grok install renders a Windows-safe bare-exec hook surface", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForGrok({ homeDir });

    const hooksJson = JSON.parse(await readFile(join(homeDir, ".grok/hooks/soma-lifecycle.json"), "utf8")) as {
      hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout: number }[] }[]>;
    };

    // U1 gate 2/3 + the grok hooks doc: lifecycle events REJECT a
    // matcher; only the tool events accept one.
    expect(Object.keys(hooksJson.hooks).sort()).toEqual([
      "PostCompact",
      "PostToolUse",
      "PreCompact",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "PreCompact", "PostCompact"]) {
      expect(hooksJson.hooks[event]![0]!.matcher).toBeUndefined();
    }
    // Empirical tool names (2026-06-10 enumeration probe, grok 0.2.38):
    // matchers are ANCHORED full-match regex and the real edit tools are
    // Write/StrReplace — not the docs' `search_replace` alias.
    expect(hooksJson.hooks.PostToolUse![0]!.matcher).toBe(GROK_ALGORITHM_UPDATED_MATCHER);
    expect(GROK_ALGORITHM_UPDATED_MATCHER).toBe("Write|StrReplace");

    const verbs = new Set<string>();
    for (const entries of Object.values(hooksJson.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          // KTD-2: bare-exec command — explicit runtime, absolute paths,
          // no tilde-expansion paths, no shell metacharacters (anything
          // with |&;$<>[] is routed through `sh -c`, the Git Bash
          // dependency we avoid). Interior tildes are allowed: Windows
          // 8.3 short names (`KYLELI~1`) are valid bare-exec bytes.
          expect(hook.type).toBe("command");
          expect(hook.command.split(" ").some((token) => token.startsWith("~"))).toBe(false);
          expect(hook.command).not.toMatch(/[|&;$<>[\]]/);
          // Grok's default hook timeout is 5s — too tight for the
          // lifecycle shell-outs, so every hook pins its own.
          expect(hook.timeout).toBe(30);
          expect(hook.command.replace(/\\/g, "/")).toContain(".grok/hooks/soma-lifecycle.mjs");
          verbs.add(hook.command.split(" ").at(-1)!);
        }
      }
    }
    expect([...verbs].sort()).toEqual([
      "algorithm-updated",
      "post-compact",
      "pre-compact",
      "prompt-submit",
      "session-end",
      "session-start",
    ]);

    const config = JSON.parse(await readFile(join(homeDir, ".grok/hooks/soma-lifecycle.config.json"), "utf8"));
    expect(config.somaHome.replace(/\\/g, "/")).toContain(".soma");
    expect(config.grokHome.replace(/\\/g, "/")).toContain(".grok");
    expect(config.startupContextPath).toBe("skills/soma/startup-context.md");
    expect(typeof config.bunPath).toBe("string");
    expect(config.trustedSomaRepo.length).toBeGreaterThan(0);
    expect(Array.isArray(config.privateRoots)).toBe(true);
    expect(Array.isArray(config.policyMarkers)).toBe(true);
    expect(config.inboundSecurity.untrustedRoots.length).toBeGreaterThan(0);

    const lifecycle = await readFile(join(homeDir, ".grok/hooks/soma-lifecycle.mjs"), "utf8");
    expect(lifecycle).toContain("#!/usr/bin/env bun");
    expect(lifecycle).toContain("soma-lifecycle.config.json");

    const entry = await readFile(join(homeDir, ".grok/hooks/grok-hook-entry.mjs"), "utf8");
    expect(entry).toContain("runGrokHook");
    // The Algorithm priming points at the projected grok skill surface.
    expect(entry).toContain("skills/the-algorithm/SKILL.md");
    // The feedback extension replaced the inert fallback stub.
    expect(entry).toContain('import { runSomaFeedbackCapture } from "./soma-feedback-capture.mjs";');
    expect(entry).not.toContain("__SOMA_PROMPT_SUBMIT_EXTENSION_START__");

    const feedback = await readFile(join(homeDir, ".grok/hooks/soma-feedback-capture.mjs"), "utf8");
    expect(feedback).toContain('"grok"');
    expect(feedback).toContain("config.bunPath");
  });
});

test("installed grok session-start hook returns concise visible context and projects it", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForGrok({ homeDir });
    const hook = join(homeDir, ".grok/hooks/soma-lifecycle.mjs");

    const result = runGrokHook(hook, "session-start", homeDir, { sessionId: "session-1" }, { GROK_SESSION_ID: "session-1" });
    const startupContext = await readFile(join(homeDir, ".grok/skills/soma/startup-context.md"), "utf8");
    const pointerPath = somaWorkRegistryPaths({ homeDir }, "session-1").currentWork!;
    const pointer = JSON.parse(await readFile(pointerPath, "utf8"));

    expect(result.status).toBe(0);
    expect(result.output.hookSpecificOutput?.additionalContext).toContain("Soma:");
    expect(result.output.hookSpecificOutput?.additionalContext).toContain("Full context is in the projected startup-context.md");
    expect(result.output.hookSpecificOutput?.additionalContext).not.toContain("## Active Algorithm Runs");
    expect(startupContext).toContain("Soma Startup Context");
    expect(pointer).toMatchObject({
      schema: "soma-current-work-v1",
      sessionUUID: "session-1",
      substrate: "grok",
      status: "active",
    });
  });
});

test("grok session-start is single-owner per GROK_SESSION_ID (first-writer-wins)", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForGrok({ homeDir });
    const hook = join(homeDir, ".grok/hooks/soma-lifecycle.mjs");

    const first = runGrokHook(hook, "session-start", homeDir, {}, { GROK_SESSION_ID: "session-guard-1" });
    const second = runGrokHook(hook, "session-start", homeDir, {}, { GROK_SESSION_ID: "session-guard-1" });
    const otherSession = runGrokHook(hook, "session-start", homeDir, {}, { GROK_SESSION_ID: "session-guard-2" });

    expect(first.status).toBe(0);
    expect(first.output.hookSpecificOutput?.additionalContext).toContain("Soma:");
    // Second invocation for the SAME session no-ops without re-running
    // the lifecycle body (U1 gate 2: cardinality is per-session, so the
    // guard key is GROK_SESSION_ID).
    expect(second.status).toBe(0);
    expect(second.output.continue).toBe(true);
    expect(second.output.systemMessage).toContain("already handled");
    expect(second.output.hookSpecificOutput).toBeUndefined();
    // A different session runs its own lifecycle.
    expect(otherSession.status).toBe(0);
    expect(otherSession.output.hookSpecificOutput?.additionalContext).toContain("Soma:");

    const guard = await readFile(join(homeDir, ".soma/memory/STATE/grok-session-guards/session-guard-1.json"), "utf8");
    expect(JSON.parse(guard).pid).toBeGreaterThan(0);
  });
});

test("grok session-start falls back to the projected startup context when the soma repo is unusable", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForGrok({ homeDir });
    const hook = join(homeDir, ".grok/hooks/soma-lifecycle.mjs");
    const configPath = join(homeDir, ".grok/hooks/soma-lifecycle.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const brokenRepo = join(homeDir, "empty-repo");
    await mkdir(brokenRepo, { recursive: true });
    await writeFile(configPath, JSON.stringify({ ...config, trustedSomaRepo: brokenRepo }, null, 2), "utf8");

    const result = runGrokHook(hook, "session-start", homeDir, { sessionId: "session-fallback" });

    expect(result.status).toBe(0);
    expect(result.output.continue).toBe(true);
    expect(result.output.systemMessage).toContain("fell back");
    // Install already projected startup-context.md, so the fallback still
    // surfaces the concise summary instead of the unavailable line.
    expect(result.output.hookSpecificOutput?.additionalContext).toContain("Full context is in the projected startup-context.md");
  });
});

test("installed grok prompt hook captures feedback candidates quietly", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForGrok({ homeDir });
    const hook = join(homeDir, ".grok/hooks/soma-lifecycle.mjs");

    const result = runGrokHook(hook, "prompt-submit", homeDir, { prompt: "you missed the arc-manifest" });
    const events = await waitForFileContaining(join(homeDir, ".soma/memory/STATE/events.jsonl"), "feedback.candidate");

    expect(result.status).toBe(0);
    expect(result.output.continue).toBe(true);
    expect(events).toContain("feedback.candidate");
    expect(events).toContain("missed-surface");
  });
});

test("installed grok prompt hook does not persist ordinary prompts", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForGrok({ homeDir });
    const hook = join(homeDir, ".grok/hooks/soma-lifecycle.mjs");

    const result = runGrokHook(hook, "prompt-submit", homeDir, { prompt: "thanks" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const events = await readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8");

    expect(result.status).toBe(0);
    expect(events).not.toContain("feedback.candidate");
  });
});

test("installed grok algorithm-updated hook handles the lifecycle event", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForGrok({ homeDir });
    const hook = join(homeDir, ".grok/hooks/soma-lifecycle.mjs");

    // Grok payload shape: camelCase keys, snake_case event value, the
    // real toolInput key set observed in the enumeration probe.
    const result = runGrokHook(hook, "algorithm-updated", homeDir, {
      hookEventName: "post_tool_use",
      sessionId: "session-2",
      toolName: "StrReplace",
      toolInput: { path: "notes.md", old_string: "a", new_string: "b" },
    });

    expect(result.status).toBe(0);
    expect(result.output.continue).toBe(true);
    expect(result.output.systemMessage).toContain("algorithm-updated");
  });
});

test("installed grok pre-compact hook persists active Algorithm state before the context cut", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForGrok({ homeDir });
    const hook = join(homeDir, ".grok/hooks/soma-lifecycle.mjs");

    const result = runGrokHook(hook, "pre-compact", homeDir, { sessionId: "session-compact-1" });
    const workIndex = await readFile(join(homeDir, ".soma/memory/STATE/algorithm-work-index.json"), "utf8");
    const activeRun = await readFile(join(homeDir, ".soma/memory/STATE/active-algorithm-run.json"), "utf8");
    const events = await readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8");

    expect(result.status).toBe(0);
    expect(result.output.continue).toBe(true);
    expect(result.output.systemMessage).toContain("pre-compact");
    // R6: PreCompact persists the active Algorithm/ISA state via the
    // algorithm-observed lifecycle shell-out (work index + active-run
    // pointer + observation provenance) so the durable record survives
    // the context cut.
    expect(JSON.parse(workIndex)).toHaveProperty("runs");
    expect(activeRun.length).toBeGreaterThan(0);
    expect(events).toContain("lifecycle.algorithm_observed");
  });
});

test("installed grok post-compact hook re-emits the startup-context summary as additionalContext", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForGrok({ homeDir });
    const hook = join(homeDir, ".grok/hooks/soma-lifecycle.mjs");

    // Install already projected startup-context.md; post-compact is a
    // pure read of that file — no shell-out, so it stays cheap and
    // works even when the soma repo is unusable mid-session.
    const result = runGrokHook(hook, "post-compact", homeDir, { sessionId: "session-compact-2" });

    expect(result.status).toBe(0);
    expect(result.output.continue).toBe(true);
    expect(result.output.hookSpecificOutput?.hookEventName).toBe("PostCompact");
    expect(result.output.hookSpecificOutput?.additionalContext).toContain("Soma:");
    expect(result.output.hookSpecificOutput?.additionalContext).toContain("Full context is in the projected startup-context.md");
  });
});

test("grok post-compact degrades gracefully when the projected startup context is absent", async () => {
  await withTempHome(async (homeDir) => {
    await installSomaForGrok({ homeDir });
    const hook = join(homeDir, ".grok/hooks/soma-lifecycle.mjs");
    await rm(join(homeDir, ".grok/skills/soma/startup-context.md"), { force: true });

    const result = runGrokHook(hook, "post-compact", homeDir, {});

    expect(result.status).toBe(0);
    expect(result.output.continue).toBe(true);
    expect(result.output.hookSpecificOutput?.additionalContext).toContain("startup context unavailable");
  });
});

test("grok session-start summary only counts active Algorithm runs", () => {
  const summary = renderStartupContextSummary(
    [
      "# Soma Startup Context",
      "Assistant: Ivy",
      "Principal: Jens-Christian",
      "",
      "## Active Algorithm Runs",
      "- 20260610_one: OBSERVE 1/1 E1 - One active run.",
      "",
      "## Recent Learning",
      "- A learning note, not an active run.",
      "",
    ].join("\n"),
  );

  expect(summary).toContain("Ivy for Jens-Christian");
  expect(summary).toContain("1 active run");
  expect(renderStartupContextSummary(undefined)).toContain("startup context unavailable");
});
