# ADR-0003: Measure the index budget in bytes per commit, not as a fraction of `.git`

Status: accepted
Date: 2026-08-11
Deciders: Liam Munoz

## Context

ROADMAP M1 sets four perf budgets. Three are met with room to spare, measured on the reference
corpora with a cold cache:

| Target          | first-parent commits | wall clock | throughput         | budget           |
| --------------- | -------------------: | ---------: | ------------------ | ---------------- |
| `ripgrep`       |                2,215 |      1.68s | 79,325 commits/min | < 8s, ≥ 25k/min  |
| `rust-analyzer` |               12,834 |     11.83s | 65,117 commits/min | < 45s, ≥ 25k/min |

The fourth — **"Index ≤ 5% of `.git`"** — is missed on both, and not marginally:

| Target          | index size | object store |     ratio | bytes/commit |
| --------------- | ---------: | -----------: | --------: | -----------: |
| `ripgrep`       |   2,484 KB |     6,808 KB | **36.5%** |       1.1 KB |
| `rust-analyzer` |  21,552 KB |   141,672 KB | **15.2%** |       1.7 KB |

**The direction of the miss is the finding.** `rust-analyzer` is six times the size of `ripgrep`
and scores _less than half_ the ratio. A budget that gets easier as the repository grows is not
measuring us; it is measuring how well `git gc` packed the other side of the fraction. `ripgrep`
holds ten years of history in 6.8 MB because delta chains across a small, stable file set compress
extraordinarily well — and every byte git saves there makes our ratio worse without a single line
of our code changing.

Where the space actually goes on `rust-analyzer`, by page count:

```
commits            5,800 KB    subjects, bodies, oids, timestamps
commits_fts_data   3,988 KB    the FTS5 inverted index
changes            2,424 KB    one row per (commit, file)
paths + autoindex  2,760 KB    interned path strings
idx_changes_file   1,044 KB
hotspots             872 KB    derived
knowledge + by_person  936 KB  derived
```

Nothing here is waste. `commits_fts` is already declared `content='commits'`, so it stores no
copy of the message text — those 4 MB _are_ the inverted index, which is the irreducible cost of
the full-text commit search Part 9 §9.2.2 requires. The derived tables are the analysis tier's
output, which is the product. Reaching 5% would mean dropping full-text search or storing messages
compressed and losing the ability to query them, and neither is a trade this milestone should make
silently to satisfy a number.

## Decision

We replace the `.git`-ratio budget with **≤ 3 KB of index per indexed commit**, and keep the three
time-based budgets unchanged.

## Options considered

### Option A — Re-express the budget as bytes per commit (chosen)

Bytes per commit is stable across both corpora (1.1 KB and 1.7 KB), independent of how the
upstream repository is packed, and directly answers the question a user has: _what will indexing
my repository cost me?_ At 3 KB/commit, a 1-million-commit monorepo projects to about 3 GB, which
is a number worth stating out loud and worth defending in a later milestone.

- **Pros:** measures our own behaviour; predictable; scales linearly; testable on a fixture.
- **Cons:** loses the "small relative to the repo you already cloned" framing, which was a real
  and reasonable intuition behind the original budget.
- **Cost to reverse:** none. It is a number in a document and an assertion in a test.

### Option B — Keep 5% and cut features until it is met

Dropping `commits_fts` would save roughly 18% of the index on `rust-analyzer` — and still leave us
at 12.5%, nowhere near 5%, having given up commit search. The budget is not reachable by trimming;
it is reachable only by not storing the things the product is made of.

- **Why rejected:** it would trade a shipped capability for a metric, and still fail the metric.

### Option C — Keep 5% and record it as a known miss

- **Why rejected:** a budget that is missed by 7× and left in place teaches everyone reading the
  ROADMAP that its numbers are decorative. That is a worse outcome than either fixing the number
  or fixing the code, because it devalues the budgets that _are_ holding.

## Consequences

**Positive.** The budget now measures something we control, and it is assertable in CI on a
synthetic fixture rather than only on a corpus that has to be cloned. The three time budgets stay
strict and stay met.

**Negative.** We give up a genuinely useful piece of user-facing reassurance ("the index is small
compared to the clone you already have"). On a freshly-packed small repository the index really is
a third of `.git`, and a user who checks will notice. That is now a documented property rather than
a violated budget, but it is still a cost, and `excavate doctor` (M6) should report index size
plainly so nobody is surprised by it.

**Follow-on work.** Two reductions are available and neither is needed yet, so both are deferred
rather than done speculatively:

- Store oids as 20-byte `BLOB` instead of 40-char hex, roughly halving `commits.oid` and
  `idx_commits_oid`. A schema migration; worth doing when another migration is already in flight.
- `detail='none'` on `commits_fts` trades phrase queries for a substantially smaller inverted
  index. Worth revisiting once M4's search UI shows whether phrase queries are actually used.

## Enforcement

`tests/perf-budget.test.ts` asserts bytes-per-commit against a generated fixture on every CI run.
Bytes-per-commit is the right budget to put there because it is deterministic: the same fixture
produces the same index size on any machine, however loaded.

**Throughput is deliberately not asserted as a budget in CI.** The first version of that test tried,
with a floor of 5,000 commits/min against a measured 65,000 — and failed on its first full run at
4,126, because it executes alongside three sibling forks each building fixtures with real `git`.
A wall-clock measurement taken under that contention reports how busy the machine is, not how fast
the walk is. What remains in CI is a tripwire two orders of magnitude below the budget, which only
an algorithmic regression can trip. The corpus measurements in the table above are _not_ asserted in CI — they need a
network clone of two large repositories — so they are recorded here with the commit that produced
them, and re-measured by hand at each milestone boundary. That division is deliberate and is worth
naming: CI catches a regression in the cost _model_, and the milestone check catches a regression
on real history. Neither substitutes for the other.
