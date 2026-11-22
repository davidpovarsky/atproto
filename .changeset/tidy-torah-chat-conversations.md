---
'torah-appview-service': patch
---

Create new direct conversations atomically using a stable full-SHA256 pair ID and
the existing primary key, preserving legacy conversation IDs. Return truthful empty
request lists for the accepted-only chat model, honor direct/group list filters,
and validate list limits. Add real
PostgreSQL race-interleaving, atomic rollback, and legacy-ID regression coverage.
