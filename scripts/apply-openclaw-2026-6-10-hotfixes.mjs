#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/usr/lib/node_modules/openclaw";
const distDir = path.join(packageRoot, "dist");
const backupRoot = process.env.OPENCLAW_HOTFIX_BACKUP_DIR || "/root/openclaw-backups/openclaw-2026.6.10-hotfixes";
const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--check");

function fail(message) {
  console.error(`[openclaw-2026.6.10-hotfixes] ${message}`);
  process.exitCode = 1;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function read(file) {
  return fs.readFileSync(file, "utf8");
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
    const content = read(file);
    if (needles.every((needle) => content.includes(needle))) matches.push(file);
  }
  if (matches.length === 0) throw new Error(`could not find ${label}`);
  if (matches.length > 1) throw new Error(`found multiple ${label}: ${matches.join(", ")}`);
  return matches[0];
}

function findOneAny(files, label, needleSets) {
  const errors = [];
  for (const needles of needleSets) {
    try {
      return findOne(files, label, needles);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(`${label}: ${errors.join("; ")}`);
}

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index === -1) throw new Error(`missing ${label}`);
  if (source.indexOf(before, index + before.length) !== -1) throw new Error(`ambiguous ${label}`);
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

function insertBefore(source, before, insert, label) {
  if (source.includes(insert.trim())) return source;
  const index = source.indexOf(before);
  if (index === -1) throw new Error(`missing insertion point for ${label}`);
  return `${source.slice(0, index)}${insert}${source.slice(index)}`;
}

function insertAfter(source, after, insert, label) {
  if (source.includes(insert.trim())) return source;
  const index = source.indexOf(after);
  if (index === -1) throw new Error(`missing insertion point for ${label}`);
  return `${source.slice(0, index + after.length)}${insert}${source.slice(index + after.length)}`;
}

function backupFile(file, before) {
  const rel = path.relative(packageRoot, file);
  const backupPath = path.join(backupRoot, timestamp(), `${rel}.${sha256(before).slice(0, 12)}.bak`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(backupPath, before, { mode: 0o600 });
  return backupPath;
}

function applyFile(file, label, patch) {
  const before = read(file);
  const after = patch(before);
  if (after === before) {
    console.log(`[openclaw-2026.6.10-hotfixes] ${label}: ok`);
    return { label, file, changed: false };
  }
  if (dryRun) {
    console.log(`[openclaw-2026.6.10-hotfixes] ${label}: would patch ${file}`);
    return { label, file, changed: true };
  }
  const backupPath = backupFile(file, before);
  fs.writeFileSync(file, after, "utf8");
  console.log(`[openclaw-2026.6.10-hotfixes] ${label}: patched ${file}; backup=${backupPath}`);
  return { label, file, changed: true, backupPath };
}

function patchAllowedUpdates(source) {
  if (source.includes('updates.includes("guest_message")')) return source;
  return replaceOnce(
    source,
    '\tif (!updates.includes("message_reaction")) updates.push("message_reaction");',
    '\tif (!updates.includes("guest_message")) updates.push("guest_message");\n\tif (!updates.includes("message_reaction")) updates.push("message_reaction");',
    "guest_message allowed update",
  );
}

function patchBot(source) {
  let next = source;
  next = insertAfter(
    next,
    'function createTelegramIngressSubject(senderId) {\n\treturn { stableId: senderId };\n}\n',
    `function normalizeTelegramGuestSessionScope(value) {
\tconst normalized = normalizeLowercaseStringOrEmpty(value);
\tconst safe = normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
\treturn safe.slice(0, 96) || "unknown";
}
function resolveTelegramGuestSessionKey(baseSessionKey, msg) {
\tconst guestQueryId = typeof msg.guest_query_id === "string" && msg.guest_query_id.trim() ? msg.guest_query_id.trim() : "";
\tif (!guestQueryId) return baseSessionKey;
\tconst callerChatId = msg.guest_bot_caller_chat?.id != null ? String(msg.guest_bot_caller_chat.id) : "";
\tconst callerUserId = msg.guest_bot_caller_user?.id != null ? String(msg.guest_bot_caller_user.id) : msg.from?.id != null ? String(msg.from.id) : "";
\tconst scope = callerChatId || callerUserId || guestQueryId;
\treturn \`\${baseSessionKey}:guest:\${normalizeTelegramGuestSessionScope(scope)}\`;
}
`,
    "Telegram guest session helpers",
  );
  next = insertBefore(
    next,
    '\tbot.on("edited_message", async (ctx) => {',
    `\tbot.on("guest_message", async (ctx) => {
\t\tconst msg = ctx.guestMessage ?? ctx.update?.guest_message;
\t\tif (!msg) return;
\t\tconst guestQueryId = typeof msg.guest_query_id === "string" && msg.guest_query_id.trim() ? msg.guest_query_id.trim() : void 0;
\t\tif (!guestQueryId) {
\t\t\tlogVerbose("telegram guest_message skipped: missing guest_query_id");
\t\t\treturn;
\t\t}
\t\tconst guestFrom = msg.from ?? msg.guest_bot_caller_user;
\t\tconst normalizedMsg = withResolvedTelegramForumFlag({
\t\t\t...msg,
\t\t\t...(guestFrom ? { from: guestFrom } : {})
\t\t}, false);
\t\tif (normalizedMsg.from?.id != null && normalizedMsg.from.id === ctx.me?.id) return;
\t\tawait handleInboundMessageLike({
\t\t\tctxForDedupe: ctx,
\t\t\tctx: buildSyntheticContext(ctx, normalizedMsg),
\t\t\tmsg: normalizedMsg,
\t\t\tchatId: normalizedMsg.chat.id,
\t\t\tisGroup: false,
\t\t\tisForum: false,
\t\t\tmessageThreadId: void 0,
\t\t\tsenderId: normalizedMsg.from?.id != null ? String(normalizedMsg.from.id) : "",
\t\t\tsenderUsername: normalizedMsg.from?.username ?? "",
\t\t\trequireConfiguredGroup: false,
\t\t\tsendOversizeWarning: false,
\t\t\toversizeLogMessage: "guest message media exceeds size limit",
\t\t\terrorMessage: "guest_message handler failed"
\t\t});
\t});
`,
    "Telegram guest_message handler",
  );
  if (!next.includes("const isGuest = Boolean(guestQueryId);")) {
    next = replaceOnce(
      next,
      `\tconst msg = primaryCtx.message;
\tconst chatId = msg.chat.id;
\tconst isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
\tconst senderId = msg.from?.id ? String(msg.from.id) : "";
\tconst messageThreadId = msg.message_thread_id;
\tconst reactionApi = typeof bot.api.setMessageReaction === "function" ? bot.api.setMessageReaction.bind(bot.api) : null;`,
      `\tconst msg = primaryCtx.message;
\tconst chatId = msg.chat.id;
\tconst guestQueryId = typeof msg.guest_query_id === "string" && msg.guest_query_id.trim() ? msg.guest_query_id.trim() : void 0;
\tconst isGuest = Boolean(guestQueryId);
\tconst isGroup = !isGuest && (msg.chat.type === "group" || msg.chat.type === "supergroup");
\tconst senderId = msg.from?.id ? String(msg.from.id) : msg.guest_bot_caller_user?.id != null ? String(msg.guest_bot_caller_user.id) : "";
\tconst messageThreadId = msg.message_thread_id;
\tconst reactionApi = !isGuest && typeof bot.api.setMessageReaction === "function" ? bot.api.setMessageReaction.bind(bot.api) : null;`,
      "Telegram guest message-context header",
    );
  }
  next = next.replaceAll(
    `\tconst senderUsername = msg.from?.username ?? "";`,
    `\tconst senderUsername = msg.from?.username ?? msg.guest_bot_caller_user?.username ?? "";`,
  );
  if (!next.includes(`\tconst sendTyping = async () => {
\t\tif (isGuest) return;`)) {
    next = replaceOnce(
      next,
      `\tconst sendTyping = async () => {
\t\tawait withTelegramApiErrorLogging({`,
      `\tconst sendTyping = async () => {
\t\tif (isGuest) return;
\t\tawait withTelegramApiErrorLogging({`,
      "Telegram guest typing suppression",
    );
  }
  if (!next.includes(`\tconst sendRecordVoice = async () => {
\t\tif (isGuest) return;`)) {
    next = replaceOnce(
      next,
      `\tconst sendRecordVoice = async () => {
\t\ttry {`,
      `\tconst sendRecordVoice = async () => {
\t\tif (isGuest) return;
\t\ttry {`,
      "Telegram guest voice cue suppression",
    );
  }
  if (!next.includes("resolveTelegramGuestSessionKey(threadedSessionKey, msg)")) {
    next = replaceOnce(
      next,
      `\tconst sessionKey = (shouldUseTelegramDmThreadSession({
\t\tdmThreadId,
\t\tbotHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(primaryCtx.me)
\t}) && dmThreadId != null ? resolveThreadSessionKeys({
\t\tbaseSessionKey,
\t\tthreadId: \`\${chatId}:\${dmThreadId}\`
\t}) : null)?.sessionKey ?? baseSessionKey;`,
      `\tconst threadedSessionKey = (shouldUseTelegramDmThreadSession({
\t\tdmThreadId,
\t\tbotHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(primaryCtx.me)
\t}) && dmThreadId != null ? resolveThreadSessionKeys({
\t\tbaseSessionKey,
\t\tthreadId: \`\${chatId}:\${dmThreadId}\`
\t}) : null)?.sessionKey ?? baseSessionKey;
\tconst sessionKey = isGuest ? resolveTelegramGuestSessionKey(threadedSessionKey, msg) : threadedSessionKey;`,
      "Telegram guest session key",
    );
  }
  if (!next.includes("GuestDeliveryHint")) {
    next = replaceOnce(
      next,
      `\tconst conversationKind = isGroup ? "group" : "direct";
\tconst inboundEventKind = classifyChannelInboundEvent({`,
      `\tconst conversationKind = isGroup ? "group" : "direct";
\tconst inboundEventKind = classifyChannelInboundEvent({`,
      "Telegram inbound event anchor",
    );
    next = replaceOnce(
      next,
      `\tconst ctxPayload = await sessionRuntime.buildChannelInboundEventContext({`,
      `\tconst effectiveInboundEventKind = msg.guest_query_id ? "guest_message" : inboundEventKind;
\tconst guestModeDeliveryHint = msg.guest_query_id ? "Telegram Guest Mode: deliver the final reply as concise plain text only. Do not use message delivery tools, TTS, voice, audio, files, media, reactions, or typing cues. You may use available tools, including longer-running tools, when needed to complete the user's request; do not refuse only because this is Guest Mode." : void 0;
\tconst ctxPayload = await sessionRuntime.buildChannelInboundEventContext({`,
      "Telegram guest delivery hint",
    );
    next = replaceOnce(
      next,
      `\t\tmessage: {
\t\t\tinboundEventKind,
\t\t\tbody: combinedBody,
\t\t\trawBody,
\t\t\tbodyForAgent: bodyText,`,
      `\t\tmessage: {
\t\t\tinboundEventKind: effectiveInboundEventKind,
\t\t\tbody: combinedBody,
\t\t\trawBody,
\t\t\tbodyForAgent: guestModeDeliveryHint ? \`\${bodyText}\\n\\n\${guestModeDeliveryHint}\` : bodyText,`,
      "Telegram guest inbound payload",
    );
    next = replaceOnce(
      next,
      `\t\t\tForwardedFromMessageId: visibleForwardOrigin?.fromMessageId,
\t\t\tWasMentioned: isGroup ? effectiveWasMentioned : void 0,
\t\t\tSticker: allMedia[0]?.stickerMetadata,`,
      `\t\t\tForwardedFromMessageId: visibleForwardOrigin?.fromMessageId,
\t\t\tWasMentioned: isGroup ? effectiveWasMentioned : void 0,
\t\t\tGuestMode: msg.guest_query_id ? true : void 0,
\t\t\tGuestDeliveryHint: guestModeDeliveryHint,
\t\t\tGuestQueryId: typeof msg.guest_query_id === "string" ? msg.guest_query_id : void 0,
\t\t\tGuestBotCallerUserId: msg.guest_bot_caller_user?.id != null ? String(msg.guest_bot_caller_user.id) : void 0,
\t\t\tGuestBotCallerChatId: msg.guest_bot_caller_chat?.id != null ? String(msg.guest_bot_caller_chat.id) : void 0,
\t\t\tSticker: allMedia[0]?.stickerMetadata,`,
      "Telegram guest context extras",
    );
  }
  if (!next.includes("const isGuestQuery = Boolean(guestQueryId);")) {
    next = replaceOnce(
      next,
      `\tconst streamDeliveryEnabled = !isRoomEvent && streamMode !== "off";`,
      `\tconst guestQueryId = typeof ctxPayload.GuestQueryId === "string" && ctxPayload.GuestQueryId.trim() ? ctxPayload.GuestQueryId.trim() : void 0;
\tconst isGuestQuery = Boolean(guestQueryId);
\tconst streamDeliveryEnabled = !isRoomEvent && !isGuestQuery && streamMode !== "off";`,
      "Telegram guest stream suppression",
    );
  }
  if (!next.includes(`\t\tguestQueryId,
\t\treplyQuoteMessageId,`)) {
    next = replaceOnce(
      next,
      `\t\tlinkPreview: telegramCfg.linkPreview,
\t\treplyQuoteMessageId,`,
      `\t\tlinkPreview: telegramCfg.linkPreview,
\t\tguestQueryId,
\t\treplyQuoteMessageId,`,
      "Telegram guest delivery option",
    );
  }
  if (!next.includes("options?.durable && durableDelivery && !guestQueryId")) {
    next = replaceOnce(
      next,
      `\t\t\tif (options?.durable && durableDelivery) {`,
      `\t\t\tif (options?.durable && durableDelivery && !guestQueryId) {`,
      "Telegram guest durable suppression",
    );
  }
  next = next.replace(
    `\tconst telegramRichMessagesForThread = telegramCfg.richMessages === true && threadSpec.scope !== "dm";
\tconst draftMaxChars = streamMode === "block" ? Math.min(resolveTelegramDraftStreamingChunking(cfg, route.accountId).maxChars, textLimit) : Math.min(textLimit, telegramRichMessagesForThread ? TELEGRAM_RICH_TEXT_LIMIT : TELEGRAM_TEXT_CHUNK_LIMIT);`,
    `\tconst draftMaxChars = streamMode === "block" ? Math.min(resolveTelegramDraftStreamingChunking(cfg, route.accountId).maxChars, textLimit) : Math.min(textLimit, telegramCfg.richMessages === true ? TELEGRAM_RICH_TEXT_LIMIT : TELEGRAM_TEXT_CHUNK_LIMIT);`,
  );
  next = next.replace(
    `\t\tsupportsBlockTables: telegramRichMessagesForThread`,
    `\t\tsupportsBlockTables: telegramCfg.richMessages === true`,
  );
  next = next.replace(
    `\tconst renderStreamText = (text) => telegramRichMessagesForThread ? {`,
    `\tconst renderStreamText = (text) => telegramCfg.richMessages === true ? {`,
  );
  next = next.replace(
    `\t\t\t\trichMessages: telegramRichMessagesForThread,
\t\t\t\tminInitialChars: draftMinInitialChars,`,
    `\t\t\t\trichMessages: telegramCfg.richMessages,
\t\t\t\tminInitialChars: draftMinInitialChars,`,
  );
  return next;
}

function patchDelivery(source) {
  let next = source;
  next = next.replace(
    `function isTelegramPrivateTopicDelivery(chatId, thread) {
\tif (thread?.scope === "dm") return true;
\tif (thread?.id == null) return false;
\tconst numericChatId = typeof chatId === "number" ? chatId : Number(chatId);
\treturn Number.isFinite(numericChatId) && numericChatId > 0;
}
function shouldUseTelegramRichMessagesForText(chatId, thread, richMessages) {
\treturn richMessages === true && !isTelegramPrivateTopicDelivery(chatId, thread);
}
`,
    "",
  );
  next = next.replace(
    `\tif (shouldUseTelegramRichMessagesForText(chatId, opts?.thread, opts?.richMessages)) {`,
    `\tif (opts?.richMessages === true) {`,
  );
  next = next.replace(
    `\tif (opts?.richMessages === true && opts?.thread?.scope !== "dm") {`,
    `\tif (opts?.richMessages === true) {`,
  );
  if (!next.includes("TELEGRAM_GUEST_TEXT_LIMIT")) {
    next = insertBefore(
      next,
      "//#endregion\n//#region extensions/telegram/src/bot/reply-threading.ts",
      `const TELEGRAM_GUEST_TEXT_LIMIT = 4096;
const TELEGRAM_GUEST_QUERY_EXPIRED_RE = /query is too old|response timeout expired|query ID is invalid/i;
function buildTelegramGuestResultId() {
\treturn \`oc-\${Date.now().toString(36)}\`;
}
function isTelegramGuestQueryExpiredError(err) {
\treturn TELEGRAM_GUEST_QUERY_EXPIRED_RE.test(formatErrorMessage(err));
}
function truncateTelegramGuestText(text) {
\tif (text.length <= TELEGRAM_GUEST_TEXT_LIMIT) return text;
\tconst suffix = "\\n\\n[Ответ обрезан из-за лимита Telegram guest mode.]";
\treturn \`\${text.slice(0, Math.max(1, TELEGRAM_GUEST_TEXT_LIMIT - suffix.length - 1)).trimEnd()}…\${suffix}\`;
}
function buildTelegramGuestTextResult(text, opts) {
\tconst inputMessageContent = {
\t\tmessage_text: truncateTelegramGuestText(text),
\t\t...(opts?.parseMode ? { parse_mode: opts.parseMode } : {}),
\t\t...((opts?.linkPreview ?? true) ? {} : { link_preview_options: { is_disabled: true } })
\t};
\treturn {
\t\ttype: "article",
\t\tid: buildTelegramGuestResultId(),
\t\ttitle: "Ответ",
\t\tinput_message_content: inputMessageContent,
\t\t...opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}
\t};
}
async function answerTelegramGuestQueryViaOfficialApi(guestQueryId, result, token) {
\tif (!token?.trim()) throw new Error("telegram answerGuestQuery fallback unavailable: missing bot token");
\tconst res = await fetch(\`https://api.telegram.org/bot\${token}/answerGuestQuery\`, {
\t\tmethod: "POST",
\t\theaders: { "content-type": "application/json" },
\t\tbody: JSON.stringify({
\t\t\tguest_query_id: guestQueryId,
\t\t\tresult
\t\t})
\t});
\tconst data = await res.json().catch(() => null);
\tif (!res.ok || !data?.ok) {
\t\tconst description = typeof data?.description === "string" ? data.description : \`HTTP \${res.status}\`;
\t\tthrow new Error(\`telegram answerGuestQuery failed: \${description}\`);
\t}
\treturn data.result;
}
async function answerTelegramGuestQuery(bot, guestQueryId, result, runtime, opts) {
\tif (typeof bot.api.answerGuestQuery === "function") return await sendTelegramWithThreadFallback({
\t\toperation: "answerGuestQuery",
\t\truntime,
\t\trequestParams: {},
\t\tsend: () => bot.api.answerGuestQuery(guestQueryId, result)
\t});
\tif (typeof bot.api.raw?.answerGuestQuery === "function") return await sendTelegramWithThreadFallback({
\t\toperation: "answerGuestQuery",
\t\truntime,
\t\trequestParams: {},
\t\tsend: () => bot.api.raw.answerGuestQuery({
\t\t\tguest_query_id: guestQueryId,
\t\t\tresult
\t\t})
\t});
\tif (opts?.token) return await sendTelegramWithThreadFallback({
\t\toperation: "answerGuestQuery (official api fallback)",
\t\truntime,
\t\trequestParams: {},
\t\tsend: () => answerTelegramGuestQueryViaOfficialApi(guestQueryId, result, opts.token)
\t});
\tthrow new Error("telegram answerGuestQuery unavailable");
}
async function sendTelegramGuestText(bot, guestQueryId, text, runtime, opts) {
\tif (!guestQueryId.trim() || !text.trim()) return;
\tconst result = buildTelegramGuestTextResult(text, {
\t\tparseMode: opts?.parseMode,
\t\tlinkPreview: opts?.linkPreview,
\t\treplyMarkup: opts?.replyMarkup
\t});
\tconst sent = await answerTelegramGuestQuery(bot, guestQueryId, result, runtime, { token: opts?.token });
\tconst inlineMessageId = sent?.inline_message_id;
\truntime.log?.(\`telegram answerGuestQuery ok inline_message_id=\${inlineMessageId ?? "unknown"}\`);
\treturn inlineMessageId ?? "guest";
}
`,
      "Telegram guest delivery helpers",
    );
  }
  if (!next.includes("params.progress.guestAnswered")) {
    next = replaceOnce(
      next,
      `async function deliverTextReply(params) {
\tlet firstDeliveredMessageId;
\tawait sendChunkedTelegramReplyText({`,
      `async function deliverTextReply(params) {
\tlet firstDeliveredMessageId;
\tif (params.guestQueryId) {
\t\tif (params.progress.guestAnswered) return;
\t\tconst chunks = filterEmptyTelegramTextChunks(params.chunkText(params.replyText));
\t\tconst firstChunk = chunks[0];
\t\tconst fallbackText = firstChunk?.text ?? params.replyText;
\t\tconst text = chunks.length > 1 ? \`\${fallbackText.trimEnd()}\\n\\n[Ответ обрезан из-за лимита Telegram guest mode.]\` : fallbackText;
\t\ttry {
\t\t\tfirstDeliveredMessageId = await sendTelegramGuestText(params.bot, params.guestQueryId, text, params.runtime, {
\t\t\t\tparseMode: firstChunk?.richMessage ? void 0 : firstChunk?.html ? "HTML" : void 0,
\t\t\t\tlinkPreview: params.linkPreview,
\t\t\t\treplyMarkup: params.replyMarkup,
\t\t\t\ttoken: params.token
\t\t\t});
\t\t} catch (err) {
\t\t\tif (!isTelegramGuestQueryExpiredError(err)) throw err;
\t\t\tparams.runtime.log?.(\`telegram guest query expired; falling back to sendMessage: \${formatErrorMessage(err)}\`);
\t\t}
\t\tif (firstDeliveredMessageId != null) {
\t\t\tparams.progress.guestAnswered = true;
\t\t\tparams.progress.hasDelivered = true;
\t\t\tparams.progress.deliveredCount += 1;
\t\t\treturn firstDeliveredMessageId;
\t\t}
\t}
\tawait sendChunkedTelegramReplyText({`,
      "Telegram guest deliverTextReply",
    );
  }
  if (!next.includes("mediaList.length === 0 || params.guestQueryId")) {
    next = replaceOnce(
      next,
      `\t\t\tif (mediaList.length === 0) firstDeliveredMessageId = await deliverTextReply({
\t\t\t\tbot: params.bot,`,
      `\t\t\tif (mediaList.length === 0 || params.guestQueryId) firstDeliveredMessageId = await deliverTextReply({
\t\t\t\tbot: params.bot,`,
      "Telegram guest media text fallback",
    );
    next = replaceOnce(
      next,
      `\t\t\t\treplyText: reply.text || "",
\t\t\t\treplyMarkup,`,
      `\t\t\t\treplyText: params.guestQueryId && !reply.text ? "[Медиа-вложение недоступно в Telegram guest mode.]" : reply.text || "",
\t\t\t\treplyMarkup,`,
      "Telegram guest media unavailable text",
    );
    next = next.replaceAll(
      `\t\t\t\tlinkPreview: params.linkPreview,
\t\t\t\tsilent: params.silent,`,
      `\t\t\t\tlinkPreview: params.linkPreview,
\t\t\t\ttoken: params.token,
\t\t\t\tsilent: params.silent,`,
    );
    next = next.replaceAll(
      `\t\t\t\treplyToMode: params.replyToMode,
\t\t\t\tprogress`,
      `\t\t\t\treplyToMode: params.replyToMode,
\t\t\t\tguestQueryId: params.guestQueryId,
\t\t\t\tprogress`,
    );
  }
  return next;
}

function patchTelegramDmTopicSentMessageCache(source) {
  let next = source;
  next = next.replace(
    `function shouldUseTelegramDmThreadSession(params) {
\treturn false;
}`,
    `function shouldUseTelegramDmThreadSession(params) {
\treturn params.dmThreadId != null && params.botHasTopicsEnabled === true;
}`,
  );
  next = next.replace(
    `function shouldUseTelegramDmThreadSession(params) {
\treturn params.dmThreadId != null && params.botHasTopicsEnabled === true;
}`,
    `function shouldUseTelegramDmThreadSession(params) {
\treturn params.dmThreadId != null && params.botHasTopicsEnabled === true;
}`,
  );
  next = next.replace(
    `function resolveTelegramThreadSpec(params) {
\tif (params.isGroup) return {
\t\tid: resolveTelegramForumThreadId({
\t\t\tisForum: params.isForum,
\t\t\tmessageThreadId: params.messageThreadId
\t\t}),
\t\tscope: params.isForum ? "forum" : "none"
\t};
\tif (params.messageThreadId == null) return { scope: "dm" };
\treturn {
\t\tid: params.messageThreadId,
\t\tscope: "dm"
\t};
}`,
    `function resolveTelegramThreadSpec(params) {
\tif (params.isGroup) return {
\t\tid: resolveTelegramForumThreadId({
\t\t\tisForum: params.isForum,
\t\t\tmessageThreadId: params.messageThreadId
\t\t}),
\t\tscope: params.isForum ? "forum" : "none"
\t};
\tconst directMessagesTopicId = params.directMessagesTopicId ?? params.messageThreadId;
\tif (directMessagesTopicId == null) return { scope: "dm" };
\treturn {
\t\tid: directMessagesTopicId,
\t\tscope: "dm"
\t};
}`,
  );
  next = next.replace(
    `\tif (thread.scope === "dm") return normalized > 0 ? { direct_messages_topic_id: normalized } : void 0;`,
    `\tif (thread.scope === "dm") return normalized > 0 ? { message_thread_id: normalized } : void 0;`,
  );
  next = next.replace(
    `function buildTelegramRoutingTarget(chatId, thread) {
\tconst base = \`telegram:\${chatId}\`;
\tconst messageThreadId = buildTelegramThreadParams(thread)?.message_thread_id;
\tif (typeof messageThreadId !== "number") return base;
\treturn \`\${base}:topic:\${messageThreadId}\`;
}`,
    `function buildTelegramRoutingTarget(chatId, thread) {
\tconst base = \`telegram:\${chatId}\`;
\tconst threadParams = buildTelegramThreadParams(thread);
\tconst messageThreadId = threadParams?.message_thread_id ?? threadParams?.direct_messages_topic_id;
\tif (typeof messageThreadId !== "number") return base;
\treturn \`\${base}:topic:\${messageThreadId}\`;
}`,
  );
  return next;
}

function patchTelegramDmTopicSend(source) {
  let next = source;
  next = next.replace(
    `function buildTelegramSendThreadParams(thread) {
\tif (thread?.id == null) return;
\tif (thread.scope === "dm") {
\t\tconst normalized = Math.trunc(thread.id);
\t\treturn normalized > 0 ? { direct_messages_topic_id: normalized } : void 0;
\t}
\treturn buildTelegramThreadParams(thread);
}`,
    `function buildTelegramSendThreadParams(thread) {
\tif (thread?.id == null) return;
\tif (thread.scope === "dm") {
\t\tconst normalized = Math.trunc(thread.id);
\t\treturn normalized > 0 ? { message_thread_id: normalized } : void 0;
\t}
\treturn buildTelegramThreadParams(thread);
}`,
  );
  next = next.replace(
    `function buildTelegramSendThreadParams(thread) {
\tif (thread?.id == null) return;
\treturn buildTelegramThreadParams(thread);
}`,
    `function buildTelegramSendThreadParams(thread) {
\tif (thread?.id == null) return;
\tif (thread.scope === "dm") {
\t\tconst normalized = Math.trunc(thread.id);
\t\treturn normalized > 0 ? { message_thread_id: normalized } : void 0;
\t}
\treturn buildTelegramThreadParams(thread);
}`,
  );
  if (!next.includes("direct_messages_topic_id")) return next;
  next = next.replace(
    `function resolveTelegramAcceptedThreadId(params) {
\treturn params?.message_thread_id;
}`,
    `function resolveTelegramAcceptedThreadId(params) {
\treturn params?.message_thread_id ?? params?.direct_messages_topic_id;
}`,
  );
  next = next.replace(
    `function toTelegramRichMessageContextParams(params) {
\tconst richParams = {};
\tconst messageThreadId = finiteInteger(params?.message_thread_id);
\tif (messageThreadId !== void 0) richParams.message_thread_id = messageThreadId;
\tif (params?.disable_notification === true) richParams.disable_notification = true;`,
    `function toTelegramRichMessageContextParams(params) {
\tconst richParams = {};
\tconst messageThreadId = finiteInteger(params?.message_thread_id);
\tif (messageThreadId !== void 0) richParams.message_thread_id = messageThreadId;
\tconst directMessagesTopicId = finiteInteger(params?.direct_messages_topic_id);
\tif (directMessagesTopicId !== void 0) richParams.direct_messages_topic_id = directMessagesTopicId;
\tif (params?.disable_notification === true) richParams.disable_notification = true;`,
  );
  next = next.replace(
    `function resolveForumLaneKey(payload) {
\tconst threadId = readNumericId(payload.message_thread_id);
\tif (threadId !== void 0) return \`topic:\${threadId}\`;
\tconst messageId = readNumericId(payload.message_id);`,
    `function resolveForumLaneKey(payload) {
\tconst threadId = readNumericId(payload.message_thread_id);
\tif (threadId !== void 0) return \`topic:\${threadId}\`;
\tconst directTopicId = readNumericId(payload.direct_messages_topic_id);
\tif (directTopicId !== void 0) return \`direct-topic:\${directTopicId}\`;
\tconst messageId = readNumericId(payload.message_id);`,
  );
  return next;
}

function patchChat(source) {
  let next = source;
  if (!next.includes("CHAT_HISTORY_WINDOWS_TRAY_LIMIT")) {
    next = insertBefore(
      next,
      "async function handleChatHistoryRequest",
      `const CHAT_HISTORY_WINDOWS_TRAY_LIMIT = 10;
function isOpenClawWindowsTrayClient(client) {
\tconst info = client?.connect?.client;
\tconst displayName = normalizeOptionalText(info?.displayName);
\tconst platform = normalizeOptionalText(info?.platform)?.toLowerCase();
\tconst deviceFamily = normalizeOptionalText(info?.deviceFamily)?.toLowerCase();
\tconst clientId = normalizeOptionalText(info?.id)?.toLowerCase();
\tconst clientMode = normalizeOptionalText(info?.mode)?.toLowerCase();
\treturn displayName === "OpenClaw Windows Tray" || clientId === "cli" && clientMode === "cli" && platform === "windows" && deviceFamily === "desktop";
}
function resolveChatHistoryLimitForClient(params) {
\tconst requested = typeof params.params.limit === "number" ? params.params.limit : 200;
\tif (!isOpenClawWindowsTrayClient(params.client)) return requested;
\treturn Math.min(requested, CHAT_HISTORY_WINDOWS_TRAY_LIMIT);
}
`,
      "Windows Tray chat helpers",
    );
    next = replaceOnce(
      next,
      "async function handleChatHistoryRequest({ params, respond, context, method, includeAgentsList, includeMetadata })",
      "async function handleChatHistoryRequest({ params, respond, context, client, method, includeAgentsList, includeMetadata })",
      "chat.history client param",
    );
    next = replaceOnce(
      next,
      "\tconst { sessionKey, limit, maxChars } = params;",
      "\tconst { sessionKey, maxChars } = params;\n\tconst limit = resolveChatHistoryLimitForClient({ params, client });",
      "chat.history Windows Tray limit",
    );
  }
  return next;
}

function patchSessions(source) {
  let next = source;
  if (!next.includes('from "./message-channel-CtiNqfW0.js"') && next.includes("isOperatorUiClient(params.client?.connect?.client)")) {
    next = replaceOnce(
      next,
      'import { t as ADMIN_SCOPE } from "./operator-scopes-CS3xdS-V.js";',
      'import { t as ADMIN_SCOPE } from "./operator-scopes-CS3xdS-V.js";\nimport { a as isOperatorUiClient } from "./message-channel-CtiNqfW0.js";',
      "sessions.list operator UI helper import",
    );
  }
  if (!next.includes("SESSIONS_LIST_OPERATOR_UI_DEFAULT_LIMIT")) {
    next = insertBefore(
      next,
      "function inheritSessionRuntimeSelection",
      `const SESSIONS_LIST_OPERATOR_UI_DEFAULT_LIMIT = 10;
function isOpenClawWindowsTrayClient(client) {
\tconst info = client?.connect?.client;
\tconst displayName = normalizeOptionalString(info?.displayName);
\tconst platform = normalizeOptionalLowercaseString(info?.platform);
\tconst deviceFamily = normalizeOptionalLowercaseString(info?.deviceFamily);
\tconst clientId = normalizeOptionalLowercaseString(info?.id);
\tconst clientMode = normalizeOptionalLowercaseString(info?.mode);
\treturn displayName === "OpenClaw Windows Tray" || clientId === "cli" && clientMode === "cli" && platform === "windows" && deviceFamily === "desktop";
}
function normalizeSessionsListParamsForClient(params) {
\tif (typeof params.params.limit === "number" && Number.isFinite(params.params.limit)) return params.params;
\tif (!isOperatorUiClient(params.client?.connect?.client) && !isOpenClawWindowsTrayClient(params.client)) return params.params;
\treturn {
\t\t...params.params,
\t\tlimit: SESSIONS_LIST_OPERATOR_UI_DEFAULT_LIMIT
\t};
}
`,
      "Windows Tray sessions helpers",
    );
    next = replaceOnce(
      next,
      '\t"sessions.list": async ({ params, respond, context }) => {\n\t\tif (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) return;\n\t\tconst p = params;',
      '\t"sessions.list": async ({ params, respond, context, client }) => {\n\t\tif (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) return;\n\t\tconst p = normalizeSessionsListParamsForClient({ params, client });',
      "sessions.list Windows Tray default limit",
    );
  }
  return next;
}

function patchMessageHandler(source) {
  let next = source;
  if (!next.includes("shouldAllowWindowsTrayDualRoleMetadataMismatch")) {
    next = insertBefore(
      next,
      "function attachGatewayWsMessageHandler",
      `function shouldAllowWindowsTrayDualRoleMetadataMismatch(params) {
\tconst pairedRoles = Array.isArray(params.pairedRoles) ? params.pairedRoles : [];
\tif (!pairedRoles.includes("operator") || !pairedRoles.includes("node")) return false;
\tconst claimedPlatform = normalizeDeviceMetadataForAuth(params.claimedPlatform);
\tconst pairedPlatform = normalizeDeviceMetadataForAuth(params.pairedPlatform);
\tif (!(claimedPlatform === "windows" || claimedPlatform === "win32")) return false;
\tif (!(pairedPlatform === "windows" || pairedPlatform === "win32")) return false;
\tconst claimedDeviceFamily = normalizeDeviceMetadataForAuth(params.claimedDeviceFamily);
\tconst displayName = normalizeDeviceMetadataForAuth(params.displayName);
\tconst isWindowsTrayOperator = params.clientId === GATEWAY_CLIENT_IDS.CLI && params.clientMode === GATEWAY_CLIENT_MODES.CLI && displayName === "openclaw windows tray" && (claimedDeviceFamily === "" || claimedDeviceFamily === "desktop" || claimedDeviceFamily === "windows");
\tconst isWindowsTrayNode = params.clientId === GATEWAY_CLIENT_IDS.NODE_HOST && params.clientMode === GATEWAY_CLIENT_MODES.NODE && displayName.startsWith("windows node") && (claimedDeviceFamily === "" || claimedDeviceFamily === "windows" || claimedDeviceFamily === "desktop");
\treturn isWindowsTrayOperator || isWindowsTrayNode;
}
`,
      "Windows Tray dual-role helper",
    );
    next = replaceOnce(
      next,
      `\t\t\t\t\t\tconst { platformMismatch, deviceFamilyMismatch } = metadataPinning;
\t\t\t\t\t\tif (platformMismatch || deviceFamilyMismatch) {`,
      `\t\t\t\t\t\tconst { platformMismatch, deviceFamilyMismatch } = metadataPinning;
\t\t\t\t\t\tconst pairedRolesForMetadata = listEffectivePairedDeviceRoles(paired);
\t\t\t\t\t\tconst allowWindowsTrayDualRoleMetadataMismatch = shouldAllowWindowsTrayDualRoleMetadataMismatch({
\t\t\t\t\t\t\tclientId: connectParams.client.id,
\t\t\t\t\t\t\tclientMode: connectParams.client.mode,
\t\t\t\t\t\t\tdisplayName: connectParams.client.displayName,
\t\t\t\t\t\t\tclaimedPlatform,
\t\t\t\t\t\t\tclaimedDeviceFamily,
\t\t\t\t\t\t\tpairedPlatform,
\t\t\t\t\t\t\tpairedRoles: pairedRolesForMetadata
\t\t\t\t\t\t});
\t\t\t\t\t\tif ((platformMismatch || deviceFamilyMismatch) && !allowWindowsTrayDualRoleMetadataMismatch) {`,
      "Windows Tray metadata-upgrade bypass",
    );
    next = replaceOnce(
      next,
      "\t\t\t\t\t\tconst pairedRoles = listEffectivePairedDeviceRoles(paired);",
      "\t\t\t\t\t\tconst pairedRoles = pairedRolesForMetadata;",
      "Windows Tray paired role reuse",
    );
  }
  return next;
}

function patchToolSchema(source) {
  let next = source;
  next = next.replace(
    'media: Type.Optional(Type.String({ description: "Media URL/path. data: use buffer." }))',
    'media: Type.Optional(Type.String({ description: "Remote media URL or small inline media. For local files, especially >20MB, use filePath/path instead so the gateway does not inline bytes into the WebSocket payload." }))',
  );
  next = next.replace(
    'path: Type.Optional(Type.String())',
    'path: Type.Optional(Type.String({ description: "Local file path for outbound media; preferred for local files and files >20MB." }))',
  );
  next = next.replace(
    'filePath: Type.Optional(Type.String())',
    'filePath: Type.Optional(Type.String({ description: "Local file path for outbound media; preferred for local files and files >20MB." }))',
  );
  next = next.replace(
    'media: Type.Optional(Type.String()),',
    'media: Type.Optional(Type.String({ description: "Remote media URL or small inline media. For local files, use filePath/path." })),',
  );
  next = next.replace(
    '}), { description: "Structured attachments; each entry uses media." })',
    '}), { description: "Structured attachments. For local files, use filePath/path rather than media to avoid inline WebSocket payloads." })',
  );
  return next;
}

function patchDispatchPendingFinalDelivery(source) {
  let next = source;
  if (next.includes("expectedPendingFinalDeliveryText: buildDispatchPendingFinalDeliveryText(replies)") && next.includes("function promoteNextPendingFinalDeliveryOrClear(entry, updatedAt)")) return next;
  if (!next.includes('from "./pending-final-delivery-CpTdDs7S.js"')) {
    next = replaceOnce(
      next,
      'import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DW4mBlAt.js";',
      'import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DW4mBlAt.js";\nimport { t as sanitizePendingFinalDeliveryText } from "./pending-final-delivery-CpTdDs7S.js";',
      "dispatch pending-final sanitizer import",
    );
  }
  next = insertBefore(
    next,
    "async function clearPendingFinalDeliveryAfterSuccess(params) {",
    `function buildDispatchPendingFinalDeliveryText(payloads) {
\treturn sanitizePendingFinalDeliveryText(payloads.filter((payload) => payload?.isReasoning !== true).map((payload) => typeof payload?.text === "string" ? payload.text : "").filter((text) => Boolean(text)).join("\\n\\n"));
}
function normalizePendingFinalDeliveryBacklog(value) {
\tif (!Array.isArray(value)) return [];
\tconst out = [];
\tfor (const item of value) {
\t\tif (!item || typeof item !== "object" || Array.isArray(item)) continue;
\t\tconst text = typeof item.text === "string" ? sanitizePendingFinalDeliveryText(item.text) : "";
\t\tif (!text) continue;
\t\tout.push({
\t\t\ttext,
\t\t\tcontext: item.context,
\t\t\tcreatedAt: typeof item.createdAt === "number" ? item.createdAt : void 0,
\t\t\tlastAttemptAt: typeof item.lastAttemptAt === "number" ? item.lastAttemptAt : void 0,
\t\t\tattemptCount: typeof item.attemptCount === "number" ? item.attemptCount : void 0,
\t\t\tlastError: typeof item.lastError === "string" ? item.lastError : void 0,
\t\t\tintentId: typeof item.intentId === "string" ? item.intentId : void 0
\t\t});
\t}
\treturn out;
}
function promoteNextPendingFinalDeliveryOrClear(entry, updatedAt) {
\tconst backlog = normalizePendingFinalDeliveryBacklog(entry.pendingFinalDeliveryBacklog);
\tconst nextPending = backlog.shift();
\tif (nextPending) return {
\t\tpendingFinalDelivery: true,
\t\tpendingFinalDeliveryText: nextPending.text,
\t\tpendingFinalDeliveryCreatedAt: nextPending.createdAt ?? updatedAt,
\t\tpendingFinalDeliveryLastAttemptAt: nextPending.lastAttemptAt,
\t\tpendingFinalDeliveryAttemptCount: nextPending.attemptCount,
\t\tpendingFinalDeliveryLastError: nextPending.lastError,
\t\tpendingFinalDeliveryContext: nextPending.context,
\t\tpendingFinalDeliveryIntentId: nextPending.intentId,
\t\tpendingFinalDeliveryBacklog: backlog.length > 0 ? backlog : void 0,
\t\tupdatedAt
\t};
\treturn {
\t\tpendingFinalDelivery: void 0,
\t\tpendingFinalDeliveryText: void 0,
\t\tpendingFinalDeliveryCreatedAt: void 0,
\t\tpendingFinalDeliveryLastAttemptAt: void 0,
\t\tpendingFinalDeliveryAttemptCount: void 0,
\t\tpendingFinalDeliveryLastError: void 0,
\t\tpendingFinalDeliveryContext: void 0,
\t\tpendingFinalDeliveryIntentId: void 0,
\t\tpendingFinalDeliveryBacklog: void 0,
\t\tupdatedAt
\t};
}
`,
    "dispatch pending-final helpers",
  );
  next = replaceOnce(
    next,
    `async function clearPendingFinalDeliveryAfterSuccess(params) {
\tif (!params.storePath || !params.sessionKey) return;
\tawait updateSessionStoreEntry({
\t\tstorePath: params.storePath,
\t\tsessionKey: params.sessionKey,
\t\tskipMaintenance: true,
\t\ttakeCacheOwnership: true,
\t\tupdate: async (entry) => {
\t\t\tif (!entry.pendingFinalDelivery && !entry.pendingFinalDeliveryText) return null;
\t\t\treturn {
\t\t\t\tpendingFinalDelivery: void 0,
\t\t\t\tpendingFinalDeliveryText: void 0,
\t\t\t\tpendingFinalDeliveryCreatedAt: void 0,
\t\t\t\tpendingFinalDeliveryLastAttemptAt: void 0,
\t\t\t\tpendingFinalDeliveryAttemptCount: void 0,
\t\t\t\tpendingFinalDeliveryLastError: void 0,
\t\t\t\tpendingFinalDeliveryContext: void 0,
\t\t\t\tpendingFinalDeliveryIntentId: void 0,
\t\t\t\tupdatedAt: Date.now()
\t\t\t};
\t\t}
\t});
}`,
    `async function clearPendingFinalDeliveryAfterSuccess(params) {
\tif (!params.storePath || !params.sessionKey) return;
\tconst expectedPendingText = typeof params.expectedPendingFinalDeliveryText === "string" ? sanitizePendingFinalDeliveryText(params.expectedPendingFinalDeliveryText) : "";
\tawait updateSessionStoreEntry({
\t\tstorePath: params.storePath,
\t\tsessionKey: params.sessionKey,
\t\tskipMaintenance: true,
\t\ttakeCacheOwnership: true,
\t\tupdate: async (entry) => {
\t\t\tif (!entry.pendingFinalDelivery && !entry.pendingFinalDeliveryText && !Array.isArray(entry.pendingFinalDeliveryBacklog)) return null;
\t\t\tconst currentPendingText = typeof entry.pendingFinalDeliveryText === "string" ? sanitizePendingFinalDeliveryText(entry.pendingFinalDeliveryText) : "";
\t\t\tif (expectedPendingText && currentPendingText && currentPendingText !== expectedPendingText) return {
\t\t\t\tpendingFinalDeliveryLastAttemptAt: Date.now(),
\t\t\t\tpendingFinalDeliveryLastError: "not cleared: delivered payload did not match stored pending final delivery",
\t\t\t\tupdatedAt: Date.now()
\t\t\t};
\t\t\treturn promoteNextPendingFinalDeliveryOrClear(entry, Date.now());
\t\t}
\t});
}`,
    "dispatch pending-final clear guard",
  );
  next = replaceOnce(
    next,
    `await clearPendingFinalDeliveryAfterSuccess({
\t\t\t\tstorePath: sessionStoreEntry.storePath,
\t\t\t\tsessionKey: sessionStoreEntry.sessionKey ?? sessionKey
\t\t\t});`,
    `await clearPendingFinalDeliveryAfterSuccess({
\t\t\t\tstorePath: sessionStoreEntry.storePath,
\t\t\t\tsessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
\t\t\t\texpectedPendingFinalDeliveryText: buildDispatchPendingFinalDeliveryText(replies)
\t\t\t});`,
    "dispatch pending-final clear expected text",
  );
  return next;
}

function patchAgentRunnerPendingFinalDelivery(source) {
  let next = source;
  if (next.includes("const pendingFinalDeliveryIntentId = crypto.randomUUID();") && next.includes("function appendPendingFinalDeliveryBacklog(patch, current, nextText)")) return next;
  next = insertAfter(
    next,
    `function buildPendingFinalDeliveryText(payloads) {
\treturn sanitizePendingFinalDeliveryText(payloads.filter((payload) => payload.isReasoning !== true).map((payload) => payload.text).filter((textLocal) => Boolean(textLocal)).join("\\n\\n"));
}
`,
    `function appendPendingFinalDeliveryBacklog(patch, current, nextText) {
\tconst existingText = typeof current?.pendingFinalDeliveryText === "string" ? sanitizePendingFinalDeliveryText(current.pendingFinalDeliveryText) : "";
\tif (!existingText || existingText === nextText) return patch;
\tconst backlog = Array.isArray(current?.pendingFinalDeliveryBacklog) ? current.pendingFinalDeliveryBacklog.filter((item) => item && typeof item === "object" && typeof item.text === "string" && sanitizePendingFinalDeliveryText(item.text)) : [];
\tif (!backlog.some((item) => sanitizePendingFinalDeliveryText(item.text) === existingText)) backlog.push({
\t\ttext: existingText,
\t\tcontext: current.pendingFinalDeliveryContext,
\t\tcreatedAt: current.pendingFinalDeliveryCreatedAt,
\t\tlastAttemptAt: current.pendingFinalDeliveryLastAttemptAt,
\t\tattemptCount: current.pendingFinalDeliveryAttemptCount,
\t\tlastError: current.pendingFinalDeliveryLastError,
\t\tintentId: current.pendingFinalDeliveryIntentId
\t});
\treturn {
\t\t...patch,
\t\tpendingFinalDeliveryBacklog: backlog.slice(-20)
\t};
}
`,
    "agent-runner pending-final backlog helper",
  );
  next = replaceOnce(
    next,
    `await updateSessionEntry({
\t\t\t\t\tstorePath,
\t\t\t\t\tsessionKey
\t\t\t\t}, () => ({
\t\t\t\t\tpendingFinalDelivery: true,
\t\t\t\t\tpendingFinalDeliveryText: resolvedPendingText,
\t\t\t\t\tpendingFinalDeliveryContext,
\t\t\t\t\tpendingFinalDeliveryCreatedAt: Date.now(),
\t\t\t\t\tupdatedAt: Date.now()
\t\t\t\t}), {
\t\t\t\t\tskipMaintenance: true,
\t\t\t\t\ttakeCacheOwnership: true
\t\t\t\t});`,
    `const pendingFinalDeliveryIntentId = crypto.randomUUID();
\t\t\t\tawait updateSessionEntry({
\t\t\t\t\tstorePath,
\t\t\t\t\tsessionKey
\t\t\t\t}, (current) => appendPendingFinalDeliveryBacklog({
\t\t\t\t\tpendingFinalDelivery: true,
\t\t\t\t\tpendingFinalDeliveryText: resolvedPendingText,
\t\t\t\t\tpendingFinalDeliveryContext,
\t\t\t\t\tpendingFinalDeliveryCreatedAt: Date.now(),
\t\t\t\t\tpendingFinalDeliveryIntentId,
\t\t\t\t\tupdatedAt: Date.now()
\t\t\t\t}, current, resolvedPendingText), {
\t\t\t\t\tskipMaintenance: true,
\t\t\t\t\ttakeCacheOwnership: true
\t\t\t\t});`,
    "agent-runner pending-final backlog write",
  );
  return next;
}

function patchAgentCommandPendingFinalDelivery(source) {
  let next = source;
  if (next.includes("pendingFinalDeliveryIntentId: runId") && next.includes("function appendPendingFinalDeliveryBacklog(patch, current, nextText)")) return next;
  next = replaceOnce(
    next,
    `function clearPendingFinalDeliveryFields(entry, updatedAt) {
\treturn {
\t\t...entry,
\t\tpendingFinalDelivery: void 0,
\t\tpendingFinalDeliveryText: void 0,
\t\tpendingFinalDeliveryCreatedAt: void 0,
\t\tpendingFinalDeliveryLastAttemptAt: void 0,
\t\tpendingFinalDeliveryAttemptCount: void 0,
\t\tpendingFinalDeliveryLastError: void 0,
\t\tpendingFinalDeliveryContext: void 0,
\t\tpendingFinalDeliveryIntentId: void 0,
\t\tupdatedAt
\t};
}`,
    `function clearPendingFinalDeliveryFields(entry, updatedAt) {
\treturn {
\t\t...entry,
\t\tpendingFinalDelivery: void 0,
\t\tpendingFinalDeliveryText: void 0,
\t\tpendingFinalDeliveryCreatedAt: void 0,
\t\tpendingFinalDeliveryLastAttemptAt: void 0,
\t\tpendingFinalDeliveryAttemptCount: void 0,
\t\tpendingFinalDeliveryLastError: void 0,
\t\tpendingFinalDeliveryContext: void 0,
\t\tpendingFinalDeliveryIntentId: void 0,
\t\tpendingFinalDeliveryBacklog: void 0,
\t\tupdatedAt
\t};
}
function appendPendingFinalDeliveryBacklog(patch, current, nextText) {
\tconst existingText = typeof current?.pendingFinalDeliveryText === "string" ? sanitizePendingFinalDeliveryText(current.pendingFinalDeliveryText) : "";
\tif (!existingText || existingText === nextText) return patch;
\tconst backlog = Array.isArray(current?.pendingFinalDeliveryBacklog) ? current.pendingFinalDeliveryBacklog.filter((item) => item && typeof item === "object" && typeof item.text === "string" && sanitizePendingFinalDeliveryText(item.text)) : [];
\tif (!backlog.some((item) => sanitizePendingFinalDeliveryText(item.text) === existingText)) backlog.push({
\t\ttext: existingText,
\t\tcontext: current.pendingFinalDeliveryContext,
\t\tcreatedAt: current.pendingFinalDeliveryCreatedAt,
\t\tlastAttemptAt: current.pendingFinalDeliveryLastAttemptAt,
\t\tattemptCount: current.pendingFinalDeliveryAttemptCount,
\t\tlastError: current.pendingFinalDeliveryLastError,
\t\tintentId: current.pendingFinalDeliveryIntentId
\t});
\treturn {
\t\t...patch,
\t\tpendingFinalDeliveryBacklog: backlog.slice(-20)
\t};
}`,
    "agent-command pending-final backlog helper",
  );
  next = replaceOnce(
    next,
    `if (combinedPayload) sessionEntry = await persistSessionEntry({
\t\t\t\t\tsessionStore,
\t\t\t\t\tsessionKey,
\t\t\t\t\tstorePath,
\t\t\t\t\tentry: {
\t\t\t\t\t\t...sessionStore[sessionKey] ?? sessionEntry,
\t\t\t\t\t\tpendingFinalDelivery: true,
\t\t\t\t\t\tpendingFinalDeliveryText: combinedPayload,
\t\t\t\t\t\tpendingFinalDeliveryContext: currentRunDeliveryContext,
\t\t\t\t\t\tpendingFinalDeliveryCreatedAt: now,
\t\t\t\t\t\tupdatedAt: now
\t\t\t\t\t},
\t\t\t\t\tshouldPersist: (current) => shouldPersistCurrentRunSessionCleanup(current, sessionId)
\t\t\t\t}) ?? sessionEntry;`,
    `if (combinedPayload) sessionEntry = await persistSessionEntry({
\t\t\t\t\tsessionStore,
\t\t\t\t\tsessionKey,
\t\t\t\t\tstorePath,
\t\t\t\t\tentry: appendPendingFinalDeliveryBacklog({
\t\t\t\t\t\t...sessionStore[sessionKey] ?? sessionEntry,
\t\t\t\t\t\tpendingFinalDelivery: true,
\t\t\t\t\t\tpendingFinalDeliveryText: combinedPayload,
\t\t\t\t\t\tpendingFinalDeliveryContext: currentRunDeliveryContext,
\t\t\t\t\t\tpendingFinalDeliveryCreatedAt: now,
\t\t\t\t\t\tpendingFinalDeliveryIntentId: runId,
\t\t\t\t\t\tupdatedAt: now
\t\t\t\t\t}, sessionStore[sessionKey] ?? sessionEntry, combinedPayload),
\t\t\t\t\tshouldPersist: (current) => shouldPersistCurrentRunSessionCleanup(current, sessionId)
\t\t\t\t}) ?? sessionEntry;`,
    "agent-command pending-final backlog write",
  );
  return next;
}

function patchRestartRecoveryPendingFinalDelivery(source) {
  let next = source;
  if (next.includes("async function recoverTerminalPendingFinalDelivery(params)") && next.includes("isRecoverableTerminalPendingFinalDelivery(entry)")) {
    if (!next.includes("const incrementAttemptCount = params.incrementAttemptCount !== false;")) {
      next = replaceOnce(
        next,
        `\t\t\tfound.pendingFinalDeliveryLastAttemptAt = now;
\t\t\tfound.pendingFinalDeliveryAttemptCount = (found.pendingFinalDeliveryAttemptCount ?? 0) + 1;
\t\t\tfound.pendingFinalDeliveryLastError = params.error ?? null;`,
        `\t\t\tconst incrementAttemptCount = params.incrementAttemptCount !== false;
\t\t\tfound.pendingFinalDeliveryLastAttemptAt = now;
\t\t\tfound.pendingFinalDeliveryAttemptCount = (found.pendingFinalDeliveryAttemptCount ?? 0) + (incrementAttemptCount ? 1 : 0);
\t\t\tfound.pendingFinalDeliveryLastError = params.error ?? null;`,
        "restart recovery pending-final attempt count guard",
      );
      next = replaceOnce(
        next,
        `\t\t\tentry: params.entry,
\t\t\ttext,
\t\t\terror: String(err)
\t\t});`,
        `\t\t\tentry: params.entry,
\t\t\ttext,
\t\t\terror: String(err),
\t\t\tincrementAttemptCount: false
\t\t});`,
        "restart recovery pending-final failed attempt update",
      );
    }
    return next;
  }
  next = insertAfter(
    next,
    `function resolveRestartRecoveryDeliveryContext(params) {
\tconst deliveryContext = normalizeDeliveryContext(params.entry.pendingFinalDeliveryContext) ?? normalizeDeliveryContext(params.entry.restartRecoveryDeliveryContext) ?? (params.includeSessionDeliveryFallback ? deliveryContextFromSession(params.entry) : void 0);
\tconst channel = normalizeOptionalString(deliveryContext?.channel);
\tconst to = normalizeOptionalString(deliveryContext?.to);
\tif (!channel || !to || !isDeliverableMessageChannel(channel)) return;
\tif (params.cfg && resolveSendPolicy({
\t\tcfg: params.cfg,
\t\tentry: params.entry,
\t\tsessionKey: params.sessionKey,
\t\tchannel,
\t\tchatType: params.entry.chatType
\t}) === "deny") return;
\treturn {
\t\t...deliveryContext,
\t\tchannel,
\t\tto
\t};
}
`,
    `function normalizePendingFinalDeliveryBacklog(value) {
\tif (!Array.isArray(value)) return [];
\tconst out = [];
\tfor (const item of value) {
\t\tif (!item || typeof item !== "object" || Array.isArray(item)) continue;
\t\tconst text = typeof item.text === "string" ? sanitizePendingFinalDeliveryText(item.text) : "";
\t\tif (!text) continue;
\t\tout.push({
\t\t\ttext,
\t\t\tcontext: item.context,
\t\t\tcreatedAt: typeof item.createdAt === "number" ? item.createdAt : void 0,
\t\t\tlastAttemptAt: typeof item.lastAttemptAt === "number" ? item.lastAttemptAt : void 0,
\t\t\tattemptCount: typeof item.attemptCount === "number" ? item.attemptCount : void 0,
\t\t\tlastError: typeof item.lastError === "string" ? item.lastError : void 0,
\t\t\tintentId: typeof item.intentId === "string" ? item.intentId : void 0
\t\t});
\t}
\treturn out;
}
function promoteNextPendingFinalDeliveryOrClear(entry, updatedAt) {
\tconst backlog = normalizePendingFinalDeliveryBacklog(entry.pendingFinalDeliveryBacklog);
\tconst nextPending = backlog.shift();
\tif (nextPending) return {
\t\t...entry,
\t\tpendingFinalDelivery: true,
\t\tpendingFinalDeliveryText: nextPending.text,
\t\tpendingFinalDeliveryCreatedAt: nextPending.createdAt ?? updatedAt,
\t\tpendingFinalDeliveryLastAttemptAt: nextPending.lastAttemptAt,
\t\tpendingFinalDeliveryAttemptCount: nextPending.attemptCount,
\t\tpendingFinalDeliveryLastError: nextPending.lastError,
\t\tpendingFinalDeliveryContext: nextPending.context,
\t\tpendingFinalDeliveryIntentId: nextPending.intentId,
\t\tpendingFinalDeliveryBacklog: backlog.length > 0 ? backlog : void 0,
\t\tupdatedAt
\t};
\treturn {
\t\t...entry,
\t\tpendingFinalDelivery: void 0,
\t\tpendingFinalDeliveryText: void 0,
\t\tpendingFinalDeliveryCreatedAt: void 0,
\t\tpendingFinalDeliveryLastAttemptAt: void 0,
\t\tpendingFinalDeliveryAttemptCount: void 0,
\t\tpendingFinalDeliveryLastError: void 0,
\t\tpendingFinalDeliveryContext: void 0,
\t\tpendingFinalDeliveryIntentId: void 0,
\t\tpendingFinalDeliveryBacklog: void 0,
\t\tupdatedAt
\t};
}
function parseTelegramRecoveryThreadId(threadId) {
\tif (threadId == null) return;
\tif (typeof threadId === "number") return Number.isFinite(threadId) ? threadId : void 0;
\tif (typeof threadId !== "string") return threadId;
\tconst trimmed = threadId.trim();
\tif (!trimmed) return;
\tconst topicMatch = /^-?\\d+:topic:(\\d+)$/.exec(trimmed);
\tif (topicMatch?.[1]) return Number(topicMatch[1]);
\tconst scopedMatch = /^-?\\d+:(-?\\d+)$/.exec(trimmed);
\tif (scopedMatch?.[1]) return Number(scopedMatch[1]);
\treturn threadId;
}
function normalizeRecoveryDeliveryContextForSend(deliveryContext) {
\tif (deliveryContext?.channel !== "telegram") return deliveryContext;
\tconst threadId = parseTelegramRecoveryThreadId(deliveryContext.threadId);
\treturn {
\t\t...deliveryContext,
\t\t...threadId !== void 0 ? { threadId } : {}
\t};
}
function isRecoverableTerminalPendingFinalDelivery(entry) {
\tif (!entry || entry.status !== "done" || entry.pendingFinalDelivery !== true) return false;
\treturn Boolean(typeof entry.pendingFinalDeliveryText === "string" && sanitizePendingFinalDeliveryText(entry.pendingFinalDeliveryText));
}
function buildPendingFinalDeliveryRecoveryIdempotencyKey(params) {
\tconst hash = crypto.createHash("sha256").update([
\t\tparams.sessionKey,
\t\tparams.entry.sessionId ?? "",
\t\tString(params.entry.pendingFinalDeliveryCreatedAt ?? ""),
\t\tparams.text
\t].join("\\n")).digest("hex").slice(0, 24);
\treturn \`main-session-pending-final:\${params.entry.sessionId ?? params.sessionKey}:\${hash}\`;
}
async function markPendingFinalDeliveryRecoveryAttempt(params) {
\tawait applyRestartRecoveryLifecycle({
\t\tstorePath: params.storePath,
\t\tupdate: (entries) => {
\t\t\tconst found = entries.find((entry) => entry.sessionKey === params.sessionKey)?.entry;
\t\t\tif (!found || found.sessionId !== params.entry.sessionId) return { result: void 0 };
\t\t\tconst currentText = typeof found.pendingFinalDeliveryText === "string" ? sanitizePendingFinalDeliveryText(found.pendingFinalDeliveryText) : "";
\t\t\tif (currentText !== params.text) return { result: void 0 };
\t\t\tconst now = Date.now();
\t\t\tfound.pendingFinalDeliveryLastAttemptAt = now;
\t\t\tfound.pendingFinalDeliveryAttemptCount = (found.pendingFinalDeliveryAttemptCount ?? 0) + 1;
\t\t\tfound.pendingFinalDeliveryLastError = params.error ?? null;
\t\t\tfound.updatedAt = now;
\t\t\treturn {
\t\t\t\tresult: void 0,
\t\t\t\treplacements: [{
\t\t\t\t\tsessionKey: params.sessionKey,
\t\t\t\t\tentry: found
\t\t\t\t}]
\t\t\t};
\t\t}
\t});
}
async function clearRecoveredPendingFinalDelivery(params) {
\tawait applyRestartRecoveryLifecycle({
\t\tstorePath: params.storePath,
\t\tupdate: (entries) => {
\t\t\tconst found = entries.find((entry) => entry.sessionKey === params.sessionKey)?.entry;
\t\t\tif (!found || found.sessionId !== params.entry.sessionId) return { result: void 0 };
\t\t\tconst currentText = typeof found.pendingFinalDeliveryText === "string" ? sanitizePendingFinalDeliveryText(found.pendingFinalDeliveryText) : "";
\t\t\tif (currentText !== params.text) return { result: void 0 };
\t\t\treturn {
\t\t\t\tresult: void 0,
\t\t\t\treplacements: [{
\t\t\t\t\tsessionKey: params.sessionKey,
\t\t\t\t\tentry: promoteNextPendingFinalDeliveryOrClear(found, Date.now())
\t\t\t\t}]
\t\t\t};
\t\t}
\t});
}
async function recoverTerminalPendingFinalDelivery(params) {
\tconst text = sanitizePendingFinalDeliveryText(params.entry.pendingFinalDeliveryText ?? "");
\tif (!text) return false;
\tconst deliveryContext = normalizeRecoveryDeliveryContextForSend(resolveRestartRecoveryDeliveryContext({
\t\tcfg: params.cfg,
\t\tentry: params.entry,
\t\tincludeSessionDeliveryFallback: true,
\t\tsessionKey: params.sessionKey
\t}));
\tif (!deliveryContext) return false;
\tconst messageParams = {
\t\tto: deliveryContext.to,
\t\tmessage: text,
\t\tbestEffort: true
\t};
\tif (deliveryContext.threadId != null) messageParams.threadId = deliveryContext.threadId;
\tconst actionParams = {
\t\tchannel: deliveryContext.channel,
\t\taction: "send",
\t\tsessionKey: params.sessionKey,
\t\tsessionId: params.entry.sessionId,
\t\tidempotencyKey: buildPendingFinalDeliveryRecoveryIdempotencyKey({
\t\t\tsessionKey: params.sessionKey,
\t\t\tentry: params.entry,
\t\t\ttext
\t\t}),
\t\tparams: messageParams
\t};
\tconst accountId = normalizeOptionalString(deliveryContext.accountId);
\tif (accountId) actionParams.accountId = accountId;
\ttry {
\t\tawait markPendingFinalDeliveryRecoveryAttempt({
\t\t\tstorePath: params.storePath,
\t\t\tsessionKey: params.sessionKey,
\t\t\tentry: params.entry,
\t\t\ttext
\t\t});
\t\tawait callGateway({
\t\t\tmethod: "message.action",
\t\t\tparams: actionParams,
\t\t\ttimeoutMs: 3e4
\t\t});
\t\tawait clearRecoveredPendingFinalDelivery({
\t\t\tstorePath: params.storePath,
\t\t\tsessionKey: params.sessionKey,
\t\t\tentry: params.entry,
\t\t\ttext
\t\t});
\t\tlog.info(\`recovered terminal pending final delivery: \${params.sessionKey}\`);
\t\treturn true;
\t} catch (err) {
\t\tawait markPendingFinalDeliveryRecoveryAttempt({
\t\t\tstorePath: params.storePath,
\t\t\tsessionKey: params.sessionKey,
\t\t\tentry: params.entry,
\t\t\ttext,
\t\t\terror: String(err)
\t\t});
\t\tlog.warn(\`failed to recover terminal pending final delivery \${params.sessionKey}: \${String(err)}\`);
\t\treturn false;
\t}
}
`,
    "restart recovery pending-final terminal helpers",
  );
  next = replaceOnce(
    next,
    `for (const [sessionKey, entry] of Object.entries(store).toSorted(([a], [b]) => a.localeCompare(b))) {
\t\tif (!entry || entry.status !== "running" || entry.abortedLastRun !== true) continue;
\t\tif (shouldSkipMainRecovery(entry, sessionKey)) {`,
    `for (const [sessionKey, entry] of Object.entries(store).toSorted(([a], [b]) => a.localeCompare(b))) {
\t\tif (!entry) continue;
\t\tif (isRecoverableTerminalPendingFinalDelivery(entry)) {
\t\t\tif (shouldSkipMainRecovery(entry, sessionKey)) {
\t\t\t\tresult.skipped++;
\t\t\t\tcontinue;
\t\t\t}
\t\t\tif (!isRoutableRecoveryStore({
\t\t\t\tcfg: params.cfg,
\t\t\t\tsessionKey,
\t\t\t\tstorePath: params.storePath
\t\t\t})) {
\t\t\t\tresult.skipped++;
\t\t\t\tcontinue;
\t\t\t}
\t\t\tconst pendingDedupeKey = \`\${sessionKey}:pending-final:\${entry.pendingFinalDeliveryCreatedAt ?? ""}\`;
\t\t\tif (params.resumedSessionKeys.has(pendingDedupeKey)) {
\t\t\t\tresult.skipped++;
\t\t\t\tcontinue;
\t\t\t}
\t\t\tif (await recoverTerminalPendingFinalDelivery({
\t\t\t\tcfg: params.cfg,
\t\t\t\tentry,
\t\t\t\tstorePath: params.storePath,
\t\t\t\tsessionKey
\t\t\t})) {
\t\t\t\tparams.resumedSessionKeys.add(pendingDedupeKey);
\t\t\t\tresult.recovered++;
\t\t\t} else result.failed++;
\t\t\tcontinue;
\t\t}
\t\tif (entry.status !== "running" || entry.abortedLastRun !== true) continue;
\t\tif (shouldSkipMainRecovery(entry, sessionKey)) {`,
    "restart recovery pending-final terminal scan",
  );
  return next;
}

function main() {
  if (!fs.existsSync(distDir)) throw new Error(`dist directory does not exist: ${distDir}`);
  const files = walkJs(distDir);
  const targets = {
    allowed: findOne(files, "Telegram allowed updates bundle", ["DEFAULT_TELEGRAM_UPDATE_TYPES", "message_reaction", "channel_post"]),
    bot: findOne(files, "Telegram bot bundle", ["bot.on(\"message\"", "handleInboundMessageLike", "dispatchTelegramMessage"]),
    delivery: findOne(files, "Telegram delivery bundle", ["async function sendTelegramText", "async function deliverTextReply", "deliverMediaReply"]),
    telegramSentCache: findOne(files, "Telegram sent-message cache bundle", ["function shouldUseTelegramDmThreadSession", "function buildTelegramThreadParams", "function resolveTelegramThreadSpec"]),
    telegramSend: findOne(files, "Telegram send bundle", ["function buildTelegramSendParams", "function buildTelegramSendThreadParams", "function toTelegramRichMessageContextParams"]),
    chat: findOne(files, "chat gateway bundle", ["async function handleChatHistoryRequest", "\"chat.history\": async", "validateChatHistoryParams"]),
    sessions: findOne(files, "sessions gateway bundle", ["\"sessions.list\": async", "validateSessionsListParams", "loadCombinedSessionStoreForGateway"]),
    messageHandler: findOne(files, "gateway WebSocket message handler bundle", ["function resolvePinnedClientMetadata", "requirePairing(\"metadata-upgrade\"", "listEffectivePairedDeviceRoles"]),
    tools: findOneAny(files, "OpenClaw tool schema bundle", [
      ["Media URL/path. data: use buffer.", "Structured attachments; each entry uses media."],
      ["Local file path for outbound media", "Structured attachments. For local files"],
    ]),
    dispatch: findOne(files, "auto-reply dispatch bundle", ["async function clearPendingFinalDeliveryAfterSuccess", "const replies = replyResult ? Array.isArray(replyResult) ? replyResult : [replyResult] : []"]),
    agentRunner: findOne(files, "agent runner runtime bundle", ["function buildPendingFinalDeliveryText", "pendingFinalDeliveryContext", "resolveReplyRunDeliveryContext"]),
    agentCommand: findOne(files, "agent command bundle", ["function clearPendingFinalDeliveryFields", "pendingFinalDeliveryTextForThisRun", "resolveCurrentRunDeliveryContext"]),
    restartRecovery: findOne(files, "main-session restart recovery bundle", ["async function recoverStore", "pendingFinalDeliveryLastAttemptAt", "resolveRestartRecoveryDeliveryContext"]),
  };
  const results = [
    applyFile(targets.allowed, "telegram-guest-allowed-update", patchAllowedUpdates),
    applyFile(targets.bot, "telegram-guest-mode-bot", patchBot),
    applyFile(targets.delivery, "telegram-guest-mode-delivery", patchDelivery),
    applyFile(targets.telegramSentCache, "telegram-dm-topic-threading-cache", patchTelegramDmTopicSentMessageCache),
    applyFile(targets.telegramSend, "telegram-dm-topic-threading-send", patchTelegramDmTopicSend),
    applyFile(targets.chat, "windows-tray-chat-history-limit", patchChat),
    applyFile(targets.sessions, "windows-tray-sessions-list-limit", patchSessions),
    applyFile(targets.messageHandler, "windows-tray-dual-role-metadata-bypass", patchMessageHandler),
    applyFile(targets.tools, "message-tool-large-local-files-schema", patchToolSchema),
    applyFile(targets.dispatch, "pending-final-delivery-clear-guard", patchDispatchPendingFinalDelivery),
    applyFile(targets.agentRunner, "agent-runner-pending-final-backlog", patchAgentRunnerPendingFinalDelivery),
    applyFile(targets.agentCommand, "agent-command-pending-final-backlog", patchAgentCommandPendingFinalDelivery),
    applyFile(targets.restartRecovery, "terminal-pending-final-recovery", patchRestartRecoveryPendingFinalDelivery),
  ];
  const changed = results.filter((result) => result.changed).length;
  console.log(`[openclaw-2026.6.10-hotfixes] complete changed=${changed} packageRoot=${packageRoot}`);
}

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
