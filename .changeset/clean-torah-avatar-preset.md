---
'torah-appview-service': patch
---

Accept the client's avatar_thumbnail URL prefix through the existing avatar
image route, preserving validators, cache behavior, and own-service resolution.
Guard middleware ordering and verify GET/HEAD, passthrough, and invalid-parameter
behavior using real Express routing and the installed image processor.
