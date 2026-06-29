#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/usr/lib/node_modules/openclaw";
const distDir = path.join(packageRoot, "dist");
const expectedVersion = "2026.6.10";

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function readJson(file) {
  return JSON.parse(readText(file));
}

function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function findOne(files, label, needles) {
  const matches = [];
  for (const file of files) {
    const content = readText(file);
    if (needles.every((needle) => content.includes(needle))) {
      matches.push({ file, content });
    }
  }
  if (matches.length === 0) throw new Error(`could not locate ${label}`);
  if (matches.length > 1) {
    throw new Error(`located multiple ${label}: ${matches.map((match) => match.file).join(", ")}`);
  }
  return matches[0];
}

function contains(content, needle, label) {
  if (!content.includes(needle)) throw new Error(`missing ${label}`);
}

function notContains(content, needle, label) {
  if (content.includes(needle)) throw new Error(`unexpected ${label}`);
}

function check(files, id, locate, assertions) {
  try {
    const target = locate(files);
    for (const assertion of assertions) assertion(target.content);
    console.log(`[ok] ${id}: ${path.relative(packageRoot, target.file)}`);
    return true;
  } catch (err) {
    console.log(`[fail] ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function main() {
  if (!fs.existsSync(distDir)) throw new Error(`dist directory does not exist: ${distDir}`);
  const pkg = readJson(path.join(packageRoot, "package.json"));
  const files = walkJs(distDir);
  console.log(`[openclaw-threaded-check] package=${pkg.name ?? "openclaw"}@${pkg.version ?? "unknown"} root=${packageRoot}`);
  if (pkg.version !== expectedVersion) {
    console.log(`[warn] expected OpenClaw ${expectedVersion}; review bundle signatures before treating this as green`);
  }

  const results = [
    check(files, "telegram-dm-topic-rich-delivery", (all) => findOne(all, "Telegram delivery bundle", [
      "async function sendTelegramText",
      "sendRichMessage",
      "sendMessage",
    ]), [
      (content) => contains(content, "if (opts?.richMessages === true)", "rich delivery enabled for Telegram threads"),
      (content) => notContains(content, "shouldUseTelegramRichMessagesForText", "private topic rich bypass"),
      (content) => notContains(content, "isTelegramPrivateTopicDelivery", "private topic plain fallback"),
    ]),
    check(files, "telegram-dm-topic-rich-streaming", (all) => findOne(all, "Telegram bot bundle", [
      "createTelegramDraftStream",
      "renderStreamText",
    ]), [
      (content) => contains(content, "telegramCfg.richMessages === true ? TELEGRAM_RICH_TEXT_LIMIT : TELEGRAM_TEXT_CHUNK_LIMIT", "rich draft chunk limit"),
      (content) => contains(content, "supportsBlockTables: telegramCfg.richMessages === true", "rich table mode"),
      (content) => contains(content, "const renderStreamText = (text) => telegramCfg.richMessages === true ? {", "rich draft renderer"),
      (content) => contains(content, "richMessages: telegramCfg.richMessages", "rich draft stream option"),
      (content) => notContains(content, "telegramRichMessagesForThread", "private topic streaming rich bypass"),
    ]),
    check(files, "telegram-dm-topic-threading-cache", (all) => findOne(all, "Telegram sent-message cache bundle", [
      "function shouldUseTelegramDmThreadSession",
      "function resolveTelegramThreadSpec",
      "function buildTelegramThreadParams",
    ]), [
      (content) => contains(content, "return params.dmThreadId != null && params.botHasTopicsEnabled === true;", "DM thread session gate"),
      (content) => contains(content, "params.directMessagesTopicId ?? params.messageThreadId", "direct topic id preference"),
      (content) => contains(content, "{ message_thread_id: normalized }", "private topic delivery param"),
      (content) => contains(content, "threadParams?.message_thread_id ?? threadParams?.direct_messages_topic_id", "routing target accepts direct topic ids"),
    ]),
    check(files, "telegram-dm-topic-threading-send", (all) => findOne(all, "Telegram send bundle", [
      "function buildTelegramSendParams",
      "function buildTelegramSendThreadParams",
      "function toTelegramRichMessageContextParams",
    ]), [
      (content) => contains(content, "{ message_thread_id: normalized }", "private topic send param"),
      (content) => contains(content, "richParams.message_thread_id = messageThreadId", "rich message private topic param"),
      (content) => contains(content, "params?.message_thread_id ?? params?.direct_messages_topic_id", "accepted direct topic id"),
      (content) => contains(content, "direct-topic:", "direct topic throttling lane"),
    ]),
    check(files, "pending-final-delivery-clear-guard", (all) => findOne(all, "auto-reply dispatch bundle", [
      "async function clearPendingFinalDeliveryAfterSuccess",
      "const replies = replyResult ? Array.isArray(replyResult) ? replyResult : [replyResult] : []",
    ]), [
      (content) => contains(content, "buildDispatchPendingFinalDeliveryText", "dispatch pending-final text builder"),
      (content) => contains(content, "expectedPendingFinalDeliveryText: buildDispatchPendingFinalDeliveryText(replies)", "expected payload clear guard"),
      (content) => contains(content, "not cleared: delivered payload did not match stored pending final delivery", "mismatch preserve guard"),
      (content) => contains(content, "promoteNextPendingFinalDeliveryOrClear", "pending backlog promotion"),
    ]),
    check(files, "agent-runner-pending-final-backlog", (all) => findOne(all, "agent runner runtime bundle", [
      "function buildPendingFinalDeliveryText",
      "resolveReplyRunDeliveryContext",
      "pendingFinalDeliveryContext",
    ]), [
      (content) => contains(content, "function appendPendingFinalDeliveryBacklog", "agent runner pending backlog helper"),
      (content) => contains(content, "const pendingFinalDeliveryIntentId = crypto.randomUUID();", "agent runner pending intent id"),
      (content) => contains(content, "pendingFinalDeliveryBacklog: backlog.slice(-20)", "agent runner backlog cap"),
    ]),
    check(files, "agent-command-pending-final-backlog", (all) => findOne(all, "agent command bundle", [
      "function clearPendingFinalDeliveryFields",
      "pendingFinalDeliveryTextForThisRun",
      "resolveCurrentRunDeliveryContext",
    ]), [
      (content) => contains(content, "function appendPendingFinalDeliveryBacklog", "agent command pending backlog helper"),
      (content) => contains(content, "pendingFinalDeliveryBacklog: backlog.slice(-20)", "agent command backlog cap"),
      (content) => contains(content, "pendingFinalDeliveryIntentId: runId", "agent command pending intent id"),
    ]),
    check(files, "terminal-pending-final-recovery", (all) => findOne(all, "main-session restart recovery bundle", [
      "async function recoverStore",
      "pendingFinalDeliveryLastAttemptAt",
      "resolveRestartRecoveryDeliveryContext",
    ]), [
      (content) => contains(content, "isRecoverableTerminalPendingFinalDelivery", "terminal pending detection"),
      (content) => contains(content, "recoverTerminalPendingFinalDelivery", "terminal pending recovery function"),
      (content) => contains(content, "normalizeRecoveryDeliveryContextForSend", "Telegram thread normalization"),
      (content) => contains(content, "main-session-pending-final", "terminal pending idempotency prefix"),
    ]),
  ];

  const failed = results.filter((ok) => !ok).length;
  console.log(`[openclaw-threaded-check] summary ok=${results.length - failed} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(`[openclaw-threaded-check] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
