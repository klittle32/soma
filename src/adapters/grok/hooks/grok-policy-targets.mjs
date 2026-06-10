// Grok policy-target extraction (U9), ported from codex-policy-targets.mjs
// with the Grok deltas:
//   - The tool-event normalizer reads Grok's verified runtime shape
//     (2026-06-10-003 enumeration table): camelCase `toolName`/`toolInput`,
//     input keys `path`/`contents`/`new_string` — NOT claude's
//     `file_path`/`content`. The snake_case codex aliases stay as
//     fallbacks for safety.
//   - Extractors are keyed by the verified PascalCase tool names the
//     PreToolUse matcher admits (Shell|Read|Write|StrReplace). New tools
//     must be enumerated live before they are added (the docs' alias
//     table is inverted from reality).
//   - Private-root matching is Windows-aware: absolute policy markers on
//     this adapter's primary platform look like `C:\Users\...`, so root
//     detection uses isAbsolute() and prefix comparisons normalize
//     separators (the codex `startsWith("/")` test never matches them).
//   - Known gap (same class as codex): shell parsing understands POSIX
//     command shapes (rm/mv/cp/tee/redirects, sh -c nesting), not
//     PowerShell-native cmdlets (Remove-Item). The marker string-match
//     still catches private paths in any command text; the runtime
//     policy inspection runs regardless of parseability.
import { isAbsolute, resolve } from "node:path";
import { hasSomaPolicyPrivateMarker } from "./policy-marker.mjs";

function hasSomaPolicyMarker(config, content) {
  return config.policyMarkers.some((marker) => hasSomaPolicyPrivateMarker(content, marker));
}

function lastSeparatorIndex(value) {
  return Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
}

function hasPotentialPrivateSourceReference(config, content) {
  if (!content) return false;
  if (hasSomaPolicyMarker(config, content)) return true;
  return config.policyMarkers.some((marker) => isAbsolute(marker) && content.includes(marker.slice(lastSeparatorIndex(marker))));
}

function policyRelevantContent(config, content) {
  if (!hasSomaPolicyMarker(config, content)) return "";
  return (content || "")
    .split("\n")
    .filter((line) => hasSomaPolicyMarker(config, line))
    .join("\n");
}

function normalizeSeparators(path) {
  return path.replace(/\\/g, "/");
}

function isUnderRoot(path, root) {
  const normalizedPath = normalizeSeparators(path);
  const normalizedRoot = normalizeSeparators(root).replace(/\/+$/, "");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function resolveToolPath(path, cwd) {
  return isAbsolute(path) ? path : resolve(cwd || process.cwd(), path);
}

function somaHomeParent(config) {
  const home = normalizeSeparators(config.somaHome);
  return home.endsWith("/.soma") ? config.somaHome.slice(0, -"/.soma".length) : process.env.HOME || process.env.USERPROFILE || "";
}

function resolveShellPath(config, path, cwd) {
  if (path.startsWith("~/.soma")) {
    return `${config.somaHome}${path.slice("~/.soma".length)}`;
  }

  const home = somaHomeParent(config);
  if (home && path.startsWith("$HOME/")) {
    return `${home}/${path.slice("$HOME/".length)}`;
  }
  if (home && path.startsWith("${HOME}/")) {
    return `${home}/${path.slice("${HOME}/".length)}`;
  }
  if (home && path.startsWith("~/")) {
    return `${home}/${path.slice(2)}`;
  }

  return path.startsWith("~/") ? path : resolveToolPath(path, cwd);
}

function cleanShellToken(token) {
  return token.replace(/^[<>"']+|[>"']+$/g, "");
}

function tokenizeShellCommand(command) {
  return [...(command || "").matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/g)].map((match) => cleanShellToken(match[1] || match[2] || match[0])).filter(Boolean);
}

function hasPrivatePathReference(config, token, cwd) {
  if (!token) return false;
  if (hasSomaPolicyMarker(config, token)) return true;
  if (token === ".soma" || token.startsWith(".soma/") || token.startsWith("./.soma/")) return true;
  if (token.startsWith(".grok/skills/soma/") || token.startsWith("./.grok/skills/soma/")) return true;
  if (token.startsWith(".codex/memories/soma/") || token.startsWith("./.codex/memories/soma/")) return true;
  if (token.startsWith(".pi/agent/soma/") || token.startsWith("./.pi/agent/soma/")) return true;
  const resolved = resolveShellPath(config, token, cwd);
  return config.policyMarkers.some((marker) => isAbsolute(marker) && isUnderRoot(resolved, resolve(marker)));
}

function isProtectedPathReference(config, token, cwd) {
  if (!token) return false;
  if (hasPrivatePathReference(config, token, cwd)) return true;
  if (token === ".grok/skills/soma" || token.startsWith(".grok/skills/soma/") || token.startsWith("./.grok/skills/soma/")) return true;
  if (token === ".codex/memories" || token.startsWith(".codex/memories/") || token.startsWith("./.codex/memories/")) return true;
  if (token === ".claude" || token.startsWith(".claude/") || token.startsWith("./.claude/")) return true;
  return false;
}

function firstPrivatePathToken(config, tokens, cwd) {
  return tokens.find((token) => hasPrivatePathReference(config, token, cwd));
}

function protectedPathTokens(config, tokens, cwd) {
  return tokens.filter((token) => isProtectedPathReference(config, token, cwd));
}

function absoluteProtectedRoots(config) {
  return Array.from(new Set(config.policyMarkers.filter((marker) => isAbsolute(marker)).map((marker) => resolve(marker))));
}

function lastPathToken(tokens) {
  return [...tokens].reverse().find((token) => token && !token.startsWith("-") && token !== "--");
}

function redirectionTarget(tokens) {
  const redirectIndex = tokens.findIndex((token) => token === ">" || token === ">>");
  if (redirectIndex !== -1) return tokens[redirectIndex + 1];
  const redirectToken = tokens.find((token) => token.startsWith(">") && token.length > 1);
  return redirectToken ? redirectToken.replace(/^>+/, "") : undefined;
}

function isShellOperator(token) {
  return token === "&&" || token === "||" || token === "|" || token === ";";
}

function shellSegments(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (isShellOperator(token)) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function shellSegmentsWithOperators(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (isShellOperator(token)) {
      if (current.length > 0) segments.push({ tokens: current, operatorAfter: token });
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segments.push({ tokens: current, operatorAfter: undefined });
  return segments;
}

function shellCommandName(token) {
  return normalizeSeparators(token || "").split("/").pop() || "";
}

function skipShellPrefixes(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(token) || ["command", "exec", "time", "nice", "nohup"].includes(token)) {
      index += 1;
      continue;
    }
    if (token === "sudo") {
      index += 1;
      while (index < tokens.length && tokens[index].startsWith("-")) {
        const option = tokens[index];
        index += 1;
        if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-T", "--command-timeout"].includes(option)) {
          index += 1;
        }
      }
      continue;
    }
    if (token === "env") {
      index += 1;
      while (index < tokens.length && (tokens[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(tokens[index]))) {
        index += 1;
      }
      continue;
    }
    break;
  }
  return index;
}

function shellPathArguments(tokens, startIndex) {
  const args = [];
  let parseFlags = true;
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (parseFlags && token === "--") {
      parseFlags = false;
      continue;
    }
    if (parseFlags && token.startsWith("-") && token.length > 1) continue;
    if (token === ">" || token === ">>") {
      i += 1;
      continue;
    }
    args.push(token);
  }
  return args;
}

function findSearchRoots(tokens, startIndex) {
  const roots = [];
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "-H" || token === "-L" || token === "-P") continue;
    if (token === "(" || token === "!" || token.startsWith("-")) break;
    roots.push(token);
  }
  return roots.length > 0 ? roots : ["."];
}

function findNamePredicates(tokens) {
  const names = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "-name" || tokens[i] === "-iname") {
      const name = tokens[i + 1];
      if (name) names.push(name);
      i += 1;
    }
  }
  return names;
}

function findDeleteParentTargets(config, segment, commandIndex, cwd) {
  const names = findNamePredicates(segment);
  const roots = absoluteProtectedRoots(config);
  const targets = [];

  for (const searchRoot of findSearchRoots(segment, commandIndex + 1)) {
    const resolvedSearchRoot = resolveShellPath(config, searchRoot, cwd);
    for (const root of roots) {
      if (root === resolvedSearchRoot || !isUnderRoot(root, resolvedSearchRoot)) continue;
      const normalizedRoot = normalizeSeparators(root);
      const basename = normalizedRoot.slice(normalizedRoot.lastIndexOf("/") + 1);
      if (names.length === 0 || names.includes(basename)) {
        targets.push(root);
      }
    }
  }

  return targets;
}

function shellPayload(tokens, commandIndex) {
  const shellOptionsWithValues = new Set(["--command-timeout"]);
  for (let i = commandIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "-c" || token === "--command") return tokens[i + 1];
    if (shellOptionsWithValues.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith("--")) continue;
    if (/^-[A-Za-z]+$/.test(token) && token.includes("c")) return tokens[i + 1];
  }
  return undefined;
}

function extractDestructiveShellTargets(config, tokens, cwd, depth = 0) {
  const destructiveTargets = [];
  for (const segment of shellSegments(tokens)) {
    const commandIndex = skipShellPrefixes(segment);
    const command = shellCommandName(segment[commandIndex]);

    if (depth < 4 && (command === "bash" || command === "sh" || command === "zsh")) {
      const payload = shellPayload(segment, commandIndex);
      if (payload) destructiveTargets.push(...extractDestructiveShellTargets(config, tokenizeShellCommand(payload), cwd, depth + 1));
      continue;
    }

    if (depth < 4 && command === "eval") {
      destructiveTargets.push(...extractDestructiveShellTargets(config, segment.slice(commandIndex + 1), cwd, depth + 1));
      continue;
    }

    if (command === "rm" || command === "rmdir" || command === "trash" || command === "trash-put" || command === "gtrash") {
      destructiveTargets.push(
        ...protectedPathTokens(config, shellPathArguments(segment, commandIndex + 1), cwd).map((token) => ({
          action: "delete",
          filePath: resolveShellPath(config, token, cwd),
          content: "",
        })),
      );
    }
    if (command === "find" && segment.includes("-delete")) {
      destructiveTargets.push(
        ...[
          ...protectedPathTokens(config, shellPathArguments(segment, commandIndex + 1), cwd).map((token) => resolveShellPath(config, token, cwd)),
          ...findDeleteParentTargets(config, segment, commandIndex, cwd),
        ].map((path) => ({
          action: "delete",
          filePath: path,
          content: "",
        })),
      );
    }
    if (command === "mv") {
      const args = shellPathArguments(segment, commandIndex + 1);
      const sourceArgs = args.length > 1 ? args.slice(0, -1) : args;
      destructiveTargets.push(
        ...protectedPathTokens(config, sourceArgs, cwd).map((token) => ({
          action: "modify",
          filePath: resolveShellPath(config, token, cwd),
          content: "",
        })),
      );
    }
  }
  return destructiveTargets;
}

function extractPrivateShellTransferTargets(config, tokens, cwd, depth = 0) {
  const transferTargets = [];
  for (const segment of shellSegments(tokens)) {
    const commandIndex = skipShellPrefixes(segment);
    const command = shellCommandName(segment[commandIndex]);

    if (depth < 4 && (command === "bash" || command === "sh" || command === "zsh")) {
      const payload = shellPayload(segment, commandIndex);
      if (payload) transferTargets.push(...extractPrivateShellTransferTargets(config, tokenizeShellCommand(payload), cwd, depth + 1));
      continue;
    }

    if (depth < 4 && command === "eval") {
      transferTargets.push(...extractPrivateShellTransferTargets(config, segment.slice(commandIndex + 1), cwd, depth + 1));
      continue;
    }

    const privateSource = firstPrivatePathToken(config, segment, cwd);
    if (!privateSource) {
      const redirectedDestination = redirectionTarget(segment);
      if (redirectedDestination) {
        const markerSource = segment.find((token) => hasPrivatePathReference(config, token, cwd));
        if (markerSource) {
          transferTargets.push({ filePath: resolveShellPath(config, redirectedDestination, cwd), sourcePath: resolveShellPath(config, markerSource, cwd), content: "" });
        }
      }
      continue;
    }

    if (command === "cp" || command === "mv" || command === "rsync") {
      const destination = lastPathToken(segment.slice(commandIndex + 1));
      if (destination && destination !== privateSource) {
        transferTargets.push({ filePath: resolveShellPath(config, destination, cwd), sourcePath: resolveShellPath(config, privateSource, cwd), content: "" });
      }
      continue;
    }

    const redirectedDestination = redirectionTarget(segment);
    if (redirectedDestination) {
      transferTargets.push({ filePath: resolveShellPath(config, redirectedDestination, cwd), sourcePath: resolveShellPath(config, privateSource, cwd), content: "" });
      continue;
    }

    if (command === "tee") {
      const destination = lastPathToken(segment.slice(commandIndex + 1));
      if (destination && destination !== privateSource) {
        transferTargets.push({ filePath: resolveShellPath(config, destination, cwd), sourcePath: resolveShellPath(config, privateSource, cwd), content: "" });
      }
    }
  }
  return transferTargets;
}

function extractPipedPrivateShellTransferTargets(config, tokens, cwd, depth = 0) {
  const transferTargets = [];
  let pipedPrivateSource;

  for (const { tokens: segment, operatorAfter } of shellSegmentsWithOperators(tokens)) {
    const commandIndex = skipShellPrefixes(segment);
    const command = shellCommandName(segment[commandIndex]);

    if (depth < 4 && (command === "bash" || command === "sh" || command === "zsh")) {
      const payload = shellPayload(segment, commandIndex);
      if (payload) transferTargets.push(...extractPipedPrivateShellTransferTargets(config, tokenizeShellCommand(payload), cwd, depth + 1));
      pipedPrivateSource = operatorAfter === "|" ? pipedPrivateSource : undefined;
      continue;
    }

    if (depth < 4 && command === "eval") {
      transferTargets.push(...extractPipedPrivateShellTransferTargets(config, segment.slice(commandIndex + 1), cwd, depth + 1));
      pipedPrivateSource = operatorAfter === "|" ? pipedPrivateSource : undefined;
      continue;
    }

    if (pipedPrivateSource && command === "tee") {
      const destination = lastPathToken(segment.slice(commandIndex + 1));
      if (destination) {
        transferTargets.push({ filePath: resolveShellPath(config, destination, cwd), sourcePath: resolveShellPath(config, pipedPrivateSource, cwd), content: "" });
      }
    }

    const privateSource = firstPrivatePathToken(config, segment, cwd);
    if (operatorAfter === "|") {
      pipedPrivateSource = privateSource || pipedPrivateSource;
    } else {
      pipedPrivateSource = undefined;
    }
  }

  return transferTargets;
}

/**
 * Normalize a Grok pre_tool_use payload into the shared invocation
 * context. Grok's verified input keys come first (`path`, `source_path`);
 * codex/claude key names stay as fallbacks so a compat-aliased payload
 * still resolves.
 */
function normalizeToolInvocation(input) {
  const toolName = input.toolName || input.tool_name || "";
  const rawToolInput = input.toolInput ?? input.tool_input;
  const toolInput = rawToolInput && typeof rawToolInput === "object" && !Array.isArray(rawToolInput) ? rawToolInput : {};
  const cwd = input.cwd || process.cwd();
  const filePath = resolveToolPath(toolInput.path || toolInput.file_path || toolInput.filePath || cwd, cwd);
  const rawSourcePath = toolInput.source_path || toolInput.sourcePath;

  return {
    toolName,
    rawToolInput,
    toolInput,
    cwd,
    filePath,
    sourcePath: rawSourcePath ? resolveToolPath(rawSourcePath, cwd) : undefined,
    command: typeof rawToolInput === "string" ? rawToolInput : toolInput.command || toolInput.cmd || "",
  };
}

function extractReadInboundContentTarget(config, context) {
  const roots = config.inboundSecurity?.untrustedRoots || [];
  return roots.some((root) => isUnderRoot(resolve(context.filePath), resolve(root))) ? [{ filePath: context.filePath }] : [];
}

function extractWriteTarget(config, context) {
  // Grok Write carries `contents` (the enumeration table), not claude's `content`.
  return [{ filePath: context.filePath, sourcePath: context.sourcePath, content: policyRelevantContent(config, context.toolInput.contents || context.toolInput.content || "") }];
}

function extractEditTarget(config, context) {
  return [{ filePath: context.filePath, sourcePath: context.sourcePath, content: policyRelevantContent(config, context.toolInput.new_string || context.toolInput.newString || "") }];
}

function extractShellTarget(config, context) {
  const tokens = tokenizeShellCommand(context.command);
  const destructiveTargets = extractDestructiveShellTargets(config, tokens, context.cwd);
  const transferTargets = extractPrivateShellTransferTargets(config, tokens, context.cwd);
  const pipedTransferTargets = extractPipedPrivateShellTransferTargets(config, tokens, context.cwd);
  return [...destructiveTargets, ...transferTargets, ...pipedTransferTargets];
}

// Verified Grok runtime tool names ONLY (2026-06-10-003). The PreToolUse
// matcher admits exactly these; enumerate live before adding more.
const targetExtractors = {
  Write: extractWriteTarget,
  StrReplace: extractEditTarget,
  Shell: extractShellTarget,
};

const inboundTargetExtractors = {
  Read: extractReadInboundContentTarget,
};

export function extractWriteTargets(config, input) {
  const context = normalizeToolInvocation(input);
  const extractor = targetExtractors[context.toolName];
  return extractor ? extractor(config, context) : [];
}

export function extractInboundContentTargets(config, input) {
  const context = normalizeToolInvocation(input);
  const extractor = inboundTargetExtractors[context.toolName];
  return extractor ? extractor(config, context) : [];
}

export function shouldCheckPolicyTarget(config, target) {
  return target.action === "delete" || target.action === "modify" || Boolean(target.sourcePath) || hasSomaPolicyMarker(config, target.content);
}
