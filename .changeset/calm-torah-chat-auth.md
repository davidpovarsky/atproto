---
'torah-appview-service': patch
---

Require the standard AppView service-JWT verifier for every chat route, accept
the advertised chat audience, and count eligible unread conversations using the
existing accepted-only chat schema. Bind read markers to their conversation and
authorize all batch memberships before writing messages. Add executable
cryptographic and PostgreSQL regression coverage.
