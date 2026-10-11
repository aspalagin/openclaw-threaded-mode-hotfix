# OpenClaw Telegram Threaded Mode hotfix

Portable hotfix scripts for OpenClaw Telegram Threaded Mode (private bot
topics). Each hotfix is pinned to one OpenClaw release and refuses to run on
any other version:

- OpenClaw `2026.9.7`: **DM topic adopt** — a user message that Telegram sends
  to the root chat right after creating a topic is routed into that topic.
- OpenClaw `2026.7.1-2`: **thread model** — DM topics do not inherit a model
  override from the parent DM; `/new` clears the override, `/reset` keeps it.

Older full-layer scripts for `2026.6.10` and `2026.6.11` were removed from
`main` and remain available in git history (tag `v2026.6.11-1`).

This repository is an operator patch, not an upstream OpenClaw release. It
patches built bundles under `dist/` in an installed OpenClaw package, so review
it before running it on a production host.

## Support matrix

| OpenClaw version | Status | Verification |
| --- | --- | --- |
| `2026.9.7` from npm | Supported for the DM topic adopt patch | CI: syntax, non-writing dry run, checker failing on vanilla, functional test (13 scenarios) on a patched copy, apply + checker + test on a disposable npm install, re-apply is a no-op, version guard. |
| `2026.7.1-2` from npm | Retained, not re-verified in production | CI still runs syntax, dry run, apply to a disposable npm install, and the checker. |
| `2026.6.11` | Removed, see git history | Use tag `v2026.6.11-1` if you still need the legacy full-layer scripts. |
| `2026.6.10` | Removed, see git history | Legacy scripts and the reference patch were deleted from `main`. |
| Any other version | Unsupported | Do not apply without a version-specific review and test. |

Node.js 20 or later is required.

## OpenClaw 2026.9.7: DM topic adopt

### Symptom

Threaded Mode is enabled for the bot (`has_topics_enabled: true`). The user
writes a new message in the private chat with the bot. Telegram creates a new
topic named after the message, but the bot answers in the root chat and the new
topic stays empty. Observed since 2026-10-09 with the Telegram client for
Android; other clients send the message inside the topic as expected.

### Mechanism

The bot receives two updates in the same second:

1. a service message with `forum_topic_created` (it carries the new
   `message_thread_id`, `is_name_implicit: true`, the message text as the topic
   name, and the user as `from`);
2. the user's actual message **without** `message_thread_id`.

Vanilla `resolveTelegramMessageThreadSpec` resolves the second update to scope
`dm` without a topic id, so it goes to the root DM session and the reply is
delivered to the root chat.

### What the patch changes

One bundle under `dist/` (expected name `helpers-*.mjs`, located by code
signatures, never by file name). The resolver `resolveTelegramMessageThreadSpec`
is prefixed with an adoption step:

- In a private chat where `from` is not a bot, a `forum_topic_created` message
  with a thread id is remembered as pending for the pair `chat:user`.
- The next message from the same user that has no `message_thread_id`, arrives
  within 3 seconds (by `date`) and has a larger `message_id` adopts that topic
  id and resolves to `{ id: <topic>, scope: "dm" }`, which yields the normal
  `...:thread:<chat>:<topic>` session, typing and delivery inside the topic.
- Adoption is cached by `chat:message_id`, so repeated resolver calls for the
  same message (edits, reply chains, dedupe) return the same topic id.
- A message that arrives with `message_thread_id` equal to the pending topic
  consumes the pending entry (the normal client path), so a later unthreaded
  message stays in the root chat.
- Topics created by the bot (`from.is_bot`) and group chats are untouched.
- State is process-local (a `Symbol.for` singleton; adopted ids capped at 512).

### Apply

```bash
git clone https://github.com/aspalagin/openclaw-threaded-mode-hotfix.git
cd openclaw-threaded-mode-hotfix
npm run check:syntax

# dry run (writes nothing)
node scripts/apply-dm-topic-adopt-hotfix-2026-9-7.mjs --package-root /usr/lib/node_modules/openclaw --dry-run

# apply (backup goes to ./openclaw-hotfix-backups/dm-topic-adopt-hotfix/<timestamp>/ unless --backup-dir is set)
node scripts/apply-dm-topic-adopt-hotfix-2026-9-7.mjs --package-root /usr/lib/node_modules/openclaw \
  --backup-dir /var/backups/openclaw-hotfixes/dm-topic-adopt

# verify signatures
node scripts/check-dm-topic-adopt-hotfix-2026-9-7.mjs --package-root /usr/lib/node_modules/openclaw

# functional test against the installed (or still vanilla) bundle; never writes the bundle itself
node scripts/test-dm-topic-adopt-hotfix-2026-9-7.mjs --package-root /usr/lib/node_modules/openclaw
```

`--package-root` defaults to `OPENCLAW_PACKAGE_ROOT`, then to
`<npm root -g>/openclaw`. `OPENCLAW_HOTFIX_BACKUP_DIR` is an alternative to
`--backup-dir`. The apply script checks that the package is `openclaw@2026.9.7`,
locates exactly one bundle by content, is idempotent (marker guard), writes the
patched bundle to a temporary file, runs `node --check` on it and only then
replaces the original; if the check fails the original is left untouched (or
restored from the backup).

Then restart the OpenClaw gateway from a shell you control:

```bash
sudo systemctl restart openclaw-gateway
```

### Verify in production

Send a new message to the bot from the affected client. The reply must land in
the new topic. The gateway log shows one line per adopted message:

```text
[hotfix][dm-topic-adopt] adopted chat=<chat> user=<user> message=<id> thread=<topic> topicCreatedBy=<service message id> delaySec=<0..3>
```

No such line means the client sent the message inside the topic by itself (the
normal path) and the patch did nothing.

### Rollback

Restore `dist/helpers-*.mjs` from the backup directory printed by the apply
script, then restart the gateway. For a full package rollback, reinstall
`openclaw@2026.9.7`.

### Limitations

- The user's original message itself remains in the root chat on the Telegram
  side; only OpenClaw's session, typing and reply move into the topic. The
  topic therefore starts with the bot's answer.
- The 3-second window and the "larger `message_id`" rule are deliberately
  strict. A message that arrives later than that is treated as a normal root
  message.
- Pending/adopted state lives in the gateway process; a restart between the
  service message and the user message loses the pairing.

## OpenClaw 2026.7.1-2: thread model

Retained from the previous release and still exercised by CI on a disposable
npm install, but not re-verified on a production host since then.

- Telegram DM topics do not inherit a user-selected model from the parent DM
  session; each new topic starts from the configured agent model unless the
  topic itself has an explicit override.
- `/new` clears a user-selected model and returns to the configured agent model;
  `/reset` deliberately preserves the current selection.

```bash
OPENCLAW_PACKAGE_ROOT=/usr/lib/node_modules/openclaw \
  node scripts/apply-thread-model-hotfix-2026-7-1-2.mjs --check

OPENCLAW_PACKAGE_ROOT=/usr/lib/node_modules/openclaw \
  OPENCLAW_HOTFIX_BACKUP_DIR=/var/backups/openclaw-hotfixes/thread-model \
  node scripts/apply-thread-model-hotfix-2026-7-1-2.mjs

OPENCLAW_PACKAGE_ROOT=/usr/lib/node_modules/openclaw \
  node scripts/check-thread-model-hotfix-2026-7-1-2.mjs
```

The apply script changes three bundles below `dist/`: stored model override
resolution, preserved selection reset logic, and the `/new` session lifecycle
call. Backups go to `./openclaw-hotfix-backups/thread-model-hotfix/<timestamp>/`
unless `OPENCLAW_HOTFIX_BACKUP_DIR` is set.

Smoke test:

1. Select a non-default model in one DM topic, create another topic, and confirm
   the new topic uses the configured default.
2. Select a non-default model, run `/new`, and confirm the configured default is
   restored; repeat with `/reset` and confirm the selected model is preserved.

## Requirements

- Node.js available on the OpenClaw host.
- A normal OpenClaw install, usually at `/usr/lib/node_modules/openclaw`.
- Telegram Threaded Mode / topics enabled for the bot in BotFather.

Verify the bot capability:

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" | jq .
```

The bot should report topic support, for example `has_topics_enabled: true`.

If you are operating from inside an OpenClaw Telegram session, do not restart the
gateway directly from that same session. Use SSH or schedule the restart from an
external shell.

Helpful checks:

```bash
openclaw gateway call health --json
openclaw sessions list --json | jq '.sessions[] | select(.sessionKey | contains(":thread:")) | .sessionKey'
```

## Notes

- Private bot topics are addressed with Bot API `message_thread_id`. Do not
  rewrite DM topic delivery to `direct_messages_topic_id`; in the tested
  OpenClaw/Telegram path that sends rich replies to the root DM.
- Keep `to` as `telegram:<chatId>` and store the topic id as thread metadata.
- The composite key `...:thread:<chatId>:<topicId>` is an OpenClaw session
  identity, not a Telegram delivery target.
- Run the checker again after every OpenClaw package update; a version bump
  makes every script here refuse to run until it is reviewed for the new build.
