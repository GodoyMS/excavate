# Prompts

Versioned templates, one directory per pipeline, per
[Part 14 §14.4](../docs/spec/14-repository-structure.md): `prompts/<pipeline>/v<N>.md`.

**Templates are versioned, never edited in place.** A prompt change that silently
alters output makes every eval result and every cached generation before it
incomparable. Add `v2.md`; leave `v1.md` alone.

Each template is split into a **static** half — identical across every request for that
version, placed first so a provider can cache it — and a **volatile** half, which is
the evidence bundle. CI asserts cache effectiveness, which is only possible because the
split is explicit. See `RenderedPrompt` in [`@excavate/ai`](../packages/ai).

Lean v1 ships two pipelines (LEAN-V1 §3.3), both arriving in **M7**:

```
prompts/
├── era_narration/v1.md
└── why_synthesis/v1.md
```

Every template must state the citation contract in its own words and must instruct the
model that uncited sentences will be rejected — but the instruction is not the
guarantee. The [validator](../packages/ai) is.
