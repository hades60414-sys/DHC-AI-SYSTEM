# Collision Guard

Use this reference before launching two or more agents that may write, and whenever another session might be working in the same folder. Collisions come from three places: siblings writing the same artifact, siblings redoing the same reads, and parallel parent sessions that do not know about each other.

## 1. Ownership before launch

Write the ownership map (see dispatch-planning.md) before any brief. Each writer gets exclusive globs plus an explicit do-not-touch list.

- Any overlap in globs means those tasks run in sequence, not in parallel.
- Partition by what changes, not only by file: a function, endpoint, table, config key, or registry entry. Two workers editing different files can still break each other when one replaces a module the other extends.
- Run replace, rename, and delete work alone or first. Then fan out on the new base.
- Shared registries, manifests, indexes, lockfiles, migration numbering, `MEMORY.md`, and build output belong to the parent. Workers propose edits to them in their report and do not make them.
- Only the parent installs packages, restarts services, or rebuilds shared outputs.

## 2. Isolate writers

- Git repo: prefer `isolation: "worktree"` for each writer. Worktrees do not isolate ports, databases, or files outside the repo; assign those explicitly.
- Not a git repo: give each worker its own output folder (`<task>/out/<worker>/`), or exclusive globs in the shared folder. The parent promotes results.
- Read-only scouts and reviewers can run in parallel freely. Keep concurrent writers to two or three.

## 3. Briefs that prevent duplicate work

Add these lines to every brief in a fan-out:

```markdown
## You own (exclusive write)
<globs>
## Do not touch (owned by others or by the parent)
<globs and shared registries>
## Already covered by other agents — do not redo
<agent>: <scope>
## Already known — do not re-search
<facts, paths, queries already run>
## Status to return
DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED, plus changed files
```

Run the common searches once in the parent and pass the results as a context pack, rather than letting each worker rediscover them.

## 4. Check every worker's diff

Do not accept a writer's report until its changes match its ownership.

```
node <skill>/scripts/owned-diff.cjs snap  <root> <task>/snap.json          # once, before dispatch
node <skill>/scripts/owned-diff.cjs check <root> <task>/snap.json <mine...> --also <other workers' globs...>
```

`check` exits 1 and lists `OUTSIDE` files when a worker touched something it does not own. With git, `git diff --name-only` against the starting commit does the same job. On a violation, inspect the file, restore it from backup if the change is wrong, and tighten the next brief. Never silently keep an out-of-scope edit.

After integration, verify the merged result. Every worker passing alone does not prove the combined state works.

## 5. Parallel parent sessions

Several sessions (other chat windows, colleagues, night-queue runs) may target the same folder. Before writing in a shared workspace:

1. Check live peers with `ListAgents` when available, and the folder's claim file `<workspace>/.claims.md`.
2. If a live peer claims overlapping files, message it with `SendMessage` and agree who owns what, or wait. Do not start a parallel copy of the same task.
3. Add a claim line, and delete it or mark it done when finished:

```
| session or agent | started | expires | files or scope | status |
```

Treat claims older than their expiry as stale, but check the files' modification times before reusing them.

## 6. Durable ledger

For multi-step dispatch, keep `<task>/progress.md`: one line per unit with owner, status, and evidence path. After compaction or resume, read it before dispatching anything so finished units are not redone.

## Sources (ideas paraphrased, no text copied)

- Anthropic, "How we built our multi-agent research system" (2025): vague briefs cause duplicate searches; scale agent count to the task.
- Claude Code docs: agent teams (one owner per file, task claims), subagents share the parent's working directory by default, worktree isolation.
- obra/superpowers (MIT): dispatching-parallel-agents, subagent-driven-development (status codes, progress ledger).
- wshobson/agents agent-teams plugin (MIT): directory ownership, contracts before fan-out.
- MCP Agent Mail: advisory, time-limited file reservations.
- dev.to "what worktrees cannot see" (2026): partition by what changes; risky renames first; test the merged result.
