# Reconcile log — {{GAME_NAME}}

Append-only. Every landing and every verdict, newest at the bottom. This is what tells a
future reconcile that a head bump was the conductor's OWN push and not a Savi task — the
same trick team mode uses to rule out a teammate, turned on yourself.

Format, one line each:

```
<iso> · head vN · <own-push | savi> · <task title> · <verified | reopened: reason>
```

## Own pushes

The conductor's own lane pushes, so reconcile doesn't credit them to a dispatched task.

## Landings
