import { installCodexHomeProjection } from "./home-projection";
import { bootstrapSomaHome } from "./soma-home";
import type { SomaInstallOptions, SomaInstallResult } from "./types";

export async function installSomaForCodex(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  const somaHome = await bootstrapSomaHome(options);
  const substrateHome = await installCodexHomeProjection(somaHome.context, {
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    substrateHome: options.substrateHome,
  });

  return {
    substrate: "codex",
    somaHome,
    substrateHome,
  };
}
