---
"@gqlens/core": patch
---

Release superseded operation keys as soon as their requests are aborted so a query selection that
returns to an earlier operation can start immediately instead of remaining unresolved.
