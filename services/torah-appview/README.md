# Torah AppView chat runtime

The chat router uses the same standard service-JWT verifier as the AppView.
It requires a verified actor issuer, the configured audience, and the exact
requested lexicon method. Public AppView routes pass through the chat router.

## Service audience

Set `TORAH_APPVIEW_CHAT_DID` to the bare DID advertising `#bsky_chat`.
When unset it defaults to the `did:web` identity derived from
`TORAH_APPVIEW_PUBLIC_URL`'s host. For the current deployment:

```text
TORAH_APPVIEW_CHAT_DID=did:web:appview-130-110-238-163.nip.io
```

The client's proxy header appends `#bsky_chat`; the JWT audience does not.
The AppView's primary signing-key DID remains a valid audience.
Issuer signing keys are resolved through the AppView dataplane; a static
PDS public-key environment variable is not an authentication mechanism.

The container starts `node --enable-source-maps index.ts` on Node 24.
Local imports deliberately use `.ts` so direct execution works.
The build config rewrites these extensions when producing optional `dist` output.

## Unread counts

The existing chat tables represent accepted conversations without request,
lock, or pending join-request state. Therefore `unreadRequestConvos` is zero.
Accepted counts use unread incoming messages, exclude muted conversations,
honor `includeGroupChats`, exclude unavailable or blocked direct peers
(including bidirectional list blocks), and cap at 100.

Read markers belong to the same conversation and retain their position when
a read message is deleted. Batch membership is checked before any message
is written. The existing `getLog` endpoint remains an authenticated empty
event log; this change does not add event-history storage.

## Direct conversation availability

`getConvoAvailability` only reads existing data. It returns an existing direct
conversation when present and never creates one. New chats honor the recipient's
indexed `chat.bsky.actor.declaration/self`: missing declarations default to
`following`, requiring the recipient to follow the sender. Invalid or unknown
settings do not enable messages. Creation and sending enforce the same policy.

Existing accepted direct conversations remain usable after incoming-message
settings change, while unavailable actors and blocks in either direction still
prevent sending. The existing service has no group-creation implementation:
`getStatus` reports the current schema with `canCreateGroups: false` and
`groupMemberLimit: 0`, and `getConvoForMembers` only creates direct chats.
Existing group membership records are preserved.

New direct pairs use a full SHA256 identifier of the sorted, JSON-encoded DIDs;
legacy conversation IDs are reused. A single SQL statement creates the conversation
and both memberships atomically, with the existing primary key serializing
simultaneous creation. Identifiers do not grant access: every conversation access
still requires verified membership. Request-list queries return an empty list
because the legacy tables contain accepted memberships only. Direct/group list
filters use actual membership counts, so direct-only clients do not receive groups.

## Verification

Run from `services/torah-appview` after building workspace dependencies:

```sh
pnpm test:unit
TORAH_CHAT_TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:15432/chat_test pnpm test
pnpm run verify:types
```

The security suite executes the installed AppView's compiled AuthVerifier
with real P256 and Secp256k1 signatures and a fixture identity-key resolver.
The SQL suite requires an isolated empty PostgreSQL database. It refuses an
existing `torah_appview` schema and creates its fixtures inside transactions
that are rolled back. Missing database configuration fails the SQL suite.
No production credentials or message content are needed.

This package is intentionally excluded from the root Vitest unit workspace:
its complete suite requires PostgreSQL, but no Redis service.
