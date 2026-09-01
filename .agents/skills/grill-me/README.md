# Grill Me

A read-only interview skill for pressure-testing ideas, plans, product decisions, architectures, and research proposals before implementation.

Grill Me asks exactly one consequential question at a time, recommends a position with its main trade-off, tracks facts and assumptions, reopens contradictory decisions, stress-tests failure modes, and converges on a copyable decision brief.

> 中文简介：这是一个用于严谨追问与压力测试的只读 Skill。它不会替你实施方案，而是通过一次一个关键问题，将模糊想法收敛为可执行的决策简报。

## Core behavior

- Prioritizes questions by impact, uncertainty, dependency centrality, and reversal cost.
- Resolves discoverable facts through read-only inspection before asking the user.
- Separates verified facts, assumptions, decisions, risks, and unresolved questions.
- Detects contradictions and reopens decisions that depend on invalidated premises.
- Stops when remaining uncertainty is local, inexpensive, or reversible.
- Never edits files, sends messages, deploys, purchases, schedules, or otherwise implements the plan while the skill is active.

The canonical portable skill is [`SKILL.md`](./SKILL.md). The Claude Code variant is [`claude-code/SKILL.md`](./claude-code/SKILL.md); it adds explicit command metadata while keeping the interview body identical.

## Install

### Codex and Agent Skills-compatible clients

Install for the current user:

```bash
git clone https://github.com/liq22/grill-me.git "$HOME/.agents/skills/grill-me"
```

Or copy the repository root into a project-local skill directory:

```bash
mkdir -p "$REPO_ROOT/.agents/skills/grill-me"
cp SKILL.md "$REPO_ROOT/.agents/skills/grill-me/SKILL.md"
cp -R evals "$REPO_ROOT/.agents/skills/grill-me/evals"
```

Then explicitly select or mention the `grill-me` skill with the idea or decision to examine.

### Claude Code

```bash
git clone https://github.com/liq22/grill-me.git /tmp/grill-me
mkdir -p "$HOME/.claude/skills/grill-me"
cp -R /tmp/grill-me/claude-code/. "$HOME/.claude/skills/grill-me/"
```

Invoke it explicitly:

```text
/grill-me your idea, plan, design, or decision
```

## Interaction contract

Each interview turn contains one decision question, a concrete recommendation, and the principal trade-off. The supported control replies are:

- `accept` — record the recommendation as the decision.
- `change: ...` — record an alternative and update dependent decisions.
- `unknown` — choose a reversible default or define the cheapest useful validation step.
- `skip` — defer the decision and record the consequence when material.
- `summary` — show the current ledger, then continue with one next question.
- `stop` — produce the best available decision brief and end the session.

Final approval closes the interview. It never authorizes implementation; implementation requires a separate explicit request after the skill ends.

## Repository layout

```text
.
├── SKILL.md                         # Canonical portable skill
├── evals/
│   ├── eval_queries.json            # Trigger and non-trigger cases
│   └── evals.json                   # Output-quality cases
├── claude-code/
│   ├── SKILL.md                     # Explicit /grill-me command variant
│   └── evals/                       # Matching evaluation data
├── scripts/validate.py              # Dependency-free repository checks
└── .github/workflows/validate.yml   # CI validation
```

## Validate

```bash
python3 scripts/validate.py
```

The validator checks frontmatter invariants, version consistency, identical interview bodies across variants, valid evaluation schemas, unique evaluation IDs, and synchronized evaluation data.

## Version

Current skill version: `2.0.0`.

## License

[MIT](./LICENSE)
