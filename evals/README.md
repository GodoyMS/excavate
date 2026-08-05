# Evals

Thirty golden cases and their harness, arriving in **M7** with the AI layer.

Trimmed from 200 (LEAN-V1 §3.3), and deliberately **weighted toward adversarial**
rather than spread evenly across happy paths:

- hallucinated citation IDs
- `must_not_claim` assertions
- prompt injection in commit messages
- ungrounded numerics — the most damaging and most common failure mode
- "genuinely unrecoverable → must refuse"

The reasoning for the cut, from LEAN-V1 §3.3: _the validator is 90% of the protection
and is cheap; the corpus grows over time._ Every rejected generation found in the wild
becomes a case here.

```
evals/
├── golden/          # 30 labelled cases
├── harness/
└── results/         # committed — quality history lives in git
```

`results/` is checked in on purpose. Eval scores are a time series, and a regression is
only visible if the previous number is in the repository.

**The offline suite must pass with no provider configured.** That is rule B5, and it is
never cut.
