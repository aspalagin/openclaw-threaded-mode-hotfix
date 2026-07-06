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

Operational rules:

- Keep the Telegram target as `telegram:<chatId>`.
- Store topic id in OpenClaw metadata as `threadId`.
- Use composite session keys only for OpenClaw identity, not as Telegram
  delivery targets.
- Treat `/new` and `/reset` as session-boundary commands for auto-labeling:
  `/new text` labels immediately from `text`; bare `/new` labels from the first
  normal user message that follows in the same DM topic.
- Run the checker after every OpenClaw package update.

This repository intentionally omits host-specific production notes, node ids,
private paths, tokens, IP addresses, and operator chat ids.
