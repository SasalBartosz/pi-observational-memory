# Using observational-memory

A pi extension that gives your project a persistent, shared memory. While you work,
background **observers** distill the conversation into observations, and a **consolidator**
promotes established knowledge into a durable memory bank in your project directory
(`.memory/project/`). Every future pi session started in the same directory begins already
oriented — decisions, constraints, and conventions from earlier sessions are just there.

This guide covers installation and everyday use. For architecture and internals, see
[README.md](README.md).

---

## Installation

This package is a pi extension. Install it with pi's package manager:

```bash
pi install git:github.com/SasalBartosz/pi-observational-memory
```

To try it without installing, load it for a single run:

```bash
pi -e git:github.com/SasalBartosz/pi-observational-memory
```

Requirements:

- pi (the extension declares pi packages as peer dependencies, so a working pi install is
  all you need)
- a provider/model configured for the memory workers (see
  [Configuration](#configuration) — defaults point at OpenRouter models)

Verify it's loaded: run `pi` and type `/om` — you should see the on/off toggle respond.

## Getting started

### 1. Turn it on

The extension is **off by default** — completely invisible until you enable it. In any pi
session:

```
/om on
```

The state persists per session and survives resume. `/om` toggles, `/om off` disables.

### 2. Work normally

That's it. As you work:

- every ~10k tokens of conversation, a background **observer** subprocess distills what
  happened into observations (parallel, invisible to you);
- when the observation pool grows past its threshold, a background **consolidator** folds
  established knowledge into `.memory/project/` — the shared bank;
- anything speculative or half-finished stays in the session archive and never becomes a
  project "fact".

### 3. Flush before you leave

Thresholds may never fire in a short session. Before ending one, run:

```
/om:consolidate --flush
```

This is the only guaranteed publish: it observes the remaining conversation, consolidates
the whole pool, and reports promoted / retained / discarded counts when done. If you skip
it, observations stay in the session archive — kept, but not shared with future sessions.

### 4. Reap the benefits

Start pi again from the **same directory** and the new session is bootstrapped with the
project's OVERVIEW and topic index automatically. No command needed.

> Memory is scoped to your current working directory. To share memory across sessions,
> always start pi from the same directory (typically the project root).

## Commands

| Command | What it does |
|---|---|
| `/om`, `/om on`, `/om off` | Enable/disable the extension for this session |
| `/om:status` | Workers in flight, pool state, bank stats, lock state, session cost |
| `/om:compact` | Force a context compaction now |
| `/om:consolidate` | Force consolidation of the overflow now |
| `/om:consolidate --flush` | **Publish everything before ending a session** |

## Where things live

Everything is under your project's working directory:

```text
<cwd>/.memory/
├── project/                  ← the shared, durable bank (INDEX.md, OVERVIEW.md, topics)
├── sessions/<id>/archive/    ← per-session batch archives (kept, not shared)
└── runtime/                  ← transient worker IPC files (safe to clean periodically)
```

- The bank is plain Markdown — you can read it, and so can the agent (it's just files).
- **Add `.memory/` to your `.gitignore`** — it's local state, and the lock file and runtime
  metadata must never be committed.
- Worker subprocesses are ordinary recorded pi sessions; open them in the session browser
  if you want to inspect exactly what the observers/consolidator saw and did.

## Configuration

Settings live under the `observational-memory` namespace in `~/.pi/agent/settings.json`
(global) or `.pi/settings.json` (project overrides global). You only need this to change
defaults:

```jsonc
{
  "observational-memory": {
    "models": {
      "observer":     { "provider": "openrouter", "id": "z-ai/glm-5.3", "thinking": "low" },
      "consolidator": { "provider": "openrouter", "id": "z-ai/glm-5.3", "thinking": "medium" }
    },
    "chunkTokens": 10000,              // conversation size per observation chunk
    "consolidateAtPoolTokens": 15000,  // pool size that triggers consolidation
    "compactAtContextTokens": 150000,  // context usage that triggers compaction
    "observerConcurrency": 4
  }
}
```

See the [README](README.md#configuration) for the full list of knobs.

## Multiple sessions at once

Running several pi sessions in the same directory is fine — consolidation is coordinated by
a lock file (`.memory/project/.consolidation.lock`). Background runs simply defer when the
lock is busy; `--flush` waits up to 60 s for it.

If a session crashed while holding the lock, `/om:status` will report the lock as **stale**.
Cleanup is manual: verify the recorded pid is actually dead, then delete
`<cwd>/.memory/project/.consolidation.lock`.

## FAQ

**Do I need to run anything at exit?**
No — nothing happens at exit by design. If you want the session's knowledge published, run
`/om:consolidate --flush` yourself before leaving.

**Does it work with subagents?**
Yes, automatically. Subagent sessions don't run the memory pipeline; their results flow
back to the main session, whose observers pick them up.

**Can I use it in other launchers/scripts?**
Set `PI_OM_PASSIVE=1` to disable all triggers while keeping the extension loaded.

**I used the upstream per-session version before.**
Don't run both in the same project — you'd get two pipelines observing the same
conversation. Old per-session banks are simply never read; pick one package.

**How much does it cost?**
Workers are real pi subprocesses, so their spend is tracked. `/om:status` shows
`session cost: $X (N runs)`.
