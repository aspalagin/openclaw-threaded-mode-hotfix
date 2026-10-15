# Hotfix notes

Tested baselines: the DM topic adopt hotfix for OpenClaw `2026.9.7` (verified
in production on 2026-10-12), the sub-agent owner scope hotfix for OpenClaw
`2026.9.7` (verified in production on 2026-10-15) and the focused thread-model
hotfix for OpenClaw `2026.7.1-2`. The earlier full-layer scripts for OpenClaw `2026.6.10` and
`2026.6.11` were removed from `main` (see git history and tag `v2026.6.11-1`);
the notes below keep the history of what that layer fixed.

OpenClaw `2026.9.7`, `dm-topic-adopt`:

- Since 2026-10-09 one Telegram client (Android) creates the private topic but
  sends the user's message to the root chat: the bot gets `forum_topic_created`
  with the new `message_thread_id` and, in the same second, the message without
  `message_thread_id`. Every observed failure was exactly this pair (same
  `date`, consecutive `message_id`).
- The fix lives in `resolveTelegramMessageThreadSpec`, because lane keys,
  authorization, message context, native commands, debounce and reply chains
  all go through it. Pending topic per `chat:user`, adoption window 3 s,
  adopted ids cached per `chat:message_id`, bot-created topics and groups
  ignored, visible `[hotfix][dm-topic-adopt] adopted ...` log line.
- The user's message itself stays in the root chat on the Telegram side; only
  the OpenClaw session, typing and reply move into the topic.

OpenClaw `2026.9.7`, `subagent-owner-scope`:

- Every child run started by `sessions_spawn` ran as a non-owner: the
  dispatcher launched the gateway `agent` call with least-privilege scopes
  (no `operator.admin`), the handler derived `senderIsOwner = false` and the
  owner-only core tools (`nodes`, `computer`, `mobile_ui`, `sessions`,
  `terminal`, `portal`, `conversations_*`, `openclaw`, `screen`) were denied to
  the child even when the parent run was the owner's. First noticed when a
  sub-agent of a guest turn could not reach `nodes`; the cause is independent
  of guest mode and affects sub-agents of ordinary owner sessions too.
- The fix forwards the parent's `senderIsOwner` into `createSessionsSpawnTool`
  and from there into the spawn context, and `launchChildRun` sets
  `scopes: ["operator.admin"]` on the `agent` request only when it is `true`.
  The dispatcher's existing `params.scopes ?? …` contract carries it; no new
  authorization path is introduced, and non-owner parents are unchanged.
- The standalone updater bundle (`dist/package-update-activation-recovery.mjs`)
  contains a copy of both patched functions; it is not part of the gateway
  runtime and is excluded from the bundle locator so the needles stay unique.
- Verified on a live install: a sub-agent spawned from an owner session called
  `nodes status` successfully after the gateway restart.

The production issues fixed by the earlier layer:

- Telegram DM topic sessions were created correctly, but delivery must stay on
  Bot API `message_thread_id`.
- Using `direct_messages_topic_id` for this OpenClaw path can send rich replies
  to the root DM instead of the selected topic.
- A terminal `done + pendingFinalDelivery` session was not recovered after a
  restart, so a generated final answer could be lost.
- Later successful delivery in the same session could clear an older pending
  final unless the clear path compared the delivered payload.
- Telegram DM topic auto-label only ran on the first turn of a fresh
  thread-session. After `/new`, the acknowledgement itself marked the OpenClaw
  session as having assistant output, so the next substantive user message no
  longer renamed the Telegram topic.
- Native slash-command updates can expose a Telegram private-topic id as
  `direct_messages_topic.topic_id` instead of `message_thread_id`, so `/new`
  could fail to re-arm auto-label in that topic unless the id was normalized.
- The native slash path now resolves that id from both the normalized message
  and the raw update, records it as the slash inbound thread id, and logs the
  selected topic id for diagnosis.
- The bare `/new`/`/reset` session boundary lived only in an in-memory Map, so
  any gateway restart between `/new` and the next user message erased it, and
  native slash messages never reached the persistent Telegram message cache —
  the disk-backed boundary lookup always came back empty. The native slash
  handler now records the boundary command into the shared persistent message
  cache, and the key auto-label diagnostics are emitted as visible
  `[hotfix][auto-topic-label]` console lines instead of swallowed verbose logs.
- The inserted boundary lookup referenced a `messageCache` binding that does
  not exist in the dispatch-function scope, throwing `messageCache is not
  defined` on every DM-topic message; the lookup now builds the cache in place
  (the bucket is shared, so it is the same persistent cache).
- The "first user message after the boundary" check compared the current
  message against the latest user message at-or-before itself — which is
  always the current message — so once the boundary persisted, the topic was
  renamed on every reply. The check now looks for a prior non-empty
  non-boundary user message strictly between the boundary and the current
  message and allows the rename only when none exists.
- Codex responses models (for example `gpt-5.6` via the codex app-server) do
  not receive `systemPrompt`, so the conversation/topic label generator got a
  conversational reply truncated to the length limit instead of a short label.
  The label instruction is now embedded into the user message itself and only
  the first non-empty line of the reply is used, stripped of wrapping
  quotes/markdown (`conversation-label-prompt-inline`).
- A user model selected in the parent Telegram DM session was inherited by new
  DM-topic sessions. Because `/new` also preserved explicit user selection, one
  model choice could survive new sessions and spread to newly created topics.
  The `2026.7.1-2` patch blocks only derived parent inheritance for Telegram DM
  topic keys, while keeping explicitly supplied parent session keys intact.
- `/new` now opts out of preserving a user model override and returns to the
  configured agent model. `/reset` and programmatic `sessions.reset` keep their
  previous model-preserving behavior.

Operational rules:

- Keep the Telegram target as `telegram:<chatId>`.
- Store topic id in OpenClaw metadata as `threadId`.
- Use composite session keys only for OpenClaw identity, not as Telegram
  delivery targets.
- Treat `/new` and `/reset` as session-boundary commands for auto-labeling:
  `/new text` labels immediately from `text`; bare `/new` labels from the first
  normal user message that follows in the same DM topic.
- Use `direct_messages_topic.topic_id` only as a private-topic id fallback for
  command/message context. Do not use `direct_messages_topic_id` for rich
  message delivery in this OpenClaw path.
- Run the checker after every OpenClaw package update.
- Treat the model override as topic-local. A model selected in one Telegram DM
  topic must not affect the root DM or neighboring topics.

This repository intentionally omits host-specific production notes, node ids,
private paths, tokens, IP addresses, and operator chat ids.
