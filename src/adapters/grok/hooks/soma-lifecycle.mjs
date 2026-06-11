#!/usr/bin/env bun
// Grok lifecycle hook entry (U7), shipped verbatim — no install-time
// string templating. The install-time facts live in the colocated
// soma-lifecycle.config.json (somaHome, trustedSomaRepo, bunPath,
// grokHome, startupContextPath, privateRoots, policyMarkers,
// inboundSecurity).
//
// Runtime contract (KTD-2): Grok spawns this file bare-exec as
// `<bunPath> <abs path to this file> <verb>` — explicit runtime and
// absolute paths, because Windows ignores shebangs and NTFS ignores the
// executable bit. The shebang stays for POSIX manual runs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runGrokHook } from "./grok-hook-entry.mjs";
import { GROK_PRE_TOOL_USE_VERB } from "./grok-hook-verbs.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// HR5 (R7b hardening): the config load is the hook's bootstrap, and it runs
// BEFORE runGrokHook's deny backstop. Grok's platform fails OPEN, so a bare
// throw here (missing / unreadable / corrupt config) crashes the process
// and the tool call is ALLOWED. For the enforcing pre-tool-use verb that is
// an egress hole — and self-inducible, since the config lives in
// unprotected ~/.grok/hooks/, so a misaligned model could delete it to
// disable the gate and then egress freely. A config-load failure on
// pre-tool-use must therefore fail CLOSED with the documented deny shape
// (deny payload + exit 2; KTD-3: deny is honored regardless of exit code).
// Non-enforcing verbs keep today's behavior — a config problem there is not
// a security boundary.
let config;
try {
  config = JSON.parse(readFileSync(join(here, "soma-lifecycle.config.json"), "utf8"));
} catch (error) {
  if (process.argv[2] === GROK_PRE_TOOL_USE_VERB) {
    console.log(JSON.stringify({ decision: "deny", reason: "Soma policy hook config unavailable — failing closed" }));
    process.exit(2);
  }
  throw error;
}
runGrokHook(config);
