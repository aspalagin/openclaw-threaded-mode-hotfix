# Hotfix notes

Tested baseline: OpenClaw `2026.6.10`.

The production issue fixed by this layer:

- Telegram DM topic sessions were created correctly, but delivery must stay on
  Bot API `message_thread_id`.
- Using `direct_messages_topic_id` for this OpenClaw path can send rich replies
  to the root DM instead of the selected topic.
- A terminal `done + pendingFinalDelivery` session was not recovered after a
  restart, so a generated final answer could be lost.
- Later successful delivery in the same session could clear an older pending
  final unless the clear path compared the delivered payload.

Operational rules:

- Keep the Telegram target as `telegram:<chatId>`.
- Store topic id in OpenClaw metadata as `threadId`.
- Use composite session keys only for OpenClaw identity, not as Telegram
  delivery targets.
- Run the checker after every OpenClaw package update.

This repository intentionally omits host-specific production notes, node ids,
private paths, tokens, IP addresses, and operator chat ids.

