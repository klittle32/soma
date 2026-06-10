export {
  projectGrok,
  projectGrokHome,
  grokAdapter,
  GROK_ALGORITHM_UPDATED_MATCHER,
  GROK_STARTUP_CONTEXT_PATH,
  GROK_SOMA_REPO_POINTER_PATH,
} from "./adapter";
export {
  configureGrokAgentsPointer,
  configureGrokConfigPatch,
  removeAgentsImportBlock,
  removeConfigPatchBlock,
  GROK_AGENTS_BLOCK_BEGIN,
  GROK_AGENTS_BLOCK_END,
  GROK_CONFIG_BLOCK_BEGIN,
  GROK_CONFIG_BLOCK_END,
} from "./config-patch";
