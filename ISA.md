---
task: Extract portable Personal AI Assistant core
slug: soma
effort: e3
phase: verify
progress: 14/14
mode: design
started: 2026-05-14
updated: 2026-05-14
---

## Problem

Agentic personal assistants are currently entangled with their host substrate.
PAI is deeply effective inside Claude Code because Claude Code provides hooks,
skills, context files, commands, and subagents. Pi.dev and Codex expose different
primitives. Cortex and Myelin expose a broader agent network and daemon model.

Without a substrate-neutral assistant core, each implementation repeats the same
ideas differently: identity, memory, skills, goal tracking, verification, and
learning.

## Vision

Soma becomes the portable body of a personal AI assistant. The same assistant
context can run inside Codex, Pi.dev, Claude Code, or as a Cortex/Myelin daemon.
The substrate changes; the assistant's identity, memory, goals, skills, and
work artifacts remain stable.

## Out of Scope

- Building a full dashboard in the first iteration.
- Replacing Cortex, Myelin, Arc, Signal, Spawn, or Compass.
- Reimplementing every PAI skill.
- Building a marketplace.
- Solving multi-user organizational agent routing.

## Principles

- Substrates are adapters, not the product.
- Filesystem-native state is the portability layer.
- Deterministic code owns formats, validation, and migration.
- Prompts orchestrate behavior but do not define storage contracts.
- Assistant identity is personal and portable.
- Verification belongs in the work artifact, not only in chat history.
- Cortex integration should consume Myelin contracts rather than bypass them.

## Constraints

- TypeScript and Bun for implementation.
- Keep the first version small enough to reason about.
- Do not require Claude Code-specific hooks for the core to function.
- Do not require a daemon for the library mode.
- Do not put private personal context in public templates.
- Keep all substrate-specific code behind adapter interfaces.

## Goal

Define and scaffold Soma as a substrate-portable Personal AI Assistant core with
clear boundaries, initial storage contracts, and an adapter path for Codex,
Pi.dev, Claude Code, and Cortex/Myelin.

## Criteria

- [x] ISC-1: Repository has a clear README explaining Soma's purpose.
- [x] ISC-2: ISA defines problem, vision, scope, principles, constraints, and criteria.
- [x] ISC-3: Architecture doc separates core from substrate adapters.
- [x] ISC-4: Substrate adapter doc covers Codex, Pi.dev, Claude Code, and Cortex.
- [x] ISC-5: Initial TypeScript types model identity, telos, ISA, memory, skills, and adapters.
- [x] ISC-6: Arc manifest declares Soma as a Meta Factory component.
- [x] ISC-7: Skill stub explains when an agent should use Soma.
- [x] ISC-8: Package metadata supports Bun-based development.
- [x] ISC-9: Anti: Soma does not claim to replace Cortex or Myelin.
- [x] ISC-10: Anti: Soma does not bind the core to one model provider.
- [x] ISC-11: Project layout leaves room for daemon mode without requiring it.
- [x] ISC-12: Naming rationale records why Soma was chosen.
- [x] ISC-13: Public templates contain no private identity data.
- [x] ISC-14: First implementation surface is small and testable.

## Test Strategy

| ISC | Type | Check | Tool |
| --- | --- | --- | --- |
| ISC-1 | file | README contains purpose and boundaries | read |
| ISC-2 | file | ISA contains required design sections | read |
| ISC-3 | file | architecture doc defines core/adapters | read |
| ISC-4 | file | adapter doc names four target substrates | read |
| ISC-5 | static | TypeScript compiles | bun test / tsc |
| ISC-6 | file | arc-manifest.yaml exists and parses as YAML | read |
| ISC-7 | file | skill/SKILL.md has frontmatter and workflow | read |
| ISC-8 | file | package.json has scripts | read |
| ISC-9 | content | README states non-replacement boundary | read |
| ISC-10 | content | docs avoid provider lock-in | read |
| ISC-11 | structure | src and docs separate library/daemon concepts | find |
| ISC-12 | file | docs/naming.md records rationale | read |
| ISC-13 | content | templates are generic | read |
| ISC-14 | design | first implementation is types and contracts | read |

## Features

| Name | Satisfies | Depends On | Parallelizable |
| --- | --- | --- | --- |
| Project scaffold | ISC-1, ISC-2, ISC-6, ISC-8 | none | no |
| Architecture docs | ISC-3, ISC-4, ISC-9, ISC-10, ISC-11 | scaffold | yes |
| Type contracts | ISC-5, ISC-14 | architecture | yes |
| Skill stub | ISC-7, ISC-13 | scaffold | yes |
| Naming note | ISC-12 | scaffold | yes |

## Decisions

- 2026-05-14: Chose `Soma` because it fits the neural naming stack while
  naming the assistant body rather than a substrate, surface, or bot persona.
- 2026-05-14: Started design-first. The first artifact is a portable contract,
  not a daemon.

## Changelog

- conjecture: A portable assistant core should live outside any one substrate.
  refuted-by: pending implementation experience.
  learned: Initial repository should make boundaries and contracts explicit.
  criterion-now: ISC-1 through ISC-14.

## Verification

- 2026-05-14: `bun test` passed with 2 tests across 1 file.
- 2026-05-14: `bun run typecheck` passed after `bun install` installed declared dev dependencies.
- 2026-05-14: `git init` initialized `/Users/fischer/work/soma` as a repository.
