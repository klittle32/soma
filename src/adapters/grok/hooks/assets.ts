import { readFileSync } from "node:fs";

export function readGrokHookAsset(name: "grok-hook-entry.mjs" | "soma-lifecycle.mjs"): string {
  const assetUrl = new URL(`./${name}`, import.meta.url);

  return readFileSync(assetUrl, "utf8");
}
