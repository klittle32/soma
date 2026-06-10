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

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "soma-lifecycle.config.json"), "utf8"));
runGrokHook(config);
