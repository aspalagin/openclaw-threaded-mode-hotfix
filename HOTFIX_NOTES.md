# Hotfix notes

Tested baselines: OpenClaw `2026.6.10` legacy scripts and OpenClaw
`2026.6.11` current scripts.

The production issue fixed by this layer:

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

This repository intentionally omits host-specific production notes, node ids,
private paths, tokens, IP addresses, and operator chat ids.
