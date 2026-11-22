---
'torah-appview-service': patch
---

Implement direct-conversation availability without creating conversations and
enforce the indexed recipient declaration, follow relationship, actor status, and
bidirectional blocks at creation and send boundaries. Preserve existing accepted
direct chats after incoming-privacy changes. Return the current actor-status
schema while accurately declaring group creation unavailable.
