# Memory And Policy V0

Soma should not solve rich memory and cross-substrate enforcement at the same
time. Version 0 uses a small file-based memory contract and explicit policy
projection.

## Memory V0

Memory is a directory layout, not a database:

```text
MEMORY/
  WORK/
  KNOWLEDGE/
  LEARNING/
  RELATIONSHIP/
  STATE/
```

The initial portable operations are:

- read named files
- search text with deterministic tooling
- summarize selected files into substrate context
- append learning notes through explicit tools or patches

Vector search, long-running recall daemons, and automatic consolidation are
later layers. They must preserve the file contract.

## Policy V0

Policy has two layers:

1. Deterministic checks where the substrate exposes controls.
2. Rendered instructions where deterministic enforcement is not available.

Adapters must state which policies are enforceable and which are advisory. A
substrate with weaker controls is allowed, but the bundle must make that
weakness visible.

## Verification V0

Every task-facing ISA should include verification criteria. Adapters can add
substrate-native verification commands, but they must not replace the ISA as
the source of truth for done.
