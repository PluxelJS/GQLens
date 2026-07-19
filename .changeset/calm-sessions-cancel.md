---
"@gqlens/core": minor
"@gqlens/react": patch
---

Give query sessions ownership of their fetch cancellation signals and dispose sessions when their
last React lease is released. React StrictMode effect replay no longer closes live transports or
releases shared sessions before the committed mount is actually removed.
