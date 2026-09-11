# Decisions (ADRs)

One file per architectural decision: `<NNNN>-<slug>.md`. Numbers are the identity
— never renumber an existing ADR. In a single-session project use the serial low
range `0001, 0002, …`. When several sessions run in parallel, partition the number
space per session (session 1 → `0100`s, session 2 → `0200`s, …) so numbers stay
unique by construction.

## Template

```markdown
# <NNNN> — <Title>

- Status: proposed | accepted | superseded by <NNNN> | abandoned
- Date: <ISO date>

## Context
<the forces at play — what made this a decision>

## Decision
<what we chose>

## Consequences
<what this makes easy, what it makes hard, what it rules out>
```
