# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Portability core

### Soma
The substrate-portable personal-AI core — identity, telos, ISA, skills, memory, policy, learning — extracted from any single host so it can be carried between execution environments. Soma is the source of truth; everything a substrate sees is a projection of it.

### Soma home
The canonical, filesystem-native store that holds Soma's source-of-truth state. Substrate homes are generated copies, never the source: edits of record happen here and flow outward through projection.

### Substrate
An execution environment Soma runs inside — typically a coding-agent CLI or editor (Codex, Claude Code, Cursor, Pi.dev, Grok). Soma is designed to be portable across substrates rather than owned by any one of them.

### Substrate adapter
The per-substrate translator that projects Soma's portable contracts into that substrate's native primitives. An adapter owns its substrate-specific install facts (file paths, projection destinations, validators, uninstall targets) but not core semantics — identity, memory, ISA, skills, and policy stay owned by Soma.

### Projection
A generated, substrate-native representation of Soma state. A substrate home is a projection, not source of truth. A *home projection* targets the substrate's user-level home so Soma is available by default; a *workspace projection* overlays a single project directory.

## Work and skills

### ISA (Ideal State Artifact)
A first-class Soma primitive that captures a unit of work as a goal plus a set of verifiable criteria; one ISA exists per project or task. The ISA defines what "done" means and is the checklist the Algorithm verifies against.

### Active ISA
The single ISA currently selected as the working context. It is recorded in Soma state and projected into each substrate so every environment shares the same current goal and criteria; byte-identical across substrates by contract.

### Portable skill
A Soma skill stored in Soma home and projected into each substrate's native skills surface. Most portable skills are projected by a generic file loop; the ISA skill is the exception — it has a dedicated, managed projection with per-substrate baseline tracking and drift detection, so it is listed alongside other skills but its files are written only by that managed installer.
