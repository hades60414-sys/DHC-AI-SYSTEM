---
name: spark-worker
description: >
  Opportunistically delegate narrow, well-defined, reversible, and
  mechanically verifiable work to GPT-5.3-Codex-Spark. Spark is an
  optional accelerator only. The parent agent retains full discretion
  to bypass, stop, replace, or redo Spark work at any time.
---

# Spark Worker

GPT-5.3-Codex-Spark is a high-speed implementation and exploration worker.

It should be treated as available compute, not as a mandatory workflow stage.

## Harness integration and availability

This Codex-only skill complements `baton-dispatch`: use that skill for task topology and ownership when needed; use this policy for optional Spark selection. Active platform permissions, user instructions, and concurrency limits still apply.

The harness installs `spark_explorer` (read-only) and `spark_worker` (workspace-write) under `~/.codex/agents/`. Both request `gpt-5.3-codex-spark` at medium reasoning effort. Keep the parent model unchanged.

Check the current client's exposed models and custom-agent support before dispatch. Installed definitions do not prove model access. If Spark is unavailable, rate limited, unsupported, or rejected, continue with ASTRA/the parent; avoid repeated infrastructure retries. Do not silently substitute another model and call it Spark.

## Parent authority

The parent agent, especially ASTRA, has absolute authority over delegation.

ASTRA MAY:

- perform an eligible Spark task itself
- delegate only part of a task
- stop a Spark task at any point
- discard a Spark result
- redo Spark's work itself
- escalate directly to a stronger model
- use a different subagent
- avoid delegation when maintaining context is more valuable

Do NOT interpret these routing rules as restrictions on ASTRA.

The objective is total task quality and throughput, not maximum Spark utilization.

## Good Spark candidates

Consider Spark for:

- repository exploration
- locating files/functions/references
- tracing a simple code path
- small targeted code edits
- repetitive implementation
- straightforward TODO implementation
- syntax errors
- lint/type fixes
- writing or updating tests
- running tests and reporting failures
- CSS/layout adjustments
- simple frontend changes
- straightforward PHP edits
- simple SQL/query modifications
- renaming/refactoring repetitive code
- documentation updates
- formatting
- mechanical migrations
- checking compatibility
- validation after implementation

## Usually keep with ASTRA

Prefer the parent agent for:

- system architecture
- architectural tradeoffs
- ambiguous requirements
- cross-system design
- database architecture/schema design
- security-sensitive decisions
- difficult root-cause analysis
- unfamiliar or poorly understood systems
- broad refactors with large blast radius
- destructive migrations
- tasks requiring substantial global context
- decisions where several valid approaches exist
- tasks whose implementation and reasoning are tightly coupled

These are heuristics, not hard prohibitions.

ASTRA may still use Spark if it believes delegation is beneficial.

## Delegation economics

Before delegating, implicitly consider:

delegation benefit
=
expected execution savings
- context transfer cost
- review cost
- coordination cost
- risk of incorrect implementation

If delegation overhead is comparable to or greater than doing the work directly,
ASTRA should do the work itself.

Do not spawn Spark merely to satisfy this Skill.

## Context preservation rule

Avoid delegation when the parent currently holds important implicit context
that would be expensive or risky to reconstruct for Spark.

Maintaining reasoning continuity is a valid reason to bypass Spark.

## Abandonment rule

ASTRA should abandon Spark immediately when any of these occur:

- Spark misunderstands the task
- the task becomes more complex than expected
- architectural judgment becomes necessary
- requirements become ambiguous
- Spark lacks required context
- Spark proposes broad/unnecessary changes
- validation repeatedly fails
- reviewing Spark takes longer than doing the task
- parent-agent context is required to proceed safely
- delegation begins slowing down the overall task

ASTRA does NOT need to justify continuing without Spark.

## Retry policy

Default maximum:
2 Spark repair attempts for the same narrow failure.

This is NOT a hard limit.

ASTRA may:
- stop after zero or one attempt
- allow additional attempts
- immediately take over itself

Use judgment.

## Implementation policy

When delegating implementation:

1. Give Spark a narrow objective.
2. Include acceptance criteria.
3. Include relevant files/subsystem when known.
4. Tell Spark not to redesign unrelated architecture.
5. Prefer small diffs.
6. Require appropriate validation.
7. Review the result before relying on it.

## Optimization objective

Optimize for:

1. correctness
2. maintainability
3. total task completion time
4. reasoning quality
5. efficient use of available model capacity

Do NOT optimize for Spark utilization percentage.

Unused Spark quota is acceptable.
