#!/usr/bin/env node
// OpenClaw 2026.9.7 hotfix: telegram-dm-topic-adopt-created.
//
// Symptom: in a private chat with a bot that has Telegram topics enabled
// (Threaded Mode), some Telegram clients create the topic but send the user's
// message to the root chat. The bot receives a service `forum_topic_created`
// update (carrying the new `message_thread_id`, `is_name_implicit`, the message
// text as the topic name and the user as `from`) and, in the same second, the
// user's message WITHOUT `message_thread_id`. Vanilla
// `resolveTelegramMessageThreadSpec` resolves scope "dm" without an id, so the
// message lands in the root DM session, the reply goes to the root chat and the
// freshly created topic stays empty.
//
// Fix (resolver-level, so lane keys, authorization, message context, native
// commands, debounce and reply chains all agree): in a private chat where
// `from` is not a bot, a `forum_topic_created` message with a thread id is
// remembered as pending for `chat:user`. The next message from the same user
// that has no `message_thread_id`, arrives within 3 seconds (by `date`) and has
// a larger `message_id` adopts that topic id (scope "dm"). Adoption is cached
// by `chat:message_id` so repeated resolver calls for the same message are
// stable. A message that arrives with `message_thread_id` equal to the pending
// topic consumes the pending entry (the normal path). Topics created by the bot
// and group chats are untouched. Adoption is logged as
// `[hotfix][dm-topic-adopt] adopted ...`.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const expectedVersion = "2026.9.7";
export const hotfixId = "dm-topic-adopt";
export const MARKER = "hotfix: telegram-dm-topic-adopt-created";
export const targetNeedles = [
  "function resolveTelegramMessageThreadSpec(message, isForum) {",
  "function shouldUseTelegramDmThreadSession(params) {",
  "function buildTelegramThreadParams(thread) {",
];

const FN_HEAD = "function resolveTelegramMessageThreadSpec(message, isForum) {\n\tif (message.chat.is_direct_messages === true) {";
const FN_HEAD_PATCHED =
  "function resolveTelegramMessageThreadSpec(message, isForum) {\n" +
  "\tconst hotfixAdoptedDmThreadId = resolveHotfixDmTopicAdoptThreadId(message);\n" +
  "\tif (hotfixAdoptedDmThreadId !== void 0) return {\n" +
  "\t\tid: hotfixAdoptedDmThreadId,\n" +
  "\t\tscope: \"dm\"\n" +
  "\t};\n" +
  "\tif (message.chat.is_direct_messages === true) {";
const REGION = [
  "//#region " + MARKER + " (2026-10-12) — сообщение без message_thread_id сразу после forum_topic_created того же пользователя в личке считается сообщением этой темы",
  "const HOTFIX_DM_TOPIC_ADOPT_WINDOW_SEC = 3;",
  "const HOTFIX_DM_TOPIC_ADOPT_MAX_ADOPTED = 512;",
  "function getHotfixDmTopicAdoptState() {",
  "\tconst key = Symbol.for(\"openclaw.hotfix.telegramDmTopicAdopt\");",
  "\tconst host = globalThis;",
  "\tif (!host[key]) host[key] = {",
  "\t\tpending: /* @__PURE__ */ new Map(),",
  "\t\tadopted: /* @__PURE__ */ new Map()",
  "\t};",
  "\treturn host[key];",
  "}",
  "function resolveHotfixDmTopicAdoptThreadId(message) {",
  "\tif (!message || typeof message !== \"object\") return;",
  "\tconst chat = message.chat;",
  "\tif (!chat || chat.type !== \"private\" || typeof chat.id !== \"number\") return;",
  "\tconst from = message.from;",
  "\tif (!from || typeof from.id !== \"number\" || from.is_bot === true) return;",
  "\tconst messageId = message.message_id;",
  "\tif (typeof messageId !== \"number\" || !Number.isSafeInteger(messageId)) return;",
  "\tconst state = getHotfixDmTopicAdoptState();",
  "\tconst userKey = `${chat.id}:${from.id}`;",
  "\tconst ownThreadId = parseStrictPositiveInteger(message.message_thread_id);",
  "\tif (ownThreadId !== void 0) {",
  "\t\tif (message.forum_topic_created && typeof message.date === \"number\") state.pending.set(userKey, {",
  "\t\t\tthreadId: ownThreadId,",
  "\t\t\tdate: message.date,",
  "\t\t\tcreatedMessageId: messageId,",
  "\t\t\tconsumedBy: void 0",
  "\t\t});",
  "\t\telse {",
  "\t\t\tconst pending = state.pending.get(userKey);",
  "\t\t\tif (pending && pending.threadId === ownThreadId && pending.consumedBy === void 0) pending.consumedBy = messageId;",
  "\t\t}",
  "\t\treturn;",
  "\t}",
  "\tconst adoptKey = `${chat.id}:${messageId}`;",
  "\tconst adopted = state.adopted.get(adoptKey);",
  "\tif (adopted !== void 0) return adopted;",
  "\tconst pending = state.pending.get(userKey);",
  "\tif (!pending || pending.consumedBy !== void 0) return;",
  "\tif (typeof message.date !== \"number\" || message.date < pending.date || message.date - pending.date > HOTFIX_DM_TOPIC_ADOPT_WINDOW_SEC) return;",
  "\tif (messageId <= pending.createdMessageId) return;",
  "\tpending.consumedBy = messageId;",
  "\tstate.adopted.set(adoptKey, pending.threadId);",
  "\tif (state.adopted.size > HOTFIX_DM_TOPIC_ADOPT_MAX_ADOPTED) {",
  "\t\tconst oldestKey = state.adopted.keys().next().value;",
  "\t\tif (oldestKey !== void 0) state.adopted.delete(oldestKey);",
  "\t}",
  "\tconsole.error(`[hotfix][dm-topic-adopt] adopted chat=${chat.id} user=${from.id} message=${messageId} thread=${pending.threadId} topicCreatedBy=${pending.createdMessageId} delaySec=${message.date - pending.date}`);",
  "\treturn pending.threadId;",
  "}",
  "//#endregion",
  "",
].join("\n");

export function fail(message) {
  throw new Error(message);
}

export function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index === -1) fail(`missing ${label}`);
  if (source.indexOf(before, index + before.length) !== -1) fail(`ambiguous ${label}`);
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

export function insertBefore(source, before, insert, label) {
  if (source.includes(insert.trim())) return source;
  const index = source.indexOf(before);
  if (index === -1) fail(`missing insertion point for ${label}`);
  return `${source.slice(0, index)}${insert}${source.slice(index)}`;
}

/** Pure transformation; returns the input unchanged when the marker is already present. */
export function patchSource(source) {
  if (source.includes(MARKER)) return source;
  let next = source;
  next = insertBefore(next, "function resolveTelegramMessageThreadSpec(message, isForum) {", REGION, `${hotfixId} region`);
  next = replaceOnce(next, FN_HEAD, FN_HEAD_PATCHED, `${hotfixId} resolver head`);
  return next;
}

export function parseArgs(argv) {
  const options = { packageRoot: undefined, backupDir: undefined, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check" || arg === "--dry-run") options.dryRun = true;
    else if (arg === "--package-root") options.packageRoot = argv[++index];
    else if (arg.startsWith("--package-root=")) options.packageRoot = arg.slice("--package-root=".length);
    else if (arg === "--backup-dir") options.backupDir = argv[++index];
    else if (arg.startsWith("--backup-dir=")) options.backupDir = arg.slice("--backup-dir=".length);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else fail(`unknown argument: ${arg}`);
  }
  return options;
}

export function resolvePackageRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.OPENCLAW_PACKAGE_ROOT) return path.resolve(process.env.OPENCLAW_PACKAGE_ROOT);
  const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8" });
  if (npm.status === 0 && npm.stdout.trim()) return path.join(npm.stdout.trim(), "openclaw");
  fail("cannot resolve the global npm root; pass --package-root or set OPENCLAW_PACKAGE_ROOT");
}

export function walkBundles(root) {
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) files.push(target);
    }
  }
  return files.sort();
}

export function findOne(files, label, needles) {
  const matches = files.filter((file) => {
    const content = fs.readFileSync(file, "utf8");
    return needles.every((needle) => content.includes(needle));
  });
  if (matches.length !== 1) fail(`${label}: expected one matching bundle, found ${matches.length}`);
  return matches[0];
}

export function assertVersion(packageRoot) {
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) fail(`not an OpenClaw package root (no package.json): ${packageRoot}`);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== "openclaw") fail(`package at ${packageRoot} is ${packageJson.name}, expected openclaw`);
  if (packageJson.version !== expectedVersion) {
    fail(`unsupported OpenClaw version ${packageJson.version}; expected ${expectedVersion}`);
  }
  return packageJson.version;
}

/** Locates the Telegram helpers bundle (expected name `dist/helpers-*.mjs`, matched by content only). */
export function locateTargetFile(packageRoot) {
  const distDir = path.join(packageRoot, "dist");
  if (!fs.existsSync(distDir)) fail(`dist directory does not exist: ${distDir}`);
  return findOne(walkBundles(distDir), "Telegram helpers bundle (resolveTelegramMessageThreadSpec)", targetNeedles);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function nodeCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) fail(`node --check failed for ${file}:\n${(result.stderr || result.stdout || "").trim()}`);
}

function usage() {
  console.log(`Usage: node scripts/apply-dm-topic-adopt-hotfix-2026-9-7.mjs [--package-root <dir>] [--backup-dir <dir>] [--dry-run|--check]

  --package-root  OpenClaw package directory (default: OPENCLAW_PACKAGE_ROOT or <npm root -g>/openclaw)
  --backup-dir    where the original bundle is copied before patching
                  (default: OPENCLAW_HOTFIX_BACKUP_DIR or ./openclaw-hotfix-backups/dm-topic-adopt-hotfix)
  --dry-run       compute the patch and report, write nothing`);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return;
  }
  const packageRoot = resolvePackageRoot(options.packageRoot);
  const backupRoot = path.resolve(
    options.backupDir || process.env.OPENCLAW_HOTFIX_BACKUP_DIR || path.join("openclaw-hotfix-backups", "dm-topic-adopt-hotfix"),
  );
  const version = assertVersion(packageRoot);
  console.log(`[${hotfixId}] package=${packageRoot} version=${version}`);

  const file = locateTargetFile(packageRoot);
  const relative = path.relative(packageRoot, file);
  const source = fs.readFileSync(file, "utf8");
  const next = patchSource(source);
  const changed = next !== source;

  if (options.dryRun) {
    console.log(`[${changed ? "would-patch" : "ok"}] ${hotfixId} ${relative}`);
    console.log(`[${hotfixId}] dry-run changed=${changed ? 1 : 0}`);
    return;
  }

  if (!changed) {
    console.log(`[ok] ${hotfixId} ${relative} (marker already present)`);
    console.log(`[${hotfixId}] complete changed=0`);
    return;
  }

  const backupDir = path.join(backupRoot, timestamp());
  const backupFile = path.join(backupDir, relative);
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.copyFileSync(file, backupFile);
  console.log(`[${hotfixId}] backup=${backupFile}`);

  const temporary = `${file}.${hotfixId}-hotfix.tmp.mjs`;
  const mode = fs.statSync(file).mode;
  fs.writeFileSync(temporary, next, "utf8");
  fs.chmodSync(temporary, mode);
  try {
    nodeCheck(temporary);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    fail(`${error instanceof Error ? error.message : String(error)}\n[${hotfixId}] original bundle left untouched: ${relative}`);
  }
  fs.renameSync(temporary, file);
  try {
    nodeCheck(file);
  } catch (error) {
    fs.copyFileSync(backupFile, file);
    fail(`${error instanceof Error ? error.message : String(error)}\n[${hotfixId}] restored ${relative} from ${backupFile}`);
  }
  console.log(`[patched] ${hotfixId} ${relative}`);
  console.log(`[${hotfixId}] complete changed=1 — restart the OpenClaw gateway to activate`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`[${hotfixId}] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
