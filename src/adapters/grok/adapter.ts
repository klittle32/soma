import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SomaAdapter, Projection, ProjectionInput, SomaTask } from "../../types";
import { activeIsaBundleFile } from "../../adapter-active-isa";
import { resolveBunExecutable } from "../../bun-probe";
import { defaultInboundContentSecurityConfig } from "../../inbound-security";
import { somaPolicyPrivateMarkers } from "../../policy";
import { somaMemoryPrivateRoots, somaProjectionPrivateRoots } from "../../projection-private-roots";
import { defaultSomaRepoPath } from "../../repo-path";
import { rewriteSubstrateProjectionContent } from "../../substrate-projection-rewrites";
import { renderFeedbackHookModule } from "../shared/feedback-helper";
import {
  renderAlgorithmRenderingContract,
  renderAssistantCore,
  renderMemoryLayout,
  renderPolicyProjection,
  renderSkills,
  renderSubstrateInstructions,
} from "../shared";
import { readGrokHookAsset } from "./hooks/assets";

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

/**
 * Where the session-start hook projects the generated startup context,
 * relative to the Grok home. Lives inside `skills/soma/` so Grok's skill
 * discovery surfaces it as a companion file and uninstall removes it with
 * the marker-guarded skill dir. Shared by the install spec
 * (`lifecycleProjection`) and the hook runtime config so the two can
 * never drift.
 */
export const GROK_STARTUP_CONTEXT_PATH = "skills/soma/startup-context.md";
export const GROK_SOMA_REPO_POINTER_PATH = "skills/soma/soma-repo.txt";

/**
 * PostToolUse matcher for the algorithm-updated refresh. Grok matchers
 * are ANCHORED full-match regexes over the runtime tool names, and the
 * runtime names are Claude-style PascalCase — both verified live on
 * 2026-06-10 (grok 0.2.38 enumeration probe: Shell, Read, Write,
 * StrReplace, Grep, Glob). The docs' snake_case alias table
 * (`search_replace` etc.) does NOT reflect the runtime and would never
 * match. Mirrors codex's edit-tool intent (Edit|Write|apply_patch).
 */
export const GROK_ALGORITHM_UPDATED_MATCHER = "Write|StrReplace";

/**
 * PreToolUse matcher for the U9 fail-closed policy chain: the verified
 * read/write/shell tool names from the same enumeration table. Grep and
 * Glob are deliberately absent (read-only search surfaces with no policy
 * leg); unverified tools (web_search, subagents, MCP) must be enumerated
 * live before they are matched — the U10 version pin guards renames.
 */
export const GROK_PRE_TOOL_USE_MATCHER = "Shell|Read|Write|StrReplace";

interface GrokHomeProjectionOptions {
  homeDir?: string;
  somaRepoPath?: string;
  grokHome?: string;
}

/**
 * Runtime config read by soma-lifecycle.mjs from its colocated
 * soma-lifecycle.config.json (same shape as codexLifecycleConfig, plus
 * the absolute `grokHome`/`startupContextPath` pair — the hook must not
 * derive paths from `process.env.HOME`, which is unset on stock
 * Windows). bunPath stays explicit for detached-survival of the
 * feedback child (soma#73/#75).
 */
function grokLifecycleConfig(
  somaHome: string,
  grokHome: string,
  homeDir?: string,
  somaRepoPath = defaultSomaRepoPath(),
): {
  somaHome: string;
  trustedSomaRepo: string;
  bunPath: string;
  grokHome: string;
  startupContextPath: string;
  privateRoots: string[];
  policyMarkers: string[];
  inboundSecurity: {
    untrustedRoots: string[];
    traceRoot: string;
  };
} {
  const privateRoots = [
    ...somaProjectionPrivateRoots({ homeDir, substrate: "grok" }),
    ...somaMemoryPrivateRoots({ homeDir, substrate: "grok" }),
  ].map((path) => resolve(path));
  const policyMarkers = somaPolicyPrivateMarkers(somaHome, homeDir, privateRoots);
  return {
    somaHome,
    trustedSomaRepo: somaRepoPath,
    bunPath: resolveBunExecutable(),
    grokHome,
    startupContextPath: GROK_STARTUP_CONTEXT_PATH,
    privateRoots,
    policyMarkers,
    inboundSecurity: defaultInboundContentSecurityConfig({ somaHome }),
  };
}

/**
 * KTD-2 guard: every hook command must stay on Grok's direct-exec fast
 * path. Anything containing a shell metacharacter is routed through
 * `sh -c` — a Git Bash dependency on Windows — and a leading `~` never
 * expands in a bare-exec spawn. Only a token-initial tilde is rejected:
 * Windows 8.3 short names (`KYLELI~1`) carry interior tildes that are
 * perfectly valid bare-exec path bytes. Verified live (U1 gate 3): the
 * bare `<bunPath> <abs>.mjs <verb>` shape spawns directly on Windows.
 */
function assertGrokSafeHookCommand(command: string): string {
  if (command.split(" ").some((token) => token.startsWith("~")) || /[|&;$<>[\]]/.test(command)) {
    throw new Error(`Grok hook command must be bare-exec safe (no shell metacharacters, no tilde paths): ${command}`);
  }
  return command;
}

function grokHookCommand(grokHome: string, bunPath: string, verb: string): string {
  return assertGrokSafeHookCommand([bunPath, join(grokHome, "hooks", "soma-lifecycle.mjs"), verb].join(" "));
}

// Grok's default hook timeout is 5s — too tight for the `bun run soma`
// lifecycle shell-outs, so every hook pins its own.
const GROK_HOOK_TIMEOUT_SECONDS = 30;

/**
 * The hook registration file (`~/.grok/hooks/soma-lifecycle.json`).
 * Grok-verified constraints (U1 + shipped hooks doc):
 *   - lifecycle events (SessionStart, UserPromptSubmit, Stop,
 *     SessionEnd) REJECT a `matcher`; only tool events take one.
 *   - SessionEnd never fired in the U1 probes (headless exit, ACP
 *     disconnect); it is registered best-effort alongside Stop, and
 *     nothing load-bearing hangs on either.
 *   - PreToolUse policy enforcement is deliberately absent until U9.
 */
function renderGrokHooksJson(grokHome: string, bunPath: string): string {
  const hook = (verb: string) => ({
    type: "command",
    command: grokHookCommand(grokHome, bunPath, verb),
    timeout: GROK_HOOK_TIMEOUT_SECONDS,
  });

  return `${JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [hook("session-start")] }],
        UserPromptSubmit: [{ hooks: [hook("prompt-submit")] }],
        // U9 (R7): fail-closed policy enforcement — the only blocking
        // event grok has. Deny shape {"decision":"deny"} on stdout is
        // honored regardless of exit code (U1 gate 1); --yolo does not
        // bypass it.
        PreToolUse: [{ matcher: GROK_PRE_TOOL_USE_MATCHER, hooks: [hook("pre-tool-use")] }],
        PostToolUse: [{ matcher: GROK_ALGORITHM_UPDATED_MATCHER, hooks: [hook("algorithm-updated")] }],
        // U8 (R6): compaction refresh — persist Algorithm state before
        // the context cut, re-point the model at the projected startup
        // context after it. Matcher-less like the other lifecycle events
        // (PreCompact/PostCompact are binary-verified event names in
        // grok 0.2.38).
        PreCompact: [{ hooks: [hook("pre-compact")] }],
        PostCompact: [{ hooks: [hook("post-compact")] }],
        Stop: [{ hooks: [hook("session-end")] }],
        SessionEnd: [{ hooks: [hook("session-end")] }],
      },
    },
    null,
    2,
  )}\n`;
}

function renderGrokFeedbackHook(): string {
  return renderFeedbackHookModule({
    functionName: "runSomaFeedbackCapture",
    leadingParameters: ["config"],
    promptParameter: "prompt",
    // soma#73: spawn with the explicit resolved bun binary, never
    // process.execPath — the detached feedback child must survive the
    // hook parent's process.exit().
    bunPathExpression: "config.bunPath",
    cwdExpression: "config.trustedSomaRepo",
    somaHomeExpression: "config.somaHome",
    substrate: "grok",
    source: "prompt-submit",
    failureComment: "Feedback capture is best-effort and must never break prompt classification.",
  });
}

interface GrokHookEntryExtension {
  importLine: string;
  fallbackStartMarker: string;
  fallbackEndMarker: string;
}

function applyGrokHookEntryExtensions(source: string, extensions: GrokHookEntryExtension[]): string {
  const importMarker = "// __SOMA_HOOK_MODULE_IMPORTS__";
  if (!source.includes(importMarker)) {
    throw new Error("Grok hook entry is missing the Soma hook module import marker.");
  }

  const imports = extensions.map((extension) => extension.importLine).join("\n");
  let rendered = source.replace(importMarker, imports);
  for (const extension of extensions) {
    const fallbackStart = rendered.indexOf(extension.fallbackStartMarker);
    const fallbackEnd = rendered.indexOf(extension.fallbackEndMarker);
    if (fallbackStart === -1 || fallbackEnd === -1 || fallbackEnd < fallbackStart) {
      throw new Error("Grok hook entry is missing a Soma hook extension fallback marker.");
    }
    rendered = `${rendered.slice(0, fallbackStart)}${rendered.slice(fallbackEnd + extension.fallbackEndMarker.length)}`;
  }
  return rendered;
}

function renderGrokHookEntry(): string {
  return applyGrokHookEntryExtensions(readGrokHookAsset("grok-hook-entry.mjs"), [
    {
      importLine: 'import { runSomaFeedbackCapture } from "./soma-feedback-capture.mjs";',
      fallbackStartMarker: "// __SOMA_PROMPT_SUBMIT_EXTENSION_START__",
      fallbackEndMarker: "// __SOMA_PROMPT_SUBMIT_EXTENSION_END__",
    },
  ]);
}

function renderInstructions(input: ProjectionInput): string {
  return renderSubstrateInstructions({ substrate: "Grok", runtimeLabel: "the Grok CLI" }, input);
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
 * Entry skill for the home projection. `~/.grok/skills/<name>/SKILL.md` is
 * one of the two verified auto-loaded home surfaces (KTD-4a), so this
 * file carries the discovery frontmatter plus the use rules; the bulk
 * context lives in the colocated companion files it points at.
 */
function renderGrokHomeSkill(input: ProjectionInput, somaHome: string): string {
  return [
    "---",
    "name: soma",
    "description: Use when work depends on portable personal assistant context, Soma identity, telos, ISA criteria, memory layout, skills, policy, or default assistant behavior across substrates.",
    "metadata:",
    "  short-description: Portable personal assistant context",
    "---",
    "",
    "# Soma",
    "",
    "Soma is the portable personal assistant core. It keeps assistant identity, principal context, telos, memory, skills, policy, and ISA semantics outside any one substrate.",
    "",
    `Source of truth: ${somaHome}`,
    "",
    "## Use",
    "",
    "- Read `~/.grok/skills/soma/context.md` for the full projected assistant context.",
    "- Read `~/.grok/skills/soma/memory-layout.md` before using persistent memory.",
    "- Read `~/.grok/skills/soma/skills.md` for the declared Soma skills.",
    "- Read `~/.grok/skills/soma/policy.md` for the substrate policy projection.",
    "- Read `~/.grok/skills/soma/active-isa.md` for the active ISA verification contract when that file is present.",
    "- Read `~/.grok/skills/soma/startup-context.md` for lifecycle-generated active work and recent learning context when present; the Soma session-start hook refreshes it.",
    "- Use the `the-algorithm` skill when work should run through Soma Algorithm mode.",
    "- Treat project-local `.grok/rules/soma/` context as an overlay on this home projection.",
    "- Do not assume a global `soma` binary exists; run `bun run soma ...` from the Soma repo.",
    "",
    "This projection is generated from Soma. Author changes in the Soma home and rerun `soma install grok --apply`.",
    "",
    "## Current Projection",
    "",
    renderAssistantCore(input),
  ].join("\n");
}

function renderGrokRulesReadme(): string {
  return [
    "# Soma Grok Projection",
    "",
    "This directory is generated by Soma. The portable source of truth is the Soma home.",
    "",
    "Grok auto-discovers project rules under `.grok/rules/` (walked from the working directory to the repo root, regardless of project trust), so this overlay loads as project context. It is context-only by design: hooks and policy are installed at user scope (`~/.grok/`), never from a repo.",
    "",
    "## Files",
    "",
    "- `context.md` — assistant identity, principal, telos, and operating rules",
    "- `memory-layout.md` — pointers into the Soma memory tree",
    "- `skills.md` — discovered Soma skills",
    "- `policy.md` — substrate policy projection",
    "",
    "Do not edit these files by hand; rerun `soma install grok --apply` after changing Soma source context.",
  ].join("\n");
}

/**
 * Workspace projection (`soma project grok` / project overlays). Files
 * land under `<repo>/.grok/rules/soma/`, the project-scoped rules dir
 * Grok auto-discovers regardless of trust (KTD-4a) — unlike the home
 * `~/.grok/rules/` dir, which Grok never loads. Context-only: no hooks
 * or policy assets ever ship at project scope (KTD-4).
 */
export function projectGrok(input: ProjectionInput): Projection {
  const instructions = renderInstructions(input);

  return {
    substrate: "grok",
    instructions,
    files: [
      { path: ".grok/rules/soma/README.md", content: renderGrokRulesReadme() },
      { path: ".grok/rules/soma/context.md", content: instructions },
      { path: ".grok/rules/soma/memory-layout.md", content: renderMemoryLayout(input) },
      { path: ".grok/rules/soma/skills.md", content: renderSkills(input) },
      { path: ".grok/rules/soma/policy.md", content: renderGrokPolicy() },
    ],
  };
}

/**
 * Home projection (`soma install grok`). Files are relative to the Grok
 * home (`~/.grok`) and route through the two verified auto-loaded
 * discovery surfaces (KTD-4a): the `skills/soma/` entry skill rendered
 * here, and the `AGENTS.md` pointer block patched post-projection by
 * `configureGrokAgentsPointer`.
 */
export function projectGrokHome(input: ProjectionInput, somaHome: string, options: GrokHomeProjectionOptions = {}): Projection {
  const instructions = renderInstructions(input);
  // The hook surface needs install-time absolutes (KTD-2: bare-exec
  // commands carry no tilde, and the hook runtime derives nothing from
  // env). `grokHome` honors a substrateHome override when the caller
  // (buildGrokHomeProjection) resolves one.
  const grokHome = options.grokHome ?? grokHomeDir(options.homeDir);
  const somaRepoPath = options.somaRepoPath ?? defaultSomaRepoPath();
  const bunPath = resolveBunExecutable();
  // Portable Soma skills project through the default substrate rewrite
  // (Claude memory roots -> Soma memory, Claude-only lines stripped) —
  // grok deliberately takes the default-rewrite branch, same as codex.
  const portableSkillFiles = input.profile.skills.flatMap((skill) =>
    (skill.files ?? []).map((file) => ({
      path: `skills/${skill.name}/${file.path}`,
      content: rewriteSubstrateProjectionContent({
        substrate: "grok",
        path: file.path,
        content: file.content,
      }),
    })),
  );

  return {
    substrate: "grok",
    instructions,
    files: [
      { path: "skills/soma/SKILL.md", content: renderGrokHomeSkill(input, somaHome) },
      { path: "skills/soma/context.md", content: instructions },
      { path: "skills/soma/memory-layout.md", content: renderMemoryLayout(input) },
      { path: "skills/soma/skills.md", content: renderSkills(input) },
      { path: "skills/soma/policy.md", content: renderGrokPolicy() },
      { path: "hooks/soma-lifecycle.json", content: renderGrokHooksJson(grokHome, bunPath) },
      // Shipped verbatim; the install-time facts live in the colocated
      // config (same split as codex, soma#73). executable:true is
      // harmless POSIX parity — Grok invokes via the explicit bunPath.
      { path: "hooks/soma-lifecycle.mjs", content: readGrokHookAsset("soma-lifecycle.mjs"), executable: true },
      {
        path: "hooks/soma-lifecycle.config.json",
        content: `${JSON.stringify(grokLifecycleConfig(somaHome, grokHome, options.homeDir, somaRepoPath), null, 2)}\n`,
      },
      { path: "hooks/grok-hook-entry.mjs", content: renderGrokHookEntry() },
      // U9: the policy-target extractor and its marker matcher ship
      // verbatim beside the dispatcher (same colocated-module model as
      // codex's policy assets).
      { path: "hooks/grok-policy-targets.mjs", content: readGrokHookAsset("grok-policy-targets.mjs") },
      { path: "hooks/policy-marker.mjs", content: readGrokHookAsset("policy-marker.mjs") },
      { path: "hooks/soma-feedback-capture.mjs", content: renderGrokFeedbackHook() },
      ...portableSkillFiles,
      // After the portable skills on purpose: when `the-algorithm` is
      // imported as a portable skill, the static rendering contract
      // overwrites its SKILL.md while Workflows/references ship through
      // (same ordering contract as projectCodexHome).
      { path: "skills/the-algorithm/SKILL.md", content: renderAlgorithmRenderingContract("Grok") },
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
