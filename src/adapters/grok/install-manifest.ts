import { createHash } from "node:crypto";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isEnoent } from "../../fs-errors";

/**
 * U6 follow-up: portable Soma skills project under dynamic
 * `skills/<name>/` paths, so the static uninstall `remove` list cannot
 * name them. Install records what it wrote — paths plus content hashes —
 * in a manifest on the SOMA side (`<somaHome>/projections/grok/`), and
 * uninstall consumes it to round-trip the portable skills too.
 *
 * The manifest lives outside the Grok home on purpose: every Soma-owned
 * directory under `~/.grok` is itself removed during uninstall, and
 * `postRemove` (the only dynamic uninstall hook) runs after those
 * removals — a manifest stored among them would already be gone.
 */
export const GROK_INSTALL_MANIFEST_SCHEMA = "soma-grok-install-manifest-v1";

export interface GrokInstallManifest {
  schema: typeof GROK_INSTALL_MANIFEST_SCHEMA;
  /** Absolute substrate home the manifest describes — uninstall ignores the manifest when homes differ. */
  substrateHome: string;
  files: { path: string; sha256: string }[];
}

export function grokInstallManifestPath(somaHome: string): string {
  return join(somaHome, "projections", "grok", "install-manifest.json");
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function writeGrokInstallManifest(options: {
  somaHome: string;
  substrateHome: string;
  files: readonly { path: string; content: string }[];
}): Promise<string> {
  const manifest: GrokInstallManifest = {
    schema: GROK_INSTALL_MANIFEST_SCHEMA,
    substrateHome: resolve(options.substrateHome),
    // writeProjection writes bundle content verbatim, so hashing the
    // bundle content here equals hashing the on-disk bytes.
    files: options.files.map((file) => ({ path: file.path, sha256: contentHash(file.content) })),
  };
  const path = grokInstallManifestPath(options.somaHome);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

function parseManifest(raw: string): GrokInstallManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schema !== GROK_INSTALL_MANIFEST_SCHEMA || typeof record.substrateHome !== "string" || !Array.isArray(record.files)) {
    return null;
  }
  const files = record.files.filter(
    (entry): entry is { path: string; sha256: string } =>
      typeof entry === "object" && entry !== null &&
      typeof (entry as Record<string, unknown>).path === "string" &&
      typeof (entry as Record<string, unknown>).sha256 === "string",
  );
  return { schema: GROK_INSTALL_MANIFEST_SCHEMA, substrateHome: record.substrateHome, files };
}

function isInsideRoot(root: string, target: string): boolean {
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target !== root && target.startsWith(rootPrefix);
}

/**
 * Remove the manifest-listed portable-skill files from the substrate
 * home, then consume the manifest. Safety properties, in order:
 *   - no manifest / malformed manifest → no-op (pre-manifest installs).
 *   - manifest for a DIFFERENT substrate home → no-op, manifest kept
 *     (e.g. a workspace uninstall must not consume the home install's
 *     record — the U6 incident lesson, generalized).
 *   - a listed path resolving outside the substrate home (tampered
 *     manifest) → skipped.
 *   - on-disk bytes differing from the install-time hash (user-edited
 *     file) → preserved, mirroring the local-edits-preserved contract.
 *   - user files ADDED inside a portable skill dir survive: only listed
 *     files are removed, and emptied directories are pruned with a
 *     non-recursive rmdir that fails closed on ENOTEMPTY.
 */
export async function removeGrokPortableSkillProjection(options: {
  somaHome: string;
  substrateHome: string;
}): Promise<string[]> {
  const manifestPath = grokInstallManifestPath(options.somaHome);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const manifest = parseManifest(raw);
  if (manifest === null) return [];
  const substrateHome = resolve(options.substrateHome);
  if (resolve(manifest.substrateHome) !== substrateHome) return [];

  const removed: string[] = [];
  const candidateDirs = new Set<string>();
  for (const file of manifest.files) {
    const target = resolve(substrateHome, file.path);
    if (!isInsideRoot(substrateHome, target)) continue;
    let content: string;
    try {
      content = await readFile(target, "utf8");
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    if (contentHash(content) !== file.sha256) continue;
    await rm(target, { force: true });
    removed.push(target);
    for (let dir = dirname(target); isInsideRoot(substrateHome, dir); dir = dirname(dir)) {
      candidateDirs.add(dir);
    }
  }

  // Deepest-first so nested dirs empty out before their parents.
  for (const dir of [...candidateDirs].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(dir);
      removed.push(dir);
    } catch {
      // ENOTEMPTY (user content), ENOENT, or anything else: keep the dir.
    }
  }

  await rm(manifestPath, { force: true });
  removed.push(manifestPath);
  return removed;
}
