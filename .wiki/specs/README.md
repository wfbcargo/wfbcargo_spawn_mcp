# Specs

Per-spec notes that outlive the branch: `<8id>_<slug>.md`. The orchestrator writes
one before spawning implementation work; the `spec-audit` agent checks the
implementation against it. Mark a spec `status: abandoned` at the top rather than
deleting it, so future agents see the history.

## Template

```markdown
---
spec_id: <8hex>
status: active | in_progress | implemented | abandoned
---
# <Spec name>

## Objective
<the single coherent intent — one checkable objective>

## Acceptance criteria
- <criterion the change is audited against>

## Notes
<anything a future maintainer will want that isn't in the diff>
```
