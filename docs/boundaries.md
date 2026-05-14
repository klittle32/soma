# Ownership Boundaries

Soma is the portable personal assistant kernel. It should reference nearby Meta
Factory systems without absorbing their responsibilities.

## Source Of Truth

| Concept | Source of truth | Soma role |
| --- | --- | --- |
| Personal assistant identity | Soma | Owns portable identity schema and context rendering. |
| Principal profile | Soma | Owns personal profile shape and substrate-safe projection. |
| Telos | Soma | Owns personal goals, principles, commitments, and prioritization context. |
| Project ISA | Project repository | Reads and summarizes local `ISA.md`; does not centralize every project task. |
| Personal/task ISA | Soma memory | Owns personal assistant tasks that do not belong to one project repo. |
| Skills as portable capability folders | Soma | Owns portable skill metadata and discovery contract. |
| Claude Code skills | Claude Code adapter | Projection of Soma skills into Claude-native layout. |
| Codex instructions | Codex adapter | Projection of Soma context into Codex-readable files. |
| SOPs and governance | Compass | Soma references Compass rules; it does not redefine org process. |
| Daemon, bus, and envelopes | Cortex / Myelin | Soma can run as an agent, but Myelin owns protocol semantics. |
| Installation and distribution | Arc | Soma ships manifests; Arc owns package lifecycle. |
| Observability | Signal | Soma emits events; Signal owns telemetry systems. |
| Isolated execution | Spawn | Soma requests execution; Spawn owns sandbox lifecycle. |

## Boundary Rules

- Soma owns portable personal assistant concepts.
- Adapters own substrate translation only.
- Nearby systems own ecosystem-level mechanics.
- A duplicated concept must declare one source of truth and one or more
  projections.
- A projection can cache, summarize, or render source data, but it must not
  become an independent editing surface without a sync contract.

## Naming Rules

Use `Skill` in Soma only for portable capability folders. When referring to a
substrate-specific skill system, qualify it:

- `Soma skill`
- `Claude Code skill projection`
- `Codex instruction projection`
- `Compass SOP`

If a capability is only meaningful inside one substrate, it belongs in that
adapter and should not be named a Soma skill.
