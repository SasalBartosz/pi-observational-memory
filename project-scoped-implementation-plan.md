# Implementation Plan: Project-Scoped Observational Memory

Companion to `project-scoped-proposal-update.md`. This is the change-by-change plan for
turning the current per-session-bank codebase into the single-model, cwd-scoped fork.
Ordered so that early sections unblock later ones; each section names the exact files and
functions to change, and what becomes redundant.

Target layout (only storage model, no scope parameter):

```text
<cwd>/.memory/
├── project/                        # shared durable bank (INDEX.md, OVERVIEW.md, topics)
│   └── .consolidation.lock         # cross-process lock file
├── sessions/<sessionId>/archive/   # session-only pre-drain archives (persistent)
└── runtime/<sessionId>/runs/       # transient worker IPC (result/cost files)
```

---

## 1. Path resolution: replace the per-session bank with the three-root layout

**Files:** `src/memory/paths.ts`, delete `src/memory/session.ts`, touch `src/runtime.ts`.

Current state: `sessionMemoryRoot(cwd, sessionId)` returns `.memory/<sessionId>/` and that
one root holds durable memory (INDEX/JOURNEY/topics) *and* transient `.runs/` IPC.
`ensureSessionMemory()` in `session.ts` additionally implements parent-bank seeding on
fork/clone.

Changes:

- **`src/memory/paths.ts`**
  - Delete `sessionMemoryRoot()`. Add three resolvers, all derived directly from `ctx.cwd`
    (no Git-root search, no project-identity layer):
    - `projectMemoryDir(cwd)` → `<cwd>/.memory/project`
    - `sessionArchiveDir(cwd, sessionId)` → `<cwd>/.memory/sessions/<sessionId>/archive`
    - `sessionRuntimeDir(cwd, sessionId)` → `<cwd>/.memory/runtime/<sessionId>`
  - Keep `memoryBaseDir`, `atomicWrite`, `resolveWithinMemory`, `parseFrontMatter`,
    `listTopics` (with adjustments in §6).
  - Replace `JOURNEY_FILENAME` / `journeyPath` / `readJourney` with
    `OVERVIEW_FILENAME = "OVERVIEW.md"` / `overviewPath` / `readOverview`. No fallback
    reader for `JOURNEY.md`.
- **`src/memory/session.ts` — delete the whole file.** Parent discovery
  (`parentMemoryRoot`, `readSessionHeaderId`) and copy-seeding (`ensureSessionMemory`)
  implement the old per-session-bank model. Forks in the same cwd now simply share
  `.memory/project/`; nothing is seeded.
- **`src/runtime.ts`**
  - Replace the single `memoryRoot` field with three, all captured at activation time from
    `ctx.cwd` + `ctx.sessionManager.getSessionId()` (never from a worker's cwd or a shell
    `cd`):
    - `projectDir` — shared bank, consolidator sandbox, index/overview reads.
    - `archiveDir` — session-local pre-drain archives.
    - `runtimeDir` — worker spawn cwd + IPC files.
  - Add a small `resolvePaths(ctx)` helper (new, can live in `paths.ts`) that computes all
    three; call it from `session_start` and `/om on` in `src/index.ts` where
    `ensureSessionMemory(ctx)` is called today.
  - On session replacement (a new `session_start` with a different session id): abort
    in-flight workers via the existing `abortAllWorkers()`, then re-resolve paths from the
    new context. Never let an old run commit into a new session's ledger — the worker
    dispatch code must capture the session id at dispatch and re-check it at commit time
    (see §7).

**Redundant after this section:** `sessionMemoryRoot`, `ensureSessionMemory`,
`parentMemoryRoot`, `readSessionHeaderId`, `isRunsPath`, and `tests/session.memory.test.ts`.

---

## 2. Separate runtime IPC from durable memory in spawn/launch

**Files:** `src/spawn/runs.ts`, `src/spawn/launch.ts`, `src/hooks/observer-trigger.ts`,
`src/hooks/consolidator-trigger.ts`.

Current state: `runsDir(root)` puts `.runs/` inside the memory root; `spawnWorker` uses
`runtime.memoryRoot` as the worker's cwd; `buildWorkerEnv` points `OM_RESULT_PATH`,
`OM_COST_PATH`, and `OM_MEMORY_DIR` all at that same root. Repointing `memoryRoot` alone
would leave IPC files inside the shared bank.

Changes:

- **`src/spawn/runs.ts`**
  - `runsDir`, `runResultPath`, `runCostPath` keep their signatures but are now always
    called with `runtime.runtimeDir` (i.e. files land in
    `.memory/runtime/<sessionId>/runs/`). Update the module doc comment: IPC is transient
    and separate from durable memory; add that the runtime dir may be cleaned periodically
    but never while workers are live, and session archives are not part of that cleanup.
  - Keep `atomicWrite`, cost read/write, observer result read/write as-is.
  - Add a **consolidator result file** (new): `runResultPath`-style
    `<runId>.consolidation.json` plus `writeConsolidatorResult` / `readConsolidatorResult`
    with validation. Schema: `{ batchId, outcomes: [{ timestamp, disposition: "promoted" | "retained" | "discarded" }] }`.
    This is the validated-outcome contract the orchestrator checks before tombstoning (§7).
- **`src/spawn/launch.ts`**
  - `buildWorkerEnv`: split the env by role. Both roles get `OM_RESULT_PATH`/`OM_COST_PATH`
    under the runtime dir. Only the consolidator gets `OM_MEMORY_DIR`, now pointing at
    `runtime.projectDir` (the consolidator's sandbox is the shared bank, nothing else).
  - `spawnWorker`: the `cwd` argument becomes `runtime.runtimeDir` (update the doc comment;
    the purpose — keying worker recordings into a distinct global session bucket — is
    unchanged, only the bucket moves out of the durable bank).
  - `ObserverLaunchEnv` type: rename/reshape to carry both `runtimeDir` and (consolidator
    only) `projectDir`.
- **Callers** (`observer-trigger.ts`, `consolidator-trigger.ts`): pass the split paths;
  `recordWorkerCost` reads `runCostPath(runtime.runtimeDir, runId)`.

---

## 3. Config: rename the journey budget, add the bootstrap budget, drop nothing else

**File:** `src/config.ts`.

- Rename `journeyTargetTokens` → `overviewTargetTokens` (the *writing* target the
  consolidator aims OVERVIEW.md at). No alias, no translation of the old key; update
  `DEFAULTS`, the `numberKeys` list, and the doc comment (undated orientation, not a
  running history).
- Add `bootstrapTokens` (default 2_000): the hard combined read-time cap for the injected
  OVERVIEW + INDEX orientation block (§9). Add to `numberKeys`.
- Everything else stays: model selection, chunk/pool/compaction budgets,
  `observerConcurrency`, `passive`, `debugLog`, `resumeAfterMidRunCompaction`.
- Do **not** add: `memoryScope`, storage-mode switches, project-identity settings,
  provenance settings, or a lock-disable switch. Locking is mandatory.

---

## 4. Project-wide consolidation lock (new module)

**New file:** `src/memory/lock.ts`. **Consumers:** `src/hooks/consolidator-trigger.ts`,
`src/commands/consolidate.ts`, later any maintenance command.

Current state: only the in-process `runtime.consolidatorInFlight` flag exists — it cannot
coordinate two independent Pi processes writing the same bank.

Implement:

- `acquireProjectLock(projectDir, owner): LockHandle | "busy"` using atomic exclusive
  create (`open(path, "wx")`, *not* exists-check-then-write) on
  `<projectDir>/.consolidation.lock`. Content: `{ pid, sessionId, runId, token, acquiredAt }`
  where `token` is a random ownership token.
- `releaseProjectLock(handle)`: verify the file's token matches ours before unlinking
  (owner-checked release); call in `finally` after the worker has fully exited.
- Stale-lock policy for MVP: a lock whose recorded PID is dead *and* has no live child may
  be reported; otherwise report "held by pid X (session Y)" and leave it for manual
  cleanup. No age-based stealing, no heartbeat/lease machinery.
- Lock lifecycle in the consolidator path (§7): acquire **before** building the prompt or
  reading shared memory; re-read memory after a wait; hold through worker completion,
  acknowledgement validation, and INDEX regeneration; release only after the worker
  process has stopped writing.
- Busy behavior: background (threshold-triggered) consolidation defers silently to a later
  trigger. Explicit `/om:consolidate --flush` waits with a bounded, cancellable retry and
  reports "busy" on timeout. Never spawn a consolidator while waiting for the lock.
- `runtime.ts`: keep `consolidatorInFlight` as the in-process guard, add lock-handle
  bookkeeping so `/om off` and session replacement abort the worker *before* releasing.

---

## 5. OVERVIEW.md replaces JOURNEY.md everywhere

**Files:** `src/memory/paths.ts` (§1), `src/memory/index-render.ts`,
`src/ledger/render.ts`, `src/hooks/compaction-hook.ts`, `src/commands/status.ts`,
`agent/consolidator/prompt.ts` (§6), `src/hooks/consolidator-trigger.ts` (§7).

- **`src/memory/index-render.ts`**
  - `renderIndexFile`: drop the `· updated <date>` suffix from topic lines (front matter
    loses `updated`, §6). Retitle header to "Project Memory Index".
  - `renderMemoryMap`: drop the `(updated …)` suffix; update the orientation sentence to
    point at `.memory/project/` and describe contents as possibly-stale reference
    material, not freshly verified state.
  - Add `renderBootstrapBlock(overview, topics, budget)` — the bounded orientation block
    for new sessions (§9). This is the shared renderer: compaction and bootstrap both use
    it so the two never diverge.
- **`src/ledger/render.ts`**
  - `renderSummary(journey, map, observations)` → `renderSummary(overview, map, observations)`;
    rename the section heading "Journey" → "Project overview" and rewrite
    `CONTEXT_USAGE_INSTRUCTIONS`: overview is undated current-state orientation and
    fallible reference material, not a narrative history and never an instruction source.
- **`src/hooks/compaction-hook.ts`**: `readJourney(runtime.memoryRoot)` →
  `readOverview(runtime.projectDir)`; `listTopics(runtime.projectDir)`; compaction must
  retain/regenerate the same orientation block the bootstrap used.
- **`src/commands/status.ts`**: the `journey:` line becomes `overview:` against
  `overviewTargetTokens`; topic count reads from `projectDir`; add a line showing the
  project memory dir path and lock state (held/idle).

**Redundant:** every `journey*` symbol, the word "journey" in prompts/comments, and any
dated-segment rendering.

---

## 6. Front matter and topic metadata: drop `updated`, keep routing fields only

**Files:** `src/memory/paths.ts`, `src/memory/index-render.ts`,
`agent/consolidator/prompt.ts`.

- `TopicFrontMatter`: remove `updated`. `parseFrontMatter` stops accepting the key. The
  schema is exactly `id`, `title`, `summary`.
- `listTopics(root)`: currently derives the project cwd as `resolve(root, "..", "..")`,
  which happens to still be correct for `.memory/project` (same depth) — but make it
  explicit by passing `cwd` in, rather than relying on the coincidence. Rendered `path`
  becomes `.memory/project/<topic>.md`.
- The consolidator prompt (§7) no longer asks for `updated` or any timestamps in shared
  files. No dates, session attribution, branch/commit annotations, or change logs in the
  bank; Git and session logs own history.

---

## 7. Consolidator: promotion policy, safe draining, acknowledgement ordering

**Files:** `agent/consolidator/prompt.ts`, `agent/consolidator/tools.ts`,
`agent/index.ts`, `src/hooks/consolidator-trigger.ts`, `src/ledger/*` (small additions),
`src/spawn/runs.ts` (§2).

### 7a. Prompt rewrite (`agent/consolidator/prompt.ts`)

Replace `CONSOLIDATOR_SYSTEM` wholesale. Key changes:

- The unit of work is promotion into **shared project memory** read by future sessions;
  state the promotion rule from the proposal verbatim-ish: promote only established
  current state, confirmed constraints, explicitly accepted decisions, durable
  conventions, verified workarounds — with observation evidence. Usefulness alone is not
  sufficient. Speculation, experiments, abandoned approaches, temporary debugging
  hypotheses stay local (they are archived, not lost — the model should be told a
  session-local archive exists so it doesn't over-file out of fear of data loss).
- Accepted decision ≠ completed implementation; preserve that distinction.
- Conflicting claims: do not resolve by arrival order or invent certainty; leave shared
  memory unchanged and mark the observation `retained`.
- Delete the entire JOURNEY.md section (dated segments, append-mostly, compress-old-tail).
  Replace with OVERVIEW.md rules: undated, current-state orientation, rewritten wholesale
  to reflect established understanding, under `overviewTargetTokens`, same promotion
  policy as topic bodies.
- Remove the `updated` front-matter requirement; front matter is `id`/`title`/`summary`.
- Replace "fold everything or discard as noise, you do not report back" with the outcome
  contract: the worker must end by writing its outcome file (§7c) accounting for **every**
  submitted observation as `promoted`, `retained`, or `discarded` (noise only).
- Keep: topic routing guidance, current-state-prose-not-changelog, rewrite-superseded-
  facts, detail preservation, filename/id rules, "don't write INDEX.md".

### 7b. Scoped tools (`agent/consolidator/tools.ts`)

- Sandbox root is now `runtime.projectDir` (passed via `OM_MEMORY_DIR`). Also reject
  writes to `OVERVIEW.md`? No — the consolidator owns OVERVIEW.md; keep rejecting only
  `INDEX.md` and additionally reject any path matching `.consolidation.lock` or starting
  with `.` (defense against the model touching lock/replay metadata).
- `ls`/`grep` already skip dotfiles; keep that (hides the lock file).
- No provenance/metadata tools. Tools stay as-is otherwise.

### 7c. Worker extension (`agent/index.ts`)

- The consolidator branch currently has no result file. Register a small
  `report_consolidation_outcomes` tool (or require the model to `write` a fixed-name file
  via the scoped tools — prefer a dedicated tool writing to `OM_RESULT_PATH`, outside the
  sandbox, so the model can't be sandbox-confused) that validates and writes
  `{ batchId, outcomes }` (§2). Read `batchId` from a new `OM_BATCH_ID` env var.
- Keep the `agent_end` shutdown and cost tracking unchanged.

### 7d. Orchestrator dispatch (`src/hooks/consolidator-trigger.ts`)

Rework `dispatchConsolidator` in this order:

1. **Archive first.** Before draining anything, write the submitted batch verbatim to
   `runtime.archiveDir/<batchId>.json` (deterministic name from a stable batch id derived
   from the source session id + sorted observation timestamps, so retries/replays reuse
   the same id and merge rather than duplicate). Exclude anything matching a basic
   secret-pattern screen. Append a ledger entry (new type, e.g.
   `om.observations.archived` with `{ batchId, path, timestamps }`) so the archive map is
   retrievable from session context after compaction; essential unfinished-work context
   must additionally survive in the active observations or a bounded session-only summary
   — an archive pointer alone is not enough to continue a task.
2. **Acquire the project lock** (§4) — before building the prompt or reading the bank.
3. Build the prompt (rewrite `buildConsolidatorPrompt`): current index + current
   OVERVIEW + the batch lines + the batch id. Remove the "use this exact time string in
   `updated`" instruction, the `Current local time:` line itself (nothing in the bank is
   dated anymore), and the journey section; add the outcome-file instructions.
   Re-read the bank fresh here (post-lock, post-wait).
4. Spawn the worker with the split env (§2) and `OM_BATCH_ID`.
5. On exit: record cost; then **validate the outcome file** — it must exist, match
   `batchId`, and account for every submitted timestamp exactly once. Worker exit code
   alone is not success. On missing/invalid outcomes: leave all observations active
   (retryable), release the lock, report the failure. Replay of the same `batchId` must
   merge, not duplicate (the prompt instructs rewrite-in-place semantics; the archive
   write is idempotent by name).
6. **Regenerate `INDEX.md` under the same lock, then tombstone last.** The acknowledgement
   lands only after successful publication AND index generation — the proposal's explicit
   ordering ("tombstone … after required files and the generated index have been written
   successfully"; upstream wrote the index after tombstoning, which is precisely the
   ordering the proposal flagged as needing attention). Only tombstone submitted timestamps
   still active on the originating branch (existing intersect-with-`stillActive` logic
   stays — it correctly protects forked branches and observations committed mid-run).
   Index → tombstone are one critical section: a crash between them leaves the batch active
   and retryable, which the batch-id replay covers (idempotent merge).
7. Release the lock in `finally`, after the worker process has exited.
8. Session-identity check: capture `sessionId` at dispatch; at commit time verify
   `ctx.sessionManager.getSessionId()` still matches, else discard the run's ledger
   writes (the bank writes are fine — they're project-scoped — but the tombstone must not
   land in a different session's ledger).

`evaluateConsolidatorTrigger` keeps its threshold clock but routes through the lock:
if the lock is busy, defer (return) rather than queue.

### 7e. Ledger (`src/ledger/types.ts`, `fold.ts`, `projection.ts`)

- Add the `om.observations.archived` entry type (archive map for compaction context).
- Ensure `foldLedger`/projection surface archive pointers compactly in the compaction
  block (a short "session archive" section listing batch paths, rendered in
  `renderSummary` or the map section).
- No legacy ledger adapter; change schemas where they obstruct validated outcomes.

---

## 8. Short-session flush: `/om:consolidate --flush`

**Files:** `src/commands/consolidate.ts`, `src/hooks/observer-trigger.ts`,
`src/hooks/consolidator-trigger.ts`.

Current state: `/om:consolidate` only processes overflow above `poolTargetTokens`, and
observers never fire below `chunkTokens` — a short session publishes nothing.

Implement `--flush` as an explicit end-of-task action:

1. **Tail observation.** Add `flushObserverTail(pi, runtime, ctx)` to
   `observer-trigger.ts`: wait for in-flight observers (`runtime.whenObserversIdle()`),
   then dispatch one observer over the remaining uncovered conversation (from the
   effective watermark to the branch tip) even when below `chunkTokens`. Reuse
   `selectSourceSlice` with an explicit "take whatever remains" mode rather than faking
   thresholds. Await completion.
2. **Full-pool consolidation.** Run the consolidator over **all** active observations
   (bypass both `consolidateAtPoolTokens` and the `poolTargetTokens` overflow selection —
   replace the temporary `consolidateAtPoolTokens = 0` hack in the current command with a
   real `flush` flag threaded into the dispatch path that also swaps
   `selectPromotionOverflow` for "select all active").
3. **Lock semantics:** wait for the project lock with a bounded, cancellable retry; report
   "busy" on timeout instead of firing.
4. **Synchronous report.** Await the whole pipeline and report counts: observations
   promoted / retained locally / discarded, plus where the archive was written. The user
   must know it is safe to leave.
5. Respect the gates: no-op (with a message) when `!runtime.enabled`; refuse when
   `config.passive` (passive = no workers, including flush); refuse in suppressed
   subagents (§10).
- Update the command description and README: short sessions need `/om:consolidate --flush`
  before ending; automatic idle flush is a later opt-in, shutdown-time model calls are
  explicitly not relied upon.

---

## 9. New-session bootstrap injection

**Files:** `src/index.ts`, `src/memory/index-render.ts` (`renderBootstrapBlock`, §5),
`src/hooks/compaction-hook.ts`, `src/runtime.ts`.

Current state: orientation only appears at compaction. New sessions get nothing until
they compact.

- Register a `before_agent_start` handler in `src/index.ts` (or a small new
  `src/hooks/bootstrap.ts`): when `runtime.enabled` and not yet injected for this
  session, return a context injection containing
  `renderBootstrapBlock(readOverview(projectDir), listTopics(projectDir), config.bootstrapTokens)`:
  - exact memory dir path (`<cwd>/.memory/project/`);
  - framing as possibly-stale reference material to verify against current evidence;
  - OVERVIEW body + topic index lines, truncated to the hard `bootstrapTokens` cap with a
    "full index at <path>" pointer when truncated;
  - "read or grep these files when relevant" instruction.
- Dedupe: track injection state in `runtime` (e.g. `lastBootstrapFingerprint` — a hash of
  overview+index content). Re-inject only when the bank changed; never append the same
  block every turn. Handle resume, reload, and Pi session forks (gate restore on
  `session_start` already runs; the fingerprint resets per session).
- Empty state: missing/empty bank → inject nothing (or a one-line "no project memory
  yet"). Malformed/unreadable files → skip with a warning notify, never block session
  start.
- Compaction reuses the same renderer so orientation survives compaction unchanged
  (compaction-hook swaps its journey+map sections for the shared block).

---

## 10. Subagent and worker suppression guards

**File:** `src/index.ts` (and a tiny helper, e.g. `src/subagent-guard.ts`).

- At the top of the default export, compute:
  - `isOmWorker = !!process.env.OM_WORKER` → return immediately (defense in depth; the
    orchestrator must never activate inside its own workers. Does not affect
    `agent/index.ts`, the intentional worker extension).
  - `isInteractiveSubagent = !!(process.env.PI_SUBAGENT_ID || process.env.PI_SUBAGENT_SESSION)`
    → register nothing except (optionally) read-only no-op stubs. Concretely: do not
    restore the `om.enabled` gate, do not resolve/create memory dirs, do not register
    triggers, and make `/om on`, `/om:consolidate`, and `/om:compact` report
    "OM is suppressed in subagent sessions" instead of activating. Enforce on startup,
    resume/reload, and every worker-starting path — a copied `om.enabled` ledger entry
    from a `session-mode: fork` parent must not re-enable the pipeline.
- Do **not** classify by `parentSession` (a user fork is a legitimate main session).
- Document `PI_OM_PASSIVE=1` as the explicit opt-out for other launchers (it disables
  triggers but is not the full no-init guard).
- Subagent findings flow back as `subagent_result` custom messages, which the observer
  already serializes — no changes needed there; note in the observer prompt that custom
  result messages from task agents are evidence, not automatically established facts.

---

## 11. Deletions and renames (no compatibility layer)

- **Delete `src/memory/session.ts`** entirely (§1) and `tests/session.memory.test.ts`.
- **Delete** `JOURNEY_FILENAME`, `journeyPath`, `readJourney` (`paths.ts`); all journey
  references in `render.ts`, `compaction-hook.ts`, `status.ts`, `consolidator-trigger.ts`,
  `config.ts`, `agent/consolidator/prompt.ts`.
- **Delete** the `updated` front-matter field and its rendering (`paths.ts`,
  `index-render.ts`).
- **Delete** the "seed from parent" behavior and its temp+rename copy machinery; forks
  share the cwd bank.
- **Delete** the `consolidateAtPoolTokens = 0` temporary-threshold hack in
  `commands/consolidate.ts` (replaced by a real flush flag, §8).
- **Delete `OBSERVER_KICKOFF`** from `agent/observer/prompt.ts`: it is exported but
  unused (the observer trigger builds its own kickoff in `dispatchObserver`), and its doc
  comment is stale — it claims the chunk is injected via a `context` hook when it is
  actually passed as the `pi -p` prompt.
- **`src/debug-log.ts` — decide, don't carry blindly.** The module is fully wired
  (AsyncLocalStorage context, rotation) but nothing calls `debugLog()` or
  `withDebugLogContext()` anywhere; only the `debugLog` config flag in `config.ts`
  references it. It is dead code today. Either delete the module + config key, or keep it
  and actually instrument the new lock/flush/archive paths with it (useful for the
  cross-process debugging this fork adds). Pick one; do not leave it dormant.
- **`src/ui/timeline.ts` — cosmetic only.** The legend line `▓ .memory (...)` and the
  "promoted to .memory (long-term)" comment should say `.memory/project/`; rendering
  logic is unchanged.
- **`package.json` — update `description`** (still says "Phase B" / per-session durable
  memory) to describe the project-scoped model.
- **Rename** throughout comments/docs: "session memory root" → project bank / session
  archive / runtime dir as appropriate. Several current comments describe memory as
  project-wide while paths are session-specific — rewrite comments to match the single
  new model; don't document two behaviors.
- **No migration:** old `.memory/<sessionId>/` banks are not read, copied, or deleted.
  `listTopics` etc. simply never look there.
- `.gitignore`: no automatic changes; document that `.memory/` stays local and
  git-ignored by user choice. Do keep lock/replay metadata out of version control in docs.

---

## 12. Tests

Rewrite around the new model; do not preserve legacy-behavior tests.

- **Delete:** `tests/session.memory.test.ts` (seeding), any journey/`updated` assertions
  in `tests/render.test.ts`, `tests/memory.paths.test.ts` cases for
  `.memory/<sessionId>/`.
- **Rewrite `tests/memory.paths.test.ts`:** three-root resolution from cwd; no parent
  walking; `resolveWithinMemory` against `projectDir`.
- **Rewrite `tests/render.test.ts`:** overview section, map without `updated`, bootstrap
  block budget truncation + dedupe fingerprint.
- **Rewrite `tests/consolidator.test.ts`:** lock acquire/release (atomic create, owner-
  checked release, busy deferral), outcome-file validation (missing/partial/extra
  outcomes → no tombstone), archive-before-drain, tombstone-only-still-active, index
  regeneration under lock, batch-id replay idempotence, session-id mismatch at commit.
- **New:** lock tests across two "processes" (two `Runtime` instances sharing a
  `projectDir`); flush tests (tail observation below chunk threshold + full-pool
  consolidation + reported counts); bootstrap injection tests (first request only,
  refresh on bank change, malformed file fallback); subagent-guard tests (env markers
  suppress activation even with a copied `om.enabled` entry; `OM_WORKER` early-return;
  plain fork without markers activates normally).
- **Keep:** pool/ledger/fold/projection/timeline/cost tests that are model-agnostic;
  `spawn.smoke.test.ts` updated for the new env/path split.
- Final acceptance pass against the proposal's Acceptance Criteria list, including the
  subagent compatibility checks (process-level marker/gate/lock tests + a real tmux smoke
  test with the installed subagent extension).

---

## 13. Docs

- **README.md — rewrite for the new model.** It currently documents the per-session
  bank (`.memory/<sessionId>/`, fork seeding, JOURNEY). Rewrite the storage section for
  the single cwd-scoped model: the three-root layout, `/om:consolidate --flush` for short
  sessions, lock behavior (cooperative, manual stale-lock cleanup), subagent policy (main
  agents publish, subagents report), "don't run upstream and this fork together",
  git-ignore guidance, the supported config keys (`overviewTargetTokens`,
  `bootstrapTokens`, etc. — no aliases), and the MVP limitation that multi-file
  consolidation is not transactional (readers may see a mix of complete old/new files;
  INDEX.md is rebuildable). Update the mermaid diagram, which shows
  `.memory/<session>/<topic>.md` as the durable tier.
- **PLAN.md — delete the file.** It is the upstream phase-implementation plan (Phase A /
  Phase B, per-session banks, decision log for the old model). It describes a design this
  fork no longer implements and has no ongoing role; the proposal
  (`project-scoped-proposal-update.md`) and this implementation plan supersede it. Do not
  keep it around "for reference" — that is exactly the two-systems documentation the
  proposal forbids.

---

## Suggested implementation order

1. §1 + §2 (paths/roots split) — everything else hangs off the three roots.
2. §3 + §5 + §6 (config rename, OVERVIEW, front matter) — mechanical, unblocks prompt work.
3. §4 (lock) in isolation with its tests.
4. §7 (consolidator pipeline: prompt, tools, outcome contract, archive, ordering).
5. §8 (flush) — builds on §7's dispatch rework.
6. §9 (bootstrap) — builds on §5's shared renderer.
7. §10 (guards) — small, but test last against real subagent launches.
8. §11–§13 cleanup, tests, docs.
