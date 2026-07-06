# OpenClaw Telegram Threaded Mode hotfix

Portable hotfix layer for OpenClaw Telegram Threaded Mode. The current scripts
target OpenClaw `2026.6.11`; legacy `2026.6.10` scripts remain in the repo for
older installs.

This repository is an operator patch, not an upstream OpenClaw release. It
patches built `dist/*.js` bundles in an installed OpenClaw package, so review it
before running it on a production host.

## What it fixes

- Telegram private bot topics get separate OpenClaw session keys.
- Telegram topic replies use Bot API `message_thread_id`.
- Rich Telegram delivery remains enabled inside DM topics.
- Telegram DM topic auto-label re-arms after `/new` and `/reset`: `/new text`
  labels from `text` immediately, while bare `/new` waits for the next normal
  user message in the same topic.
- Auto-label also normalizes Telegram private-topic ids from
  `direct_messages_topic.topic_id` when Telegram does not populate
  `message_thread_id` on native slash-command updates.
- Final replies persisted as `pendingFinalDelivery` are recovered after
  restarts instead of being silently lost.
- The exact tested apply script also includes adjacent generic fixes from the
  same production layer: Telegram Guest Mode, Windows Tray request caps, and
  message-tool guidance for large local files.

## Requirements

- OpenClaw `2026.6.11` for the current scripts.
- Node.js available on the OpenClaw host.
- A normal OpenClaw install, usually at `/usr/lib/node_modules/openclaw`.
- Telegram Threaded Mode / topics enabled for the bot in BotFather.

Verify the bot capability:

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" | jq .
```

The bot should report topic support, for example `has_topics_enabled: true`.

## Install

Clone this repository on the OpenClaw host:

```bash
git clone https://github.com/aspalagin/openclaw-threaded-mode-hotfix.git
cd openclaw-threaded-mode-hotfix
```

Check syntax:

```bash
node --check scripts/apply-openclaw-2026-6-10-hotfixes.mjs
node --check scripts/check-threaded-mode-hotfixes.mjs
node --check scripts/apply-openclaw-2026-6-11-hotfixes.mjs
node --check scripts/check-openclaw-2026-6-11-hotfixes.mjs
```

Dry-run against the installed package:

```bash
OPENCLAW_PACKAGE_ROOT=/usr/lib/node_modules/openclaw \
  node scripts/apply-openclaw-2026-6-11-hotfixes.mjs --check
```

Apply:

```bash
OPENCLAW_PACKAGE_ROOT=/usr/lib/node_modules/openclaw \
  OPENCLAW_HOTFIX_BACKUP_DIR=/root/openclaw-backups/openclaw-threaded-mode-hotfix \
  node scripts/apply-openclaw-2026-6-11-hotfixes.mjs
```

Validate signatures:

```bash
OPENCLAW_PACKAGE_ROOT=/usr/lib/node_modules/openclaw \
  node scripts/check-openclaw-2026-6-11-hotfixes.mjs
```

Restart OpenClaw Gateway from a shell you control:

```bash
sudo systemctl restart openclaw-gateway
```

If you are operating from inside an OpenClaw Telegram session, do not restart the
gateway directly from that same session. Use SSH or schedule the restart from an
external shell.

## Smoke test

1. Open a direct Telegram topic with your bot.
2. Send a short prompt in the topic.
3. Confirm the reply lands in the same topic, not in the root DM.
4. Send a second prompt in a different topic and confirm it uses a separate
   conversation/session.
5. Send `/new короткая тема` inside an existing DM topic and confirm the topic
   is renamed from the tail text after the gateway restart.
6. Send bare `/new`, then a normal prompt, and confirm the topic is renamed from
   that prompt.

Helpful checks:

```bash
openclaw gateway call health --json
openclaw sessions list --json | jq '.sessions[] | select(.sessionKey | contains(":thread:")) | .sessionKey'
```

## Rollback

The apply script writes backups before changing files. By default they go under:

```text
/root/openclaw-backups/openclaw-2026.6.11-hotfixes/
```

If you set `OPENCLAW_HOTFIX_BACKUP_DIR`, use that path instead. To roll back,
restore the changed files from the latest backup directory, then restart the
gateway.

For a full package rollback, reinstall the original OpenClaw package version or
restore your package-level backup.

## Notes

- The patch intentionally uses `message_thread_id` for private bot topics.
- Do not rewrite DM topic delivery to `direct_messages_topic_id`; in the tested
  OpenClaw/Telegram path that sends rich replies to the root DM.
- The `direct_messages_topic.topic_id` fallback is only for recognizing which
  private topic a native slash-command belongs to; delivery still stays on
  `message_thread_id`.
- Keep `to` as `telegram:<chatId>` and store the topic id as thread metadata.
- The composite key `...:thread:<chatId>:<topicId>` is an OpenClaw session
  identity, not a Telegram delivery target.
- The auto-label patch is intentionally scoped to Telegram DM topics. It does
  not rename flat DMs or normal group/forum topics.
