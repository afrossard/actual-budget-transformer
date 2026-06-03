# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the project's glossary.
- **ADRs** — new decisions live in **`docs/adr/`** (`0001-…` onward); the seven original ADRs (`adr-001` … `adr-007`) remain under **`docs/archive/`** as historical record. Read whichever touch the area you're about to work in, checking both folders.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a single-context repo (one Python package, `src/actual_budget_transformer/`):

```
/
├── CONTEXT.md                 ← project glossary
├── docs/
│   ├── adr/                   ← canonical home for new ADRs (0001-…)
│   └── archive/               ← original ADRs (adr-001 … adr-007) + design notes
└── src/actual_budget_transformer/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts adr-003 (standalone importer, not writer) — but worth reopening because…_
