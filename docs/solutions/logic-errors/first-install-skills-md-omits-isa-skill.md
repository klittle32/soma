---
title: First install renders skills.md without the ISA skill
date: 2026-06-10
category: logic-errors
module: install / home projection (installSomaForSubstrate)
problem_type: logic_error
component: tooling
symptoms:
  - 'First `soma install <substrate>` projects skills.md as "No Soma skills were declared." even though the ISA skill is installed'
  - "The ISA skill only appears in skills.md after a second install; installs 2 and 3 are byte-identical but install 1 differs"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - assistant
tags:
  - install
  - home-projection
  - isa-skill
  - idempotency
  - first-install
  - skills-md
  - double-write
---

# First install renders skills.md without the ISA skill

## Problem

A first `soma install <substrate>` rendered the projected `skills.md` as
**"No Soma skills were declared."** even though the canonical ISA skill was
written to the substrate during that same install. The ISA skill only showed
up in `skills.md` after a *second* install — installs 2 and 3 were
byte-identical, but install 1 was inconsistent with the files actually on disk.
This affected every substrate (codex, claude-code, cursor, pi-dev, grok).

## Symptoms

- After one `soma install codex --apply`, `~/.codex/memories/soma/skills.md`
  reads `"No Soma skills were declared."` while `~/.codex/skills/ISA/` exists on
  disk.
- Running install a second time makes `skills.md` list `## ISA`; the projection
  only converges on the second run.

## What Didn't Work

- **The naive "just reload the whole context" fix.** Re-reading the Soma home
  after the ISA baseline does fix `skills.md`, but it also pulls the ISA skill
  into `profile.skills` — which the generic *portable-skill file loop* then
  re-emits as files, on top of the ISA skill's dedicated managed projection.
  That double-write (identical bytes, but redundant) inflated the reported file
  set (`result.substrateHome.files` for codex jumped 21 → 43) and broke the grok
  `dry-run == apply` parity test, because `apply` now wrote ISA files the static
  install plan never listed. The fix had to *also* exclude the dedicated ISA
  skill from the portable file loop.
- **Trusting full-suite pass/fail diffs to detect the regression.** This repo's
  `bun test` suite on Windows has ~97 environmental baseline failures and Bun
  crashes mid-run, cascading whole files to "failed." Diffing two single noisy
  runs' failing-test names surfaced 87 unrelated "new failures" (wisdom,
  learning, migrate, session modules) from a one-line install change that could
  not touch them — pure crash jitter, not a regression. The real, single
  deterministic regression was only found by isolating tests. (auto memory
  [claude])

## Solution

Two coordinated changes in core install code (one standalone commit,
`e5c4a47`).

**1. Reload the context after the canonical ISA baseline is written** so the
first projection already reflects the ISA skill (`src/install.ts`):

```ts
const somaHome = await bootstrapSomaHome(options);
const somaRepoPath = options.somaRepoPath ?? defaultSomaRepoPath();
// Canonical ISA baseline -> <somaHome>/skills/ISA
await installIsaSkillProjection({ homeDir: options.homeDir, somaHome: somaHome.somaHome, somaRepoPath });

// bootstrapSomaHome captured its context snapshot BEFORE the ISA baseline
// existed, so its skill list is empty on a first install. Re-read now so the
// first projection already lists the ISA skill — install #1 == install #2.
const projectionContext = await loadSomaHome(somaHome.somaHome);

// projectionContext now feeds the substrate projection (renderSkills, etc.):
const contextWithActiveIsa: ProjectionInput = {
  ...projectionContext, // was: ...somaHome.context (the stale pre-ISA snapshot)
  // ...activeIsa loaded as before
};
```

**2. Delegate the ISA skill out of the generic portable-skill file loop** so it
is projected exactly once (by its dedicated installer) while `renderSkills`
still lists it. New shared helper (`src/adapters/shared/index.ts`), backed by
the exported `ISA_SKILL_NAME` from `src/isa-skill-installer.ts`:

```ts
export function projectableSkillFiles(skills: SomaSkill[]): SomaSkill[] {
  // The ISA skill has a dedicated, managed per-substrate projection
  // (installIsaSkillProjection: baseline tracking, drift detection,
  // skillNameOverride). Exclude it here so its files are not double-written;
  // renderSkills still LISTS it in skills.md.
  return skills.filter((skill) => skill.name !== ISA_SKILL_NAME);
}
```

Each adapter that projects skill files routes through it
(`codex`, `grok`, `pi-dev`):

```ts
// before: input.profile.skills.flatMap(...)
const portableSkillFiles = projectableSkillFiles(input.profile.skills).flatMap((skill) =>
  (skill.files ?? []).map((file) => ({ path: `skills/${skill.name}/${file.path}`, content: /* rewrite */ })),
);
```

Result: `skills.md` lists the ISA skill from the first install; reported file
counts and `dry-run == apply` parity are unchanged (codex 21 → 21, pi-dev
13 → 13, byte-stable); the ISA skill is written exactly once.

## Why This Works

`bootstrapSomaHome` deliberately does **not** seed the ISA skill — that would
couple Layer 1 (home bootstrap) to Layer 2 (the ISA skill installer), which the
code explicitly avoids. So the canonical ISA skill is written by the install
*orchestrator* after bootstrap returns. The bug was that the orchestrator then
projected from bootstrap's pre-ISA context snapshot. Re-reading the home after
writing the baseline is the sanctioned way to reflect it without reintroducing
that layer coupling.

The ISA skill is special: it has a managed projection with per-substrate
baseline tracking and drift detection. Letting the generic "dumb file copy"
portable loop also emit it produced identical bytes but a redundant write and a
plan/apply mismatch. Excluding it there keeps a single source of truth for ISA
projection while `renderSkills` (which reads the full `profile.skills`) still
surfaces it to the user.

## Prevention

- **Snapshot after you write.** When a projection renders from a context
  snapshot, take the snapshot *after* every artifact it should reflect is on
  disk. If ordering forces an early snapshot, reload before projecting.
- **Route skill-file projection through `projectableSkillFiles`.** Any new
  substrate adapter that emits portable skill files must use it, so skills with
  a dedicated managed projection (currently ISA) are never double-written.
- **Assert first-install convergence.** A test now installs twice and asserts
  the file set matches and `skills.md` is byte-identical, so projection-ordering
  bugs surface on install #1 rather than silently converging on #2
  (`test/install.test.ts` → "first install already converges").
- **Diagnose this flaky suite with isolated tests, not full-run diffs.** Confirm
  a fix is clean by running the affected tests in isolation (deterministic) and
  by two consecutive full runs landing at the same baseline count — never by
  comparing failing-test names across two single noisy runs. (auto memory
  [claude])

## Related Issues

- `design/design-decisions.md` — **DD-4** (Adapters own install facts; installer
  owns lifecycle orchestration): the exact boundary this bug sat on. The
  installer owns the bootstrap/baseline/reload ordering; adapters own
  substrate-specific skill-file projection. The fix is a concrete application of
  DD-4.
- `src/isa-skill-installer.ts` — the dedicated managed ISA projection
  (`ISA_SKILL_NAME`, baseline tracking, drift detection) this fix delegates to.
- `test/isa-skill-installer.test.ts` — AC-2 (idempotent copy to
  `~/.soma/skills/ISA/`), AC-4 (per-file baseline hashes), AC-5 (local-edit drift
  → `.upgrade-available`, no overwrite): the guarantees a double-write would have
  undermined.
- `test/adapter-active-isa.test.ts` — AC-3 (ISA projected once into each
  substrate's dest) and AC-5 (per-substrate baselines): why ISA must be excluded
  from the generic portable loop.
- `docs/portability-proof.md` — the byte-portability invariant; "install #1 ==
  install #2" with unchanged counts and `dry-run == apply` parity extends it.
- `docs/substrate-adapters.md` — per-adapter projection surfaces (`skills.md`,
  ISA-skill destinations, the home bundle) affected here.
- `docs/design-skill-packaging.md` — how `renderSkills` lists every projected
  skill while the installer writes the ISA bytes.
- Commit `e5c4a47` (the fix). Lineage: issues **#27** (ISA skill as a first-class
  Soma primitive), **#33** (ship ISA source + per-file baseline installer),
  **#37** (adapter ISA projections) — this bug was a gap left by that layering,
  fixed directly (no dedicated issue).
