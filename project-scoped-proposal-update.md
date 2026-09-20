# Proposal: Project-Scoped Observational Memory for Pi

## Goal

Adapt [`amosblomqvist/pi-observational-memory`](https://github.com/amosblomqvist/pi-observational-memory) for a workflow where:

- one large codebase is worked on over time;
- many Pi sessions are relatively short-lived;
- useful knowledge discovered in one session should benefit future sessions;
- unrelated projects must remain isolated;
- session-local observations should not all become permanent project facts.

The preferred design is:

> **Session-local working memory + one durable shared memory bank per working directory.**

In this proposal, “project” means Pi's current working directory (`ctx.cwd`), not an inferred repository identity. The upstream repository has already been forked; implementation would happen in this fork. This document proposes changes only, not changes already implemented.

This fork has **one memory model**, not a backwards-compatible mode of the upstream package. There is no scope selector or legacy session-memory implementation. Use the upstream package separately if that behavior is needed. Retain code because it serves this design, not because it preserves the old API, file layout, or behavior.

---

## Why change the current Amos approach?

The current Amos implementation stores durable memory under a session-specific path similar to:

```text
<project>/.memory/<sessionId>/
```

That makes sessions isolated, which is useful for branching and reproducibility, but it means that a completely new Pi session in the same repository does not automatically inherit everything previous sessions learned.

For a workflow consisting of many small sessions over the same codebase, that leaves useful knowledge stranded inside old sessions.

The proposed change is to retain session-local observational state while promoting durable knowledge into a shared project memory.

---

# Proposed Architecture

```text
my-project/
└── .memory/
    ├── project/
    │   ├── INDEX.md
    │   ├── OVERVIEW.md
    │   ├── architecture.md
    │   ├── database.md
    │   ├── authentication.md
    │   ├── conventions.md
    │   └── testing.md
    │
    ├── sessions/
    │   └── <sessionId>/
    │       └── archive/     # session-only overflow; not temporary IPC
    │
    └── runtime/
        ├── <session-A>/
        │   └── runs/
        ├── <session-B>/
        │   └── runs/
        └── <session-C>/
            └── runs/
```

The important separation is:

```text
SESSION-LOCAL STATE
    raw conversation
    active observations
    session-only overflow archive
    observer watermarks
    compaction state
    worker state
    temporary run files

            │
            │ consolidation / promotion
            ▼

PROJECT-GLOBAL DURABLE MEMORY
    INDEX.md
    OVERVIEW.md
    topic files
    stable architectural knowledge
    accepted decisions
    conventions
    known constraints
```

---

# Three-Tier Memory Model

## Tier 1 — Recent raw context

The current conversation tail remains verbatim.

Example:

```text
"That test failed with ENOENT after we moved config.ts."
```

This is highly detailed but short-lived.

## Tier 2 — Session observations

The observer compresses conversation and tool activity into a bounded session-local observation pool.

Example:

```text
Moving config.ts broke three tests because they import it using
paths relative to src/runtime.
```

This is still task-oriented and may contain hypotheses or temporary implementation details.

## Tier 3 — Shared project knowledge

The consolidator promotes only durable, reusable knowledge into the project memory bank.

Example:

```text
Tests under tests/runtime use paths relative to src/runtime.
When relocating runtime modules, update those fixtures.
```

This information is useful to future sessions regardless of which original session discovered it.

---

# Working-Directory Scope

Use Pi's `ctx.cwd` directly as the base:

```text
<cwd>/.memory/project/
<cwd>/.memory/sessions/<sessionId>/archive/
<cwd>/.memory/runtime/<sessionId>/runs/
```

Do not search for a Git root, walk parent directories, infer a monorepo boundary, or derive identity from remotes or repository names. No project-identity extraction layer is needed.

Consequences are intentional:

- Sessions started in the same working directory share project memory.
- Sessions started in different subdirectories use different memory banks, even within one repository.
- Separate worktrees or clones do not automatically share memory.
- To share memory, start Pi from the same directory consistently.

Capture the base directory and session ID for each run. A worker's own working directory or a shell tool's `cd` must not redirect the memory bank. On session replacement, cancel old work and resolve paths from the new session context; never commit an old run into a new session's ledger.

---

# Proposed Data Flow

```text
Session A ── observations ──┐
Session B ── observations ──┼────► Project consolidator
Session C ── observations ──┘                │
                                             ▼
                                      .memory/project/
                                             │
                              ┌──────────────┴─────────────┐
                              ▼                            ▼
                         topic files                  OVERVIEW.md
                              │                            │
                              └──────────────┬─────────────┘
                                             ▼
                                  available to new sessions
```

Observers remain session-specific. Only the coordinated consolidation path writes shared topic files and `OVERVIEW.md`; the orchestrator generates `INDEX.md` under the same lock. Maintenance operations must use that lock too.

---

# Shared Project Files

A project memory directory could look like:

```text
.memory/project/
├── INDEX.md
├── OVERVIEW.md
├── architecture.md
├── authentication.md
├── database.md
├── event-pipeline.md
├── testing.md
└── conventions.md
```

## `INDEX.md`

A compact map of available project knowledge.

Example:

```markdown
# Project Memory Index

- `architecture.md` — system boundaries, services, ownership
- `authentication.md` — authentication design and constraints
- `database.md` — schema, migration conventions, data model
- `testing.md` — test commands, fixtures, CI behavior
- `event-pipeline.md` — migration status and design decisions
```

A new session can receive the index without loading every topic file.

## `OVERVIEW.md`

A compact, undated project orientation—not a chronological journey or change log. Use a name that describes its purpose; do not retain the upstream `JOURNEY.md` name or a fallback reader for it.

Example:

```markdown
# Project Overview

- The parser exposes a shared syntax tree consumed by the backend and tooling.
- Event processing is owned by the event-pipeline service.
- Authentication uses signed HTTP-only cookies.
- Legacy mobile clients require the v1 refresh endpoint.
```

Keep this file small enough to inject into every new session. Rewrite it to reflect established current understanding; do not append dated milestones, architectural-change timelines, completed-task lists, or commit summaries. Uncertain or temporary migration progress stays session-local. Git and existing session logs already cover what changed and when.

## Topic files

Topic files contain durable knowledge that can be read on demand.

Example:

```markdown
# Authentication

## Current state

Authentication uses signed HTTP-only cookies.

## Responsibilities

- `auth-service` owns refresh-token rotation.

## Known constraints

- Legacy mobile clients still require the v1 refresh endpoint.
```

---

# Do Not Put Everything Into Shared Memory

This is one of the most important design rules.

A session may explore temporary or abandoned ideas.

Example:

```text
Replace PostgreSQL with MongoDB.
```

The observer may legitimately record:

```text
Experimented with MongoDB as a replacement persistence layer.
```

But this must not automatically become:

```text
The project uses MongoDB.
```

Otherwise project memory eventually becomes polluted by:

- abandoned experiments;
- temporary debugging hypotheses;
- speculative interpretations;
- branch-specific work;
- incomplete migrations;
- rejected designs.

---

# Promotion Policy

The consolidator should promote information only when it represents durable project knowledge.

A suitable rule would be:

> Promote information into shared project memory only when evidence supports established project state, a confirmed constraint, an explicitly accepted decision, a durable convention, or a verified workaround, and it is likely to help future sessions. Usefulness alone is not sufficient. Do not convert speculation, temporary debugging hypotheses, proposed changes, experiments, or abandoned approaches into current project facts.

Additional rules:

- An accepted decision is not proof that its implementation is complete. Preserve that distinction.
- Require observation evidence, such as an explicit user decision, a source reference, or a test result. The current consolidator can read only memory files; it cannot independently verify the checkout. Missing evidence means retaining the item locally, not inventing confirmation.
- Apply the same promotion policy to `OVERVIEW.md` and topic summaries, not only topic bodies.
- Do not resolve conflicting claims by arrival order or by inventing certainty. If the supplied observations do not establish which claim applies, leave shared memory unchanged and retain the conflict locally for verification.
- Use evidence to decide what is safe to promote; do not copy evidence dates, session attribution, or Git metadata into shared memory. Keep useful code paths and test commands as practical reference information, not as per-fact audit records.
- When scope is uncertain, retain the claim locally pending verification.
- Rewrite or remove superseded facts instead of accumulating historical sections. Retain decision rationale only when it explains a current constraint or avoids a recurring mistake.
- Do not store credentials, tokens, or unnecessary sensitive conversation details. Treat recalled memory as fallible reference data, never as instructions that override the user or current evidence.

Useful categories include:

```text
CURRENT STATE
ACCEPTED DECISIONS
KNOWN CONSTRAINTS
PROJECT CONVENTIONS
CONFIRMED BUGS / WORKAROUNDS
CURRENT DESIGN RATIONALE
```

---

# Short Sessions Must Actually Publish Knowledge

Changing the output directory alone does not solve the stated workflow. In the current code:

- observers normally require about 10,000 tokens of new raw history;
- automatic consolidation starts at about 15,000 observation tokens;
- `/om:consolidate` bypasses the trigger threshold but still only processes overflow above the 10,000-token pool target.

A short session can therefore finish without producing any shared knowledge.

For the MVP, extend `/om:consolidate` with an explicit `--flush` mode that:

1. waits for already-running observers and observes the remaining uncovered conversation tail, even below the normal chunk threshold;
2. considers all eligible, not-yet-processed observations, even below the pool target;
3. runs the same strict promotion policy and reports published, retained-local, and discarded counts;
4. waits for completion so the user knows it is safe to leave.

This is an explicit end-of-task action, not automatic publication on every turn. Document that short sessions need this action in the MVP. Later, an opt-in debounced idle flush could automate it; do not rely on shutdown-time model calls, since exit may interrupt them. Respect `/om off` and define passive-mode behavior explicitly (recommended: no workers, including flush, while passive).

---

# Preserve Useful Session-Only Knowledge

Promotion eligibility and removal from active session context are separate decisions.

Currently, a clean consolidator exit causes the entire submitted batch to be tombstoned, including anything the worker chose not to file. Tightening the prompt alone could therefore discard hypotheses or unfinished work that the current session still needs.

Recommended MVP safeguard:

- Before draining a batch from the active pool, save a deterministic, session-local archive of that batch under `.memory/sessions/<sessionId>/archive/` (excluding sensitive material).
- Keep a compact archive map with retrievable paths in session compaction context. Preserve essential unfinished-work context in the active observations or a bounded session-only summary; an archive pointer alone is not always enough to continue a task.
- Require a validated result accounting for every submitted observation as promoted, retained locally, or deliberately discarded as noise. Worker exit code alone is not a sufficient success signal.
- Tombstone only the submitted observations still active on the originating branch, after required files and the generated index have been written successfully. Missing results or failures leave observations retryable.
- Design the ledger and result schema around this safety contract. Reuse useful observation-ordering and branch-isolation logic, but change old schemas or semantics where they obstruct validated outcomes and local retention. No legacy ledger adapter is required.

The archive is session-scoped persistence, not a second shared memory bank and not disposable runtime data. It should follow session retention and branching rules. In a Pi session fork, preserve access only to relevant ancestor archives; a fresh unrelated session must not bootstrap from them.

---

# Concurrency: A Simple Lock for 1–2 Main Agents

The expected workload is at most 1–2 main agents, usually working on different tasks, with potentially many subagents beneath them. Design for this workload, not for a distributed multi-writer service. No daemon, global job queue, per-topic locks, or database is needed.

Different tasks can still update the same `INDEX.md`, `OVERVIEW.md`, or architectural topic. Serialize these occasional updates with one simple lock file.

Multiple independent main-agent sessions may attempt to edit the same files:

```text
Session A ───► consolidator A ───► architecture.md
Session B ───► consolidator B ───► architecture.md
```

Without coordination:

```text
architecture.md v10
      │
      ├──── A reads v10
      └──── B reads v10

A writes v11-A

B writes v11-B
```

Session B may overwrite Session A's update.

## Project-wide consolidation lock

Use a project-global lock such as:

```text
.memory/project/.consolidation.lock
```

The process becomes:

```text
request consolidation
        │
        ▼
acquire project lock
        │
        ▼
read latest project memory
        │
        ▼
apply consolidation
        │
        ▼
update topic files
        │
        ▼
update OVERVIEW.md
        │
        ▼
regenerate INDEX.md
        │
        ▼
release lock
```

Only one consolidator should write to project memory at a time.

A simple `.lock` file is sufficient, provided acquisition is atomic (for example, exclusive file creation with `open(..., "wx")`, not a separate existence check followed by a write).

Keep its lifecycle minimal:

- record the owner PID, session/run ID, and a unique ownership token;
- release only the lock owned by that run, in `finally`, after its worker exits;
- if busy, defer background consolidation to a later trigger; an explicit flush may wait with a bounded, cancellable retry and report “busy” on timeout;
- do not spawn a consolidator while waiting for the lock;
- after a crash, clear a lock only when its writer is known to have stopped. If ownership is uncertain, report it for manual cleanup rather than stealing it by age. A parent PID disappearing is not enough if its child worker is still alive.

Automatic stale-lock recovery and heartbeat/lease machinery can wait. Atomic acquisition, owner-checked release, and retaining observations on failure cannot.

Acquire the lock **before building the prompt or reading shared memory**, and hold it through worker completion and index regeneration. Re-read current memory after waiting. Do not release the lock until the old worker has stopped writing; if a lock is lost, abort its worker and prevent further writes. A process-local flag is not enough; locking is mandatory, with no setting to disable it.

The MVP targets independent processes on one machine using a local filesystem. Distributed/network-filesystem coordination is out of scope. Manual edits should be made only while writers are idle; this is a cooperative lock, not protection against arbitrary external editors.

## Atomic writes, partial failure, and replay

Retain atomic temp-file-plus-rename writes. They prevent torn individual files, but neither they nor the lock make a multi-file consolidation transactional. Readers may see a mix of old and new complete files; document this MVP limitation. `INDEX.md` remains a rebuildable derived file.

Use a stable batch identifier tied to the source session/observations for internal retry bookkeeping, and make replay merge rather than duplicate facts or project-overview content. Do not write batch IDs or processing history into the shared Markdown. Preserve observation identity across Pi session forks where possible. A crash after topic updates but before ledger acknowledgement must be safely retryable. Write acknowledgement only after successful publication/index generation and local retention; do not assume a lock guarantees exactly-once delivery.

A staging directory plus an atomic generation switch is a possible later improvement if consistent multi-file snapshots become necessary.

---

# Subagent Compatibility: Main Agents Publish, Subagents Report

## What is already protected, and what is not?

Source review of [`amosblomqvist/pi-interactive-subagents`](https://github.com/amosblomqvist/pi-interactive-subagents/tree/c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7) found:

- OM's own observer/consolidator workers already launch with `--no-extensions` and explicitly load only `agent/index.ts`. This prevents normal recursive loading of the OM orchestrator.
- Interactive subagents are separate Pi processes and sessions, not threads sharing the parent's in-memory guards.
- Bundled tool-restricted profiles launch with `--no-extensions`, loading only explicitly selected extensions. OM ordinarily does not load in those children.
- **Do not rely on that for every profile:** the inspected `buildSubagentToolAllowlist` / `applySandboxToParts` code permits an unrestricted path when a profile has neither an explicit tool list nor a spawning grant. That path can discover normal extensions, despite the README's broader whitelist-only description.
- `session-mode: fork` copies session entries, potentially including the parent's OM-enabled gate and observations. The current OM entry point has no explicit interactive-subagent guard, so “off by default” is not sufficient in this case.
- Initial launch and `subagent_message` resume explicitly set `PI_SUBAGENT_ID` and `PI_SUBAGENT_SESSION` (along with name/role metadata). These are usable integration signals; no guessing from session names, directories, or `parentSession` is necessary.
- Completed findings are delivered to the parent as `subagent_result` custom messages. OM already includes custom messages in observer source slices and serializes their text. It does not automatically observe the child's full transcript.

These are source-review findings for the linked revision, not a completed integration test or a guarantee about other subagent launchers.

## MVP policy

> **Only main-agent sessions run the OM pipeline and publish project memory. Task subagents return findings to their parent.**

When the OM orchestrator is loaded in a process explicitly marked as an interactive subagent:

1. Suppress its OM pipeline before restoring a copied enabled gate, initializing memory directories, or dispatching workers. Enforce this for startup, reload/resume, `/om on`, flush, and other worker-starting paths; a copied `om.enabled` entry must not override the guard.
2. Do not start observer/consolidator workers, change the child's normal compaction behavior, or create OM runtime/archive directories. Leave existing copied ledger entries untouched; runtime suppression is enough.
3. Allow ordinary reading of relevant memory files when the child's tool permissions permit it, or pass relevant facts in the task prompt. Do not require loading OM in restricted children just to bootstrap them.
4. Do not let children publish through OM. Their result messages feed the parent's ordinary observation/promotion path, including nested children whose findings are summarized upward.

Use the launcher's explicit `PI_SUBAGENT_ID` / `PI_SUBAGENT_SESSION` markers for this integration. Do not classify every session with a `parentSession` as a subagent: a user-created Pi fork can be a legitimate main session. For other launchers, provide a documented explicit opt-out (the existing `PI_OM_PASSIVE=1` disables worker triggers, but is not by itself the full no-initialization/no-activation guard proposed here). Do not claim arbitrary subprocess detection without such a contract.

Keep OM worker isolation (`--no-extensions` plus only the worker extension), and add an `OM_WORKER` guard to the **orchestrator** as defense in depth. This must not disable the intentional worker extension itself.

The result is a bounded workload:

```text
main agent A ── many task subagents ── result messages ── A's OM pipeline ──┐
                                                                         ├─ .lock ─ project memory
main agent B ── many task subagents ── result messages ── B's OM pipeline ──┘
```

Adding task subagents does not multiply OM observers, consolidators, or shared-memory writers. Each main agent retains its own existing observer concurrency limit.

## Result quality and boundaries

- Ask subagents to return findings with source paths, verification/test results, and unresolved uncertainties. A “completed” result or successful exit does not automatically establish a project fact.
- Put useful findings and verification results in the result text; the current observer serializer includes custom-message content, not all structured `details` metadata. No extra provenance fields or metadata-serialization layer are needed.
- Publish only findings that reach and are assessed in the parent session. Full child-transcript harvesting is intentionally out of scope; facts omitted from child summaries may not be remembered.
- A main-agent flush covers results delivered so far. Do not claim it includes still-running children; the user can flush again after their results arrive.
- Preserve cwd-only scope. A child running in another directory does not redirect the parent's bank, and results about an unrelated directory/project must not be promoted as parent-project facts without establishing their relevance.
- This is cooperative OM coordination, not a filesystem security boundary. Subagents with `bash`/`write`/`edit` could bypass OM and edit `.memory/` directly. Tell task agents not to modify managed memory; enforcing that against arbitrary shell writes would require a separate sandbox/permissions layer.

## Compatibility checks before implementation is considered done

Exercise one enabled main session with many children (for example, 10), including nested children, across `standalone`, `lineage-only`, and `fork` session modes:

- restricted profiles do not load OM unexpectedly;
- unrestricted profiles that do load OM remain suppressed even with copied `om.enabled` entries;
- resume/reload and manual `/om on` cannot accidentally re-enable the child pipeline;
- children create no OM workers or child OM runtime/archive directories;
- parent observers receive result messages, and an explicit flush can promote a supported finding without importing every child transcript;
- two main sessions with many children still have only their two OM pipelines and at most one active project consolidator;
- OM's own workers do not load either the main orchestrator or the interactive-subagent extension;
- a normal user-created Pi fork without subagent markers can still act as a main session.

Use process-level tests for marker/gate/locking behavior and a real tmux smoke test with the installed subagent-extension version. Until these pass, compatibility is specified, not verified.

---

# Separate Runtime State From Durable Memory

Transient worker IPC should not live beside permanent knowledge.

Recommended layout:

```text
.memory/
├── project/
│   ├── INDEX.md
│   ├── OVERVIEW.md
│   └── ...
│
├── sessions/
│   └── <sessionId>/
│       └── archive/       # persistent session-only recall
│
└── runtime/
    ├── session-123/
    │   └── runs/
    ├── session-456/
    │   └── runs/
    └── session-789/
        └── runs/
```

The runtime directory can be ignored by Git and cleaned periodically, but never delete files belonging to live workers. Session archives are not part of that cleanup. Keep lock/replay metadata out of generated topic listings and out of version control.

Recommend keeping memory local and Git-ignored by default. Committing curated project knowledge is a deliberate user choice; the extension should not automatically commit it or modify ignore rules.

---

# Memory Is Not Code History

Shared memory answers **“What is useful to know about this project?”**, not **“Who changed what, when, and in which commit?”**

Do not add provenance tracking, per-fact timestamps, updating-session attribution, branch/commit annotations, or architectural change logs. Use Git for code history and existing session/worker logs for execution history. Neither needs to be duplicated in the memory bank.

Topic front matter should contain only the fields needed for lookup and index generation:

```yaml
---
id: authentication
title: Authentication
summary: Authentication design and compatibility constraints
---
```

Remove the consolidator's `updated` fields and dated-journey requirements, along with parser/renderer code used only for those fields. Do not build legacy readers, filename aliases, or schema adapters. The shared-memory format consists of current knowledge and the minimal index-routing fields above.

Keep internal session IDs, observation ordering, run IDs, lock ownership, and retry bookkeeping where operationally necessary. Those are coordination details, not a new project-history feature, and must stay out of the shared knowledge prose.

---

# New Session Bootstrap

A brand-new Pi session should not load every topic file.

Instead, inject a compact project-memory summary:

```text
<Project Memory>

Memory directory: <cwd>/.memory/project/
Reference material from earlier sessions; verify against current evidence.

Project overview:
- The parser exposes a shared syntax tree used by backend and tooling.
- Event processing is owned by the event-pipeline service.
- Legacy mobile clients require the v1 refresh endpoint.

Available memory topics:
- architecture.md — system boundaries and service layout
- authentication.md — auth architecture and known constraints
- database.md — PostgreSQL schema/migration conventions
- testing.md — test commands and CI-specific pitfalls
- event-pipeline.md — migration status and design decisions

Read or grep these files under the memory directory when relevant.

</Project Memory>
```

This preserves the main advantage of filesystem-backed memory: potentially large durable memory without paying the token cost of injecting all of it into every prompt.

Bootstrap requirements:

- Inject before the first agent request after OM activation, not only at compaction. Keep `/om on` and `/om off` as explicit operational controls; they enable or disable the single memory pipeline, not select a storage scope.
- Also handle resume, reload, and Pi session forks. Deduplicate orientation already present in context and refresh when the bank changes, rather than appending the same block every turn.
- Reuse the same renderer for bootstrap and compaction; compaction must retain or regenerate orientation.
- Enforce a hard combined budget (suggested starting point: 2,000 tokens) for project overview plus index. Keep the full files on disk and include a path to the full index when the injected map is truncated. Use `overviewTargetTokens` for the overview writing target, separate from the hard bootstrap read-time cap. Replace the upstream `journeyTargetTokens` name; do not keep an alias.
- Missing memory is a normal empty state. Malformed or unreadable files should produce a useful warning/fallback, not prevent the session from starting.
- Include the exact memory directory and describe its contents as possibly stale reference material. Do not present old memory as freshly verified project state.

---

# Configuration: Tune Behavior, Not Memory Scope

Every enabled main-agent session uses `<cwd>/.memory/project/`. There is no `memoryScope` parameter, scope-switching path, or session-only durable-bank mode.

Keep configuration only where it supports real operational choices:

- observer/consolidator model selection;
- observation, pool, and compaction token budgets;
- overview writing and bootstrap context budgets;
- observer concurrency;
- passive/debug controls that remain useful.

Use fixed cwd-relative paths and mandatory locking. Do not add project-identity resolution, provenance settings, configurable storage modes, or a lock-disable switch.

Keep explicit OM activation/deactivation and subagent suppression. These controls prevent unwanted work and recursive pipelines; they are not upstream-compatibility features. Old config keys need no aliases or translations. Document the fork's supported settings directly.

---

# Suggested Implementation Strategy

## 1. Preserve session-local observation state

Do not merge raw observations from every session into one shared live ledger.

Keep conversation history, observation ledger, observer watermarks, compaction metadata, and worker state associated with the individual Pi session.

## 2. Separate shared output from session retention and worker IPC

Use one unconditional layout:

```text
<cwd>/.memory/project/                         # shared durable knowledge
<cwd>/.memory/sessions/<sessionId>/archive/     # session-only overflow
<cwd>/.memory/runtime/<sessionId>/runs/         # transient worker IPC
```

Replace the old session-bank path resolver rather than wrapping it in a scope abstraction. Session-local archives are task retention, not an alternative durable-memory mode.

## 3. Base all paths on Pi's current working directory

Use `ctx.cwd` directly. Separate durable memory paths from runtime/IPC paths throughout the launcher, worker environment, result readers, and cost accounting; currently these all derive from `runtime.memoryRoot`. Merely repointing that one field would leave transient files inside the shared bank.

## 4. Add a simple project-wide lock and explicit subagent suppression

The lock must operate across independent Pi processes, not merely within one Node.js process. Target 1–2 main-agent writers. Suppress OM in explicitly marked task subagents, including forked/resumed children, so fan-out does not multiply memory pipelines.

## 5. Strengthen the consolidator prompt

Explicitly distinguish durable project facts from temporary session facts, speculation, experiments, and superseded information.

## 6. Keep shared memory focused on current knowledge

Remove prompt requirements for timestamps and append-only journey history. Keep only index-routing front matter and undated current-state prose. Replace superseded facts; leave code history to Git and execution history to existing logs.

## 7. Bootstrap new sessions from project memory

On startup or first activation:

1. read `OVERVIEW.md`;
2. read `INDEX.md`;
3. inject a compact project-memory orientation;
4. allow the agent to read topic files on demand.

Do not eagerly load every topic file.

## 8. Keep session-specific runtime files separate

Move worker run/IPC state beneath:

```text
.memory/runtime/<sessionId>/
```

or another explicitly temporary location.

## 9. Support short-session flush and safe draining

Implement explicit tail observation plus below-threshold publication. Add validated outcomes, session-local retention, replay-safe updates, and acknowledgement ordering before tightening the shared-memory promotion policy.

## 10. Remove obsolete paths, not preserve a second system

- Delete the per-session durable-bank implementation and parent-bank copy/seeding logic. Pi session forks in the same cwd use the same shared bank; only their working observations and archive references remain session-local.
- `/tree` navigation does not roll back shared project files. Shared recall is an intentional property of this fork, not a selectable mode.
- Replace `JOURNEY.md` and its append-history machinery with `OVERVIEW.md` and current-state rewriting. Rename related helpers, prompts, and settings consistently; do not retain compatibility aliases.
- Refactor or delete abstractions, commands, settings, comments, and tests that exist only for the old model. Reuse components that still serve the new design, such as bounded observation pools, model-free compaction, scoped worker tools, and atomic file writes.
- Start with a fresh shared bank. Old per-session banks are not read, copied, migrated, or deleted automatically. There is no migration/import feature in scope; users can manually curate useful knowledge if needed.
- Do not run upstream and this fork together in the same Pi process. The upstream package remains a separate choice, not a fallback hidden inside this fork.

---

# Optional Improvements

## Memory maintenance command

Potential command:

```text
/om:project-maintain
```

It could:

- merge duplicate topics;
- remove stale material;
- shrink `OVERVIEW.md`;
- rebuild `INDEX.md`;
- identify contradictory facts.

## Inspect project memory

Potential commands:

```text
/om:project
/om:project status
/om:project view
/om:project consolidate
```

---

# Recommended End State

```text
                   PI SESSION
                       │
          ┌────────────┴────────────┐
          │                         │
   raw conversation          observer workers
          │                         │
          └────────────┬────────────┘
                       ▼
              session observations
                       │
                       │ evidenced durable knowledge
                       ▼
              project-wide lock
                       │
                project consolidator
             (fresh reads + writes)
                       │
                       ▼
              .memory/project/
        ┌──────────────┼───────────────┐
        ▼              ▼               ▼
    INDEX.md       OVERVIEW.md     topic files
        │              │               │
        └──────────────┴───────────────┘
                       │
                       ▼
                future Pi sessions
```

Reuse the upstream implementation's useful building blocks, without preserving its storage contract:

- parallel observer workers;
- bounded active observations;
- model-free compaction path;
- filesystem-backed durable knowledge;
- human-readable memory;
- grep/read-based retrieval;

while changing the durable memory boundary from one memory bank per session to one durable memory bank per project, with each session retaining its own short-term observational state.

---

# Minimum Viable Patch

For an initial implementation, focus on these changes only:

1. Make cwd-scoped shared memory the only storage model; do not add a scope parameter.
2. Store shared knowledge under `.memory/project/`; separate session retention and runtime paths.
3. Keep observations and watermarks session-local; add only the outcome/retention bookkeeping needed for safe draining.
4. Add a simple exclusive `.lock` file covering reads, worker writes, and index generation, with safe release and retry behavior. Keep uncertain stale-lock cleanup manual for the MVP.
5. Tighten promotion rules for all shared files; store undated current knowledge without provenance or change logs.
6. Add explicit short-session flush, including the unobserved conversation tail.
7. Bootstrap enabled sessions with a bounded `INDEX.md` + `OVERVIEW.md` orientation before their first request, and preserve it through compaction.
8. Delete legacy session-bank paths, seeding, history-writing logic, and compatibility-only code. Do not add migration machinery.
9. Suppress OM pipelines in explicitly marked task subagents and OM worker processes; collect child findings through parent result messages. Verify forked, nested, and resumed subagents.

These are the minimum behavioral changes, not just a path replacement. Maintenance commands, automatic idle publication, custom directory settings, and transactional multi-file snapshots can wait. Provenance tracking and Git-history duplication are out of scope, not deferred features.

---

# Acceptance Criteria

Before calling the feature complete, test that:

- Two new sessions with the same cwd share promoted knowledge; different cwd values (including nested directories) stay isolated without Git-root detection.
- A short session below both normal thresholds can flush a verified fact, and a new enabled session sees it before any compaction.
- Useful but unconfirmed observations stay retrievable locally and remain sufficient for continuing work; they do not leak into shared topics, project overview, or index.
- Independent processes consolidating into the same topic preserve both updates; a waiting process reads fresh memory only after acquiring the lock.
- Worker failure, cancellation, a slow live lock owner, stale locks, and a crash between file writes and ledger acknowledgement do not cause unsafe lock stealing or premature observation loss.
- Replaying a batch does not duplicate facts or project-overview content; contradictory input does not silently replace established knowledge based only on arrival order.
- Shared files contain no authored timestamps, session attribution, branch/commit annotations, or architectural change logs. Superseded facts are replaced or removed, while internal lock/retry bookkeeping still works.
- Disabling OM or changing sessions cancels old work without appending to the wrong ledger or changing the wrong memory bank.
- Resume, reload, fork, and compaction preserve bounded, non-duplicated orientation. Rewrite tests around this fork's model rather than preserving legacy behavior.
- Enabled main sessions always use the cwd's shared bank without a scope setting. No session-bank fallback, parent-bank seeding, legacy filename/config alias, or migration path remains.
- Empty/malformed/oversized memory and runtime cleanup are handled without deleting session archives or live IPC files.
- Old session banks remain untouched and are not consulted by the new pipeline.
- One main session with many interactive subagents does not multiply OM pipelines; child results remain eligible for the parent's observation/flush path. Pass the subagent compatibility checks above.

---

# Repository

The upstream repository has already been forked. No clone/fork setup step remains.

Relevant implementation touchpoints verified in this fork:

- `src/config.ts` — settings and token thresholds.
- `src/memory/paths.ts` and `src/memory/session.ts` — cwd-relative session paths, topic metadata, and parent seeding.
- `src/runtime.ts`, `src/spawn/launch.ts`, and `src/spawn/runs.ts` — currently coupled durable-memory and IPC paths.
- `src/hooks/observer-trigger.ts` — observation chunk threshold and worker result/cost handling.
- `src/hooks/consolidator-trigger.ts` — prompt construction, worker dispatch, whole-batch tombstoning, and index generation. Currently the index write happens after tombstoning; safe acknowledgement ordering needs attention.
- `src/commands/consolidate.ts` — currently processes only overflow, even for a forced run.
- `src/index.ts` and `src/hooks/compaction-hook.ts` — session activation and existing compaction-time orientation; startup bootstrap is additional behavior.
- `agent/consolidator/prompt.ts` and `agent/consolidator/tools.ts` — promotion instructions and scoped writes.

These are current-code touchpoints, not interfaces to preserve. Some existing comments/prompts already describe memory as project-wide despite session-specific paths; rewrite comments, naming, and tests to match the single new model, removing obsolete paths rather than documenting two behaviors.

---

# Design Principle

> **Sessions own observations. Projects own durable knowledge.**

That boundary keeps project memory useful across many short sessions without mixing unrelated projects or turning every temporary thought into permanent memory.
