// Grok lifecycle dispatcher (U7), ported from codex-hook-entry.mjs with
// the Grok-specific deltas verified live on 2026-06-10 (U1 gates + the
// tool-name enumeration probe, grok 0.2.38):
//   - payload keys are camelCase (`sessionId`, `toolName`, `toolInput`)
//     with snake_case event values (`session_start`); the snake_case
//     codex aliases are still read for safety.
//   - `GROK_SESSION_ID` is injected on every hook process and equals the
//     ACP sessionId; hook cardinality is per-session, so session-start
//     dedups behind a first-writer-wins guard keyed on it.
//   - Grok 0.2.38 ignores passive-hook stdout, so the projected
//     startup-context.md (pointed at by the `soma` skill) is the
//     load-bearing context surface; the JSON emitted here is the tested
//     contract and works unchanged if Grok adopts Claude-shaped output.
//   - The policy chain (PreToolUse fail-closed deny) lands in U9; this
//     dispatcher only handles the passive lifecycle verbs.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// __SOMA_HOOK_MODULE_IMPORTS__

// __SOMA_PROMPT_SUBMIT_EXTENSION_START__
function runSomaFeedbackCapture(config, prompt) {
  void config;
  void prompt;
}
// __SOMA_PROMPT_SUBMIT_EXTENSION_END__

const STALE_SESSION_GUARD_MS = 7 * 24 * 60 * 60 * 1000;

function readHookInput() {
  try {
    const parsed = JSON.parse(readFileSync(0, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { __somaParseError: "hook input must be a JSON object" };
    }
    return parsed;
  } catch (error) {
    return { __somaParseError: error instanceof Error ? error.message : String(error) };
  }
}

function hookSessionId(input) {
  const candidate = input.sessionId || input.session_id || process.env.GROK_SESSION_ID;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function runSomaCommand(config, args, env = {}) {
  return spawnSync(config.bunPath, args, {
    cwd: config.trustedSomaRepo,
    encoding: "utf8",
    timeout: 25000,
    env: { ...process.env, ...env },
  });
}

function runSomaLifecycle(config, event, sessionId) {
  const args = ["run", "soma", "lifecycle", event, "--soma-home", config.somaHome, "--substrate", "grok"];
  if (sessionId) {
    args.push("--session-id", sessionId);
  }

  return runSomaCommand(config, args);
}

function runSomaClassification(config, prompt) {
  return runSomaCommand(config, ["run", "soma", "algorithm", "classify", "--prompt", prompt || "", "--json"]);
}

function emitAndExit(payload) {
  console.log(JSON.stringify(payload));
  process.exit(0);
}

function parseClassification(output) {
  try {
    return JSON.parse(output);
  } catch {
    // Fall through for older Soma CLIs that render key-value text.
  }

  const fields = {};
  for (const line of output.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator === -1) continue;
    fields[line.slice(0, separator)] = line.slice(separator + 2).trim();
  }
  return fields;
}

function shouldPrimeAlgorithmRendering(classification) {
  const mode = (classification.mode || "").toLowerCase();
  return mode === "algorithm" && classification.effort && classification.effort !== "E1" && classification.effort !== "none";
}

function algorithmPromptHookOutput(classification) {
  const mode = (classification.mode || "algorithm").toUpperCase();
  const effort = classification.effort && classification.effort !== "none" ? classification.effort : "";
  const source = classification.source || "unknown";
  const label = effort ? `${mode} ${effort}` : mode;

  if (!shouldPrimeAlgorithmRendering(classification)) {
    return { continue: true };
  }

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: [
        `Soma: ${label} (${source}). This prompt classified as ALGORITHM.`,
        "Use the seven-phase rendering contract from `~/.grok/skills/the-algorithm/SKILL.md`.",
        "Emit each phase banner verbatim before producing that phase's content.",
      ].join("\n"),
    },
  };
}

function projectedStartupContextPath(config) {
  // Absolute via the install-time grokHome — never process.env.HOME,
  // which is unset on stock Windows.
  return join(config.grokHome, config.startupContextPath);
}

function writeProjectedStartupContext(config, output) {
  const marker = "# Soma Startup Context";
  const index = output.indexOf(marker);
  if (index === -1) return undefined;
  const context = output.slice(index).trim();
  writeFileSync(projectedStartupContextPath(config), `${context}\n`, "utf8");
  return context;
}

function readProjectedStartupContext(config) {
  try {
    return readFileSync(projectedStartupContextPath(config), "utf8").trim();
  } catch {
    return undefined;
  }
}

export function renderStartupContextSummary(context) {
  if (!context) return "Soma: startup context unavailable; read the projected Soma startup context when needed.";
  const assistant = context.match(/^Assistant:\s*(.+)$/m)?.[1]?.trim();
  const principal = context.match(/^Principal:\s*(.+)$/m)?.[1]?.trim();
  const activeRunsSection = context.match(/(?:^|\n)## Active Algorithm Runs\n(?<section>[\s\S]*?)(?=\n## |$)/)?.groups?.section ?? "";
  const activeRuns = [...activeRunsSection.matchAll(/^- [^\n]+$/gm)].length;
  const identity = assistant && principal ? `${assistant} for ${principal}` : assistant || "startup context";
  const runText = activeRuns === 1 ? "1 active run" : `${activeRuns} active runs`;
  return `Soma: ${identity}; ${runText}. Full context is in the projected startup-context.md.`;
}

function pruneStaleSessionGuards(guardDir) {
  try {
    for (const name of readdirSync(guardDir)) {
      const path = join(guardDir, name);
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_SESSION_GUARD_MS) unlinkSync(path);
      } catch {
        // Best-effort pruning; a contested file just waits for next time.
      }
    }
  } catch {
    // Unreadable guard dir falls through to the mkdir below.
  }
}

/**
 * First-writer-wins session-start guard keyed on the Grok session id
 * (U1 gate 2: SessionStart fires once per session even under a shared
 * leader, so the session id is the dedup unit). Returns true when this
 * process owns the session-start body. Guard failures other than
 * "already claimed" run the body anyway: a duplicated session-start is
 * benign, a silently skipped one loses the context load.
 */
function acquireSessionStartGuard(config, sessionId) {
  if (!sessionId) return true;
  try {
    const guardDir = join(config.somaHome, "memory", "STATE", "grok-session-guards");
    mkdirSync(guardDir, { recursive: true });
    pruneStaleSessionGuards(guardDir);
    const guardPath = join(guardDir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
    writeFileSync(guardPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") return false;
    return true;
  }
}

function handlePromptSubmit(config, input) {
  runSomaFeedbackCapture(config, input.prompt);
  const result = runSomaClassification(config, input.prompt);
  if (result.status !== 0) {
    emitAndExit({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `Soma prompt classification failed; if this prompt is substantial, use the-algorithm manually. ${result.stderr || result.stdout || ""}`,
      },
    });
  }
  emitAndExit(algorithmPromptHookOutput(parseClassification(result.stdout)));
}

function handleLifecycleEvent(config, event, input) {
  const sessionId = hookSessionId(input);
  if (event === "session-start" && !acquireSessionStartGuard(config, sessionId)) {
    emitAndExit({ continue: true, systemMessage: `Soma session-start already handled for session ${sessionId}.` });
  }

  const result = runSomaLifecycle(config, event, sessionId);

  if (result.status !== 0) {
    if (event === "session-start") {
      const context = readProjectedStartupContext(config);
      emitAndExit({
        continue: true,
        systemMessage: "Soma lifecycle hook fell back to projected startup context.",
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: renderStartupContextSummary(context),
        },
      });
    }

    emitAndExit({ continue: true, systemMessage: `Soma lifecycle hook failed for ${event}; read projected Soma context when needed.` });
  }

  if (event === "session-start") {
    const context = writeProjectedStartupContext(config, result.stdout) || readProjectedStartupContext(config);
    emitAndExit({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: renderStartupContextSummary(context || result.stdout),
      },
    });
  }

  emitAndExit({ continue: true, systemMessage: `Soma lifecycle ${event} handled.` });
}

export function runGrokHook(config, event = process.argv[2], input = readHookInput()) {
  if (event === "prompt-submit") {
    handlePromptSubmit(config, input);
  } else if (event === "session-start" || event === "algorithm-updated" || event === "session-end") {
    handleLifecycleEvent(config, event, input);
  }

  console.log(JSON.stringify({ continue: true }));
}
