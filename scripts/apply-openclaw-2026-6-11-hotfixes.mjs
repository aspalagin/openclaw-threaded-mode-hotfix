#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/usr/lib/node_modules/openclaw";
const distDir = path.join(packageRoot, "dist");
const backupRoot = process.env.OPENCLAW_HOTFIX_BACKUP_DIR || "/root/openclaw-backups/openclaw-2026.6.11-hotfixes";
const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--check");

function fail(message) {
  console.error(`[openclaw-2026.6.11-hotfixes] ${message}`);
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
    console.log(`[openclaw-2026.6.11-hotfixes] ${label}: ok`);
    return { label, file, changed: false };
  }
  if (dryRun) {
    console.log(`[openclaw-2026.6.11-hotfixes] ${label}: would patch ${file}`);
    return { label, file, changed: true };
  }
  const backupPath = backupFile(file, before);
  fs.writeFileSync(file, after, "utf8");
  console.log(`[openclaw-2026.6.11-hotfixes] ${label}: patched ${file}; backup=${backupPath}`);
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
      `\t\t\tif (mediaList.length === 0 && resolvedReplyText) firstDeliveredMessageId = await deliverTextReply({
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
  // 2026.6.11: shouldUseTelegramDmThreadSession — уже исправлено upstream, патч не нужен
  // 2026.6.11: buildTelegramThreadParams dm scope — уже исправлено upstream (message_thread_id), патч не нужен
  // 2026.6.11: buildTelegramRoutingTarget — уже исправлено upstream, патч не нужен
  // Остаётся только resolveTelegramThreadSpec: добавить directMessagesTopicId fallback
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
  return next;
}

function patchTelegramDmTopicSend(source) {
  // 2026.6.11: accepted upstream — buildTelegramThreadParams уже использует message_thread_id для DM scope,
  // resolveForumLaneKey уже обрабатывает direct_messages_topic_id,
  // buildTelegramThreadReplyParams/buildTelegramSendParams уже используют message_thread_id.
  // Патч больше не нужен.
  return source;
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
  if (!next.includes('from "./pending-final-delivery-DHLlIudm.js"')) {
    next = replaceOnce(
      next,
      'import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DW4mBlAt.js";',
      'import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DW4mBlAt.js";\nimport { t as sanitizePendingFinalDeliveryText } from "./pending-final-delivery-DHLlIudm.js";',
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
    if (!next.includes("function isPermanentPendingFinalDeliveryError(err)")) {
      next = insertBefore(
        next,
        "function isRecoverableTerminalPendingFinalDelivery(entry) {",
        `const PERMANENT_PENDING_FINAL_DELIVERY_ERROR_RE = /message thread not found|chat not found|bot was blocked by the user|user is deactivated|group chat was deactivated/i;
function isPermanentPendingFinalDeliveryError(err) {
\treturn PERMANENT_PENDING_FINAL_DELIVERY_ERROR_RE.test(String(err));
}
`,
        "restart recovery permanent-error classifier",
      );
      next = replaceOnce(
        next,
        `} catch (err) {
\t\tawait markPendingFinalDeliveryRecoveryAttempt({
\t\t\tstorePath: params.storePath,
\t\t\tsessionKey: params.sessionKey,
\t\t\tentry: params.entry,
\t\t\ttext,
\t\t\terror: String(err),
\t\t\tincrementAttemptCount: false
\t\t});`,
        `} catch (err) {
\t\tif (isPermanentPendingFinalDeliveryError(err)) {
\t\t\tawait clearRecoveredPendingFinalDelivery({
\t\t\t\tstorePath: params.storePath,
\t\t\t\tsessionKey: params.sessionKey,
\t\t\t\tentry: params.entry,
\t\t\t\ttext
\t\t\t});
\t\t\tlog.warn("dead-lettered terminal pending final delivery " + params.sessionKey + ": permanent send error, dropping poison record: " + String(err));
\t\t\treturn false;
\t\t}
\t\tawait markPendingFinalDeliveryRecoveryAttempt({
\t\t\tstorePath: params.storePath,
\t\t\tsessionKey: params.sessionKey,
\t\t\tentry: params.entry,
\t\t\ttext,
\t\t\terror: String(err),
\t\t\tincrementAttemptCount: false
\t\t});`,
        "restart recovery permanent-error tombstone",
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

function patchToolResultTruncationFreshGuard(source) {
  // 2026-07-01: агрегатная обрезка tool-результатов (новое в 2026.6.11) обнуляла
  // СВЕЖИЕ in-run tool-результаты в провайдер-payload (text:"") при исчерпанном
  // aggregate-бюджете (projection-freeze делает их единственными eligible-кандидатами);
  // конвертер openai-completions подставлял "(see attached image)" вместо вывода exec/read.
  // Фикс: (1) хвостовая (свежая) группа toolResult-сообщений исключается из обеих
  // aggregate-фаз (per-result cap maxChars продолжает её ограничивать);
  // (2) clearToolResultText оставляет непустой маркер вместо пустой строки.
  if (source.includes("protectedEntryIds")) return source;
  let next = source;
  next = replaceOnce(
    next,
    `\tif (candidates.length < 2) return [];
\tconst suffixFactory = minKeepChars === RECOVERY_MIN_KEEP_CHARS`,
    `\tif (candidates.length < 2) return [];
\tconst protectedEntryIds = /* @__PURE__ */ new Set();
\tfor (let i = params.branch.length - 1; i >= 0; i--) {
\t\tconst entry = params.branch[i];
\t\tif (entry.type !== "message" || !entry.message || entry.message.role !== "toolResult") break;
\t\tprotectedEntryIds.add(entry.id);
\t}
\tconst suffixFactory = minKeepChars === RECOVERY_MIN_KEEP_CHARS`,
    "tool-result truncation trailing-protection set",
  );
  next = replaceOnce(
    next,
    "\tfor (const candidate of candidates.filter((item) => item.aggregateEligible).toSorted((a, b) => {",
    "\tfor (const candidate of candidates.filter((item) => item.aggregateEligible && !protectedEntryIds.has(item.entryId)).toSorted((a, b) => {",
    "tool-result truncation shrink-pass protected filter",
  );
  next = replaceOnce(
    next,
    "\tif (remainingReduction > 0) for (const candidate of candidates.filter((item) => item.aggregateEligible)) {",
    "\tif (remainingReduction > 0) for (const candidate of candidates.filter((item) => item.aggregateEligible && !protectedEntryIds.has(item.entryId))) {",
    "tool-result truncation clear-pass protected filter",
  );
  next = replaceOnce(
    next,
    `function clearToolResultText(message) {
\tconst content = message.content;
\tif (!Array.isArray(content)) return message;
\treturn {
\t\t...message,
\t\tcontent: content.map((block) => block && typeof block === "object" && block.type === "text" ? Object.assign({}, block, { text: "" }) : block)
\t};
}`,
    `function clearToolResultText(message) {
\tconst content = message.content;
\tif (!Array.isArray(content)) return message;
\tlet placeholderUsed = false;
\treturn {
\t\t...message,
\t\tcontent: content.map((block) => {
\t\t\tif (!(block && typeof block === "object" && block.type === "text")) return block;
\t\t\tconst text = placeholderUsed ? "" : "[tool result elided: aggregate tool-result budget exceeded; rerun the command if the output is needed]";
\t\t\tplaceholderUsed = true;
\t\t\treturn Object.assign({}, block, { text });
\t\t})
\t};
}`,
    "tool-result truncation non-empty clear placeholder",
  );
  return next;
}

// 2026-07-01: адаптация легаси-патча isolated-cron-readonly-model-catalog (слой 2026.5.18).
// В 2026.6.11 оба вызова loadModelCatalog в isolated-cron остались в write-форме:
// каждый прогон isolated cron пишет кэш каталога/models.json под agent-dir → гонки с gateway.
function patchIsolatedCronReadonlyCatalog(source) {
  const first = "loadModelCatalog({ config: params.cfgWithAgentDefaults, readOnly: true })";
  const second = "loadModelCatalog({ config: cfgWithAgentDefaults, readOnly: true })";
  let next = source;
  if (!next.includes(first)) next = replaceOnce(
    next,
    "loadModelCatalog({ config: params.cfgWithAgentDefaults })",
    first,
    "isolated cron model-selection catalog load",
  );
  if (!next.includes(second)) next = replaceOnce(
    next,
    "loadModelCatalog({ config: cfgWithAgentDefaults })",
    second,
    "isolated cron run catalog load",
  );
  return next;
}

// 2026-07-01: адаптация легаси-патча telegram-ingress-fast-poll-floor (инцидент cpu-max 2026-05-22).
// Цикл getUpdates в 2026.6.11 не имеет пола на слишком быстрые УСПЕШНЫЕ пустые циклы: если bot-api
// начинает отвечать мгновенно (игнорирует long-poll timeout), воркер крутится на 100% CPU.
function patchTelegramIngressFastPollFloor(source) {
  let next = source;
  next = insertAfter(
    next,
    "const pollTimeoutSeconds = resolveTelegramLongPollTimeoutSeconds(options.timeoutSeconds);",
    "\n\tconst emptyPollFastLoopFloorMs = 1e3;",
    "fast-poll floor constant",
  );
  next = insertAfter(
    next,
    `post({
\t\t\t\ttype: "poll-start",
\t\t\t\toffset,
\t\t\t\tstartedAt: Date.now()
\t\t\t});`,
    "\n\t\t\tconst requestStartedAt = Date.now();",
    "poll elapsed timer",
  );
  next = insertAfter(
    next,
    `post({
\t\t\t\t\ttype: "poll-success",
\t\t\t\t\toffset,
\t\t\t\t\tcount: result.length,
\t\t\t\t\tfinishedAt: Date.now()
\t\t\t\t});`,
    `
\t\t\t\tif (result.length === 0) {
\t\t\t\t\tconst elapsedMs = Date.now() - requestStartedAt;
\t\t\t\t\tif (elapsedMs < emptyPollFastLoopFloorMs) await sleep(emptyPollFastLoopFloorMs - elapsedMs);
\t\t\t\t}`,
    "fast-poll floor sleep",
  );
  return next;
}

// 2026-07-02: loop-abort-run-on-critical (аудит-находка runtime-loop-block-does-not-abort-run).
// Детектор циклов БЛОКИРУЕТ вызов инструмента, но НЕ прерывает ран: runaway жёг ~190
// near-full-context запросов за 9.5 мин. Патч 1 пробрасывает graceful-abort callback в
// tool-hook context (та же область видимости, что runAbortController/abortRunForExternalSignal).
function patchLoopAbortHookContext(source) {
  return insertAfter(
    source,
    "const catalogToolHookContext = {\n",
    "\t\t\tonCriticalLoopAbort: (reason) => { if (runAbortController.signal.aborted) return; if (abortRunForExternalSignal) abortRunForExternalSignal(false, reason); else runAbortController.abort(reason); },\n",
    "loop-abort hook context callback",
  );
}

// Патч 2 считает ПОДРЯД идущие critical-блокировки на ран; на пороге (env
// OPENCLAW_LOOP_ABORT_THRESHOLD, по умолчанию 3) прерывает ран через graceful-путь
// (тот же, что user-cancel/idle-timeout -> stopReason=aborted, юзер получает терминал).
// Инъекция без template-literals (конкатенация), чтобы избежать проблем экранирования.
function patchLoopAbortRunOnCritical(source) {
  let next = source;
  next = insertAfter(
    next,
    "log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);",
    "\n\t\t\t\t{ const __lat = Number.parseInt(process.env.OPENCLAW_LOOP_ABORT_THRESHOLD ?? \"\", 10); const __thr = Number.isInteger(__lat) && __lat > 0 ? __lat : 3; if (!sessionState.criticalLoopBlocks) sessionState.criticalLoopBlocks = new Map(); const __rk = args.ctx.runId ?? \"\"; const __n = (sessionState.criticalLoopBlocks.get(__rk) ?? 0) + 1; sessionState.criticalLoopBlocks.set(__rk, __n); if (__n >= __thr && typeof args.ctx.onCriticalLoopAbort === \"function\") { log.error(\"Aborting run \" + (args.ctx.runId ?? \"?\") + \" after \" + __n + \" consecutive critical loop blocks (threshold=\" + __thr + \"); stopReason=loop_detected\"); const __e = new Error(\"loop_detected: \" + loopResult.message); __e.name = \"LoopDetectedAbort\"; try { args.ctx.onCriticalLoopAbort(__e); } catch (err) { log.warn(\"loop abort failed: \" + String(err)); } } }",
    "loop-abort consecutive-block counter",
  );
  next = insertBefore(
    next,
    "if (args.ctx.loopDetection?.enabled !== false) recordToolCall(sessionState, toolName, params, args.toolCallId, args.ctx.loopDetection, loopScope);",
    "if (!loopResult.stuck) sessionState.criticalLoopBlocks?.delete(args.ctx.runId ?? \"\");\n\t\t\t",
    "loop-abort counter reset on progress",
  );
  return next;
}

// 2026-07-02: subagent-resume-backoff-window (аудит-находка runtime-subagent-autoresume-relit-broken-session).
// Gate уже есть, но 2-мин окно сброса счётчика позволяет медленным (раз в ~8 мин) context-overflow
// resume'ам обнулять счётчик и перезапускаться вечно. Расширяем окно 2->30 мин (env-tunable) и
// делаем cap env-tunable — accepted-resume счётчик становится реальным max-resume backstop'ом.
// При исчерпании gate возвращает allowed:false+shouldMarkWedged -> ран финализируется терминальной ошибкой.
function patchSubagentResumeBackoff(source) {
  if (source.includes("OPENCLAW_SUBAGENT_RESUME_WINDOW_MS")) return source;
  return replaceOnce(
    source,
    `const SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS = 2;
const SUBAGENT_RECOVERY_REWEDGE_WINDOW_MS = 2 * 6e4;`,
    `const SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS = (() => { const raw = process.env.OPENCLAW_SUBAGENT_RESUME_MAX_FAILS?.trim(); const n = raw ? Number.parseInt(raw, 10) : NaN; return Number.isFinite(n) && n >= 1 ? n : 2; })();
const SUBAGENT_RECOVERY_REWEDGE_WINDOW_MS = (() => { const raw = process.env.OPENCLAW_SUBAGENT_RESUME_WINDOW_MS?.trim(); const n = raw ? Number.parseInt(raw, 10) : NaN; return Number.isFinite(n) && n > 0 ? n : 30 * 6e4; })();`,
    "subagent resume backoff window",
  );
}

// 2026-07-02: stuck-reply-run-watchdog — лечение пер-топиковых зависаний Telegram-lane
// (memory: telegram-lane-wedge-2026-07-02). Симптом: embedded-ран завершается (session.ended
// в trajectory, финальный ответ в JSONL), но reply-операция в replyRunRegistry не очищается:
// followup-очередь и buffered spool-claim висят до ingress-watchdog (1500s), финальный ответ
// может теряться. Точный висящий await в runReplyAgent пока не локализован.
// Сторож: каждые 30s ищет операции phase=running без attached backend и без записи в
// ACTIVE_EMBEDDED_RUNS дольше 180s подряд → лог + abortByUser(); если через 30s операция
// всё ещё зарегистрирована → fail+complete (принудительная очистка). Худший случай ~4 мин
// вместо 25. Ложные срабатывания исключены: у живых ранов есть либо attached backend
// (execute.runtime/claude-live-session/selection queue handle), либо запись в
// ACTIVE_EMBEDDED_RUNS; фазы preflight_compacting/memory_flushing не equal "running".
function patchStuckReplyRunWatchdog(source) {
  if (source.includes("stuck-reply-run-watchdog")) return source;
  return insertBefore(
    source,
    "export { waitForReplyRunFollowupAdmission as A",
    `//#region hotfix: stuck-reply-run-watchdog (2026-07-02)
const STUCK_REPLY_RUN_SCAN_INTERVAL_MS = 3e4;
const STUCK_REPLY_RUN_GRACE_MS = 18e4;
const STUCK_REPLY_RUN_ABORT_SETTLE_MS = 3e4;
const stuckReplyRunFirstSeenAt = /* @__PURE__ */ new WeakMap();
const stuckReplyRunAbortedAt = /* @__PURE__ */ new WeakMap();
function stuckReplyRunWatchdogLog(message) {
\ttry {
\t\tconsole.error(\`[hotfix][stuck-reply-run-watchdog] \${message}\`);
\t} catch {}
}
function scanForStuckReplyRuns() {
\tconst now = Date.now();
\tfor (const [sessionKey, operation] of [...replyRunState.activeRunsByKey]) try {
\t\tconst abortedAt = stuckReplyRunAbortedAt.get(operation);
\t\tif (abortedAt !== void 0) {
\t\t\tif (now - abortedAt < STUCK_REPLY_RUN_ABORT_SETTLE_MS) continue;
\t\t\tif (replyRunState.activeRunsByKey.get(sessionKey) !== operation) continue;
\t\t\tstuckReplyRunWatchdogLog(\`reply operation \${sessionKey} (sessionId=\${operation.sessionId}, phase=\${operation.phase}) still registered \${Math.round((now - abortedAt) / 1e3)}s after watchdog abort; force-clearing so followups can drain\`);
\t\t\toperation.fail("run_failed", /* @__PURE__ */ new Error("stuck reply run force-cleared by hotfix watchdog"));
\t\t\toperation.complete();
\t\t\tcontinue;
\t\t}
\t\tconst suspect = operation.phase === "running" && getAttachedBackend(operation) === void 0 && !ACTIVE_EMBEDDED_RUNS.has(operation.sessionId);
\t\tif (!suspect) {
\t\t\tstuckReplyRunFirstSeenAt.delete(operation);
\t\t\tcontinue;
\t\t}
\t\tconst firstSeenAt = stuckReplyRunFirstSeenAt.get(operation);
\t\tif (firstSeenAt === void 0) {
\t\t\tstuckReplyRunFirstSeenAt.set(operation, now);
\t\t\tcontinue;
\t\t}
\t\tconst stuckMs = now - firstSeenAt;
\t\tif (stuckMs < STUCK_REPLY_RUN_GRACE_MS) continue;
\t\tstuckReplyRunWatchdogLog(\`reply operation \${sessionKey} (sessionId=\${operation.sessionId}) has had no active run or backend for \${Math.round(stuckMs / 1e3)}s while phase=running; aborting stuck reply work (telegram lane wedge mitigation)\`);
\t\tstuckReplyRunAbortedAt.set(operation, now);
\t\toperation.abortByUser();
\t} catch (err) {
\t\tstuckReplyRunWatchdogLog(\`scan error for \${sessionKey}: \${String(err)}\`);
\t}
}
const stuckReplyRunWatchdogTimer = setInterval(scanForStuckReplyRuns, STUCK_REPLY_RUN_SCAN_INTERVAL_MS);
stuckReplyRunWatchdogTimer.unref?.();
//#endregion
`,
    "stuck reply run watchdog",
  );
}

// 2026-07-03: wedge-инцидент, глубокая локализация (см. HOTFIX_MANIFEST.md, секция 2026-07-03).
// replyRunRegistry чистится только ПОСЛЕ полной telegram-доставки финального payload
// (completeDispatchReplyOperation), а в доставочной цепочке есть непокрытые таймаутом await'ы.
// 1) sendrichmessage отсутствовал в TELEGRAM_REQUEST_TIMEOUTS_MS -> клиентский fetch вообще
//    не ставил таймер, оставался только grammY-дефолт 500s/попытка.
function patchTelegramRichSendTimeout(source) {
  if (source.includes("\tsendrichmessage: TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS,")) return source;
  return replaceOnce(
    source,
    "\tsendphoto: 3e4,",
    "\tsendphoto: 3e4,\n\tsendrichmessage: TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS,",
    "sendrichmessage request timeout entry",
  );
}

// 2) голый `await dispatcher.waitForIdle()` в transcript-mirror (без таймаута и abort-signal)
//    мог парковать dispatchAgentReply навсегда — registry-заложник, лейн заклинен.
//    Bound: 120s, при пробое — warn и пропуск mirror (пропуск толерируется кодом ниже).
function patchBoundedMirrorIdleWait(source) {
  if (source.includes("hotfix: bounded-mirror-idle-wait")) return source;
  return replaceOnce(
    source,
    "async function mirrorTranscriptAfterDispatcherDelivery(params) {\n\tawait params.dispatcher.waitForIdle();",
    [
      "async function mirrorTranscriptAfterDispatcherDelivery(params) {",
      "\t//#region hotfix: bounded-mirror-idle-wait (2026-07-03)",
      "\tconst HOTFIX_MIRROR_IDLE_TIMEOUT_MS = 12e4;",
      "\tlet hotfixMirrorIdleTimer;",
      "\tlet hotfixMirrorIdleTimedOut = false;",
      "\tawait Promise.race([params.dispatcher.waitForIdle(), new Promise((resolve) => {",
      "\t\thotfixMirrorIdleTimer = setTimeout(() => {",
      "\t\t\thotfixMirrorIdleTimedOut = true;",
      "\t\t\tresolve();",
      "\t\t}, HOTFIX_MIRROR_IDLE_TIMEOUT_MS);",
      "\t\thotfixMirrorIdleTimer.unref?.();",
      "\t})]);",
      "\tif (hotfixMirrorIdleTimer !== void 0) clearTimeout(hotfixMirrorIdleTimer);",
      "\tif (hotfixMirrorIdleTimedOut) {",
      "\t\tconsole.error(`[hotfix][bounded-mirror-idle-wait] dispatcher.waitForIdle() still busy after ${HOTFIX_MIRROR_IDLE_TIMEOUT_MS}ms following final payload; skipping transcript mirror so dispatch can complete`);",
      "\t\treturn;",
      "\t}",
      "\t//#endregion",
    ].join("\n"),
    "bounded mirror idle wait",
  );
}

// 3a) диагностические маркеры пост-ранного сегмента runReplyAgent: при следующем wedge
//     последний увиденный маркер однозначно назовёт сегмент парковки (residual E3).
function patchReplyDiagMarkersRuntime(source) {
  if (source.includes("[hotfix][reply-diag] post-run flush start")) return source;
  let next = source;
  next = replaceOnce(
    next,
    "\t\tconst payloadArray = runResult.payloads ?? [];\n\t\tif (blockReplyPipeline) {",
    "\t\tconst payloadArray = runResult.payloads ?? [];\n\t\tconsole.error(`[hotfix][reply-diag] post-run flush start session=${(() => { try { return sessionKey ?? params?.sessionKey ?? '?'; } catch { return '?'; } })()}`);\n\t\tif (blockReplyPipeline) {",
    "post-run flush marker",
  );
  next = replaceOnce(
    next,
    "\t\tconst payloadResult = await buildReplyPayloads({",
    "\t\tconsole.error(`[hotfix][reply-diag] post-run buildReplyPayloads start session=${(() => { try { return sessionKey ?? params?.sessionKey ?? '?'; } catch { return '?'; } })()}`);\n\t\tconst payloadResult = await buildReplyPayloads({",
    "post-run buildReplyPayloads marker",
  );
  next = replaceOnce(
    next,
    "\t\t\t\tconst pendingFinalDeliveryIntentId = crypto.randomUUID();",
    "\t\t\t\tconsole.error(`[hotfix][reply-diag] post-run persisting pendingFinalDelivery session=${(() => { try { return sessionKey ?? params?.sessionKey ?? '?'; } catch { return '?'; } })()}`);\n\t\t\t\tconst pendingFinalDeliveryIntentId = crypto.randomUUID();",
    "post-run pendingFinalDelivery marker",
  );
  return next;
}

// 3b) маркеры dispatch-стороны: старт финальной доставки и завершение reply-операции.
function patchReplyDiagMarkersDispatch(source) {
  if (source.includes("[hotfix][reply-diag] final payload dispatch start")) return source;
  let next = source;
  next = replaceOnce(
    next,
    "\t\t\tconst finalReply = await sendFinalPayload(reply, { deliveryId: String(replyIndex) });",
    "\t\t\tconsole.error(`[hotfix][reply-diag] final payload dispatch start session=${(() => { try { return sessionKey ?? '?'; } catch { return '?'; } })()} delivery=${String(replyIndex)}`);\n\t\t\tconst finalReply = await sendFinalPayload(reply, { deliveryId: String(replyIndex) });",
    "final payload dispatch marker",
  );
  next = replaceOnce(
    next,
    "\t\trecordProcessed(\"completed\", pluginFallbackReason ? { reason: pluginFallbackReason } : void 0);\n\t\tmarkIdle(\"message_completed\");\n\t\tcompleteDispatchReplyOperation();",
    "\t\trecordProcessed(\"completed\", pluginFallbackReason ? { reason: pluginFallbackReason } : void 0);\n\t\tmarkIdle(\"message_completed\");\n\t\tconsole.error(`[hotfix][reply-diag] dispatch reply operation complete session=${(() => { try { return sessionKey ?? '?'; } catch { return '?'; } })()}`);\n\t\tcompleteDispatchReplyOperation();",
    "dispatch reply operation complete marker",
  );
  return next;
}

function patchTelegramProgressCommentaryDraftOnly(source) {
  if (source.includes("hotfix: telegram-progress-commentary-draft-only")) return source;
  return replaceOnce(
    source,
    `\t\tconst deliverStandaloneCommentaryProgress = shouldEmitVerboseProgress();
\t\tconst itemEventForwardingOptions = {
\t\t\tforwardWhenSourceDeliverySuppressed: true,
\t\t\trequiresToolSummaryVisibility: true
\t\t};
\t\tconst canForwardItemEvents = Boolean(params.replyOptions?.onItemEvent) && shouldForwardProgressCallback(itemEventForwardingOptions);
\t\tconst canForwardSuppressedSourceItemEvents = suppressAutomaticSourceDelivery && allowSuppressedSourceProgressCallbacks && canForwardItemEvents;`,
    `\t\tconst itemEventForwardingOptions = {
\t\t\tforwardWhenSourceDeliverySuppressed: true,
\t\t\trequiresToolSummaryVisibility: true
\t\t};
\t\tconst canForwardItemEvents = Boolean(params.replyOptions?.onItemEvent) && shouldForwardProgressCallback(itemEventForwardingOptions);
\t\t//#region hotfix: telegram-progress-commentary-draft-only (2026-07-03)
\t\tconst channelDraftCommentaryProgressEnabled = canForwardItemEvents && params.replyOptions?.commentaryProgressEnabled === true;
\t\tconst deliverStandaloneCommentaryProgress = shouldEmitVerboseProgress() && !channelDraftCommentaryProgressEnabled;
\t\t//#endregion
\t\tconst canForwardSuppressedSourceItemEvents = suppressAutomaticSourceDelivery && allowSuppressedSourceProgressCallbacks && canForwardItemEvents;`,
    "Telegram progress commentary standalone suppression",
  );
}

function patchTelegramAutoTopicLabelAfterNew(source) {
  let next = source;
  if (!next.includes("hotfix: telegram-auto-topic-label-after-new")) {
    next = insertBefore(
      next,
      `//#endregion
//#region extensions/telegram/src/auto-topic-label.ts
async function generateTelegramTopicLabel(params) {`,
      `//#region hotfix: telegram-auto-topic-label-after-new (2026-07-05)
function compareTelegramTopicLabelMessageIds(left, right) {
\tconst leftId = Number(left);
\tconst rightId = Number(right);
\tif (Number.isFinite(leftId) && Number.isFinite(rightId)) return leftId - rightId;
\treturn String(left ?? "").localeCompare(String(right ?? ""));
}
function resolveTelegramSessionBoundaryTopicLabelTail(text) {
\tconst body = text?.trim();
\tif (!body || !isTelegramSessionBoundaryCommandText(body)) return "";
\tconst match = body.match(/^\\/(?:new|reset)(?:@[A-Za-z0-9_]+)?(?:\\s|$)/i);
\treturn match ? body.slice(match[0].length).trimStart() : "";
}
function resolveTelegramDirectMessagesTopicId(msg) {
\tconst directTopicId = msg?.direct_messages_topic?.topic_id ?? msg?.direct_messages_topic_id;
\tconst numericTopicId = Number(directTopicId);
\treturn Number.isFinite(numericTopicId) ? numericTopicId : void 0;
}
function resolveTelegramEffectiveMessageThreadId(msg) {
\treturn msg?.message_thread_id ?? resolveTelegramDirectMessagesTopicId(msg);
}
function* iterateTelegramTopicSourceMessages(ctx, msg) {
\tif (msg) yield msg;
\tconst update = ctx?.update;
\tconst candidates = [
\t\tctx?.message,
\t\tupdate?.message,
\t\tupdate?.edited_message,
\t\tupdate?.channel_post,
\t\tupdate?.edited_channel_post,
\t\tupdate?.callback_query?.message
\t];
\tfor (const candidate of candidates) if (candidate && candidate !== msg) yield candidate;
}
function resolveTelegramEffectiveMessageThreadIdFromContext(ctx, msg) {
\tfor (const candidate of iterateTelegramTopicSourceMessages(ctx, msg)) {
\t\tconst messageThreadId = resolveTelegramEffectiveMessageThreadId(candidate);
\t\tif (messageThreadId != null) return messageThreadId;
\t}
}
function formatTelegramNativeSlashTopicDebug(ctx, msg, effectiveThreadId) {
\tconst rawMessage = ctx?.update?.message;
\tconst msgThreadId = msg?.message_thread_id ?? "none";
\tconst msgDirectTopicId = resolveTelegramDirectMessagesTopicId(msg) ?? "none";
\tconst rawThreadId = rawMessage?.message_thread_id ?? "none";
\tconst rawDirectTopicId = resolveTelegramDirectMessagesTopicId(rawMessage) ?? "none";
\treturn \`msgThread=\${msgThreadId} msgDirectTopic=\${msgDirectTopicId} rawThread=\${rawThreadId} rawDirectTopic=\${rawDirectTopicId} effectiveThread=\${effectiveThreadId ?? "none"}\`;
}
const telegramAutoTopicLabelSessionBoundaries = /* @__PURE__ */ new Map();
function buildTelegramAutoTopicLabelBoundaryKey(params) {
\treturn [
\t\tparams.accountId ?? "",
\t\tparams.chatId ?? "",
\t\tparams.threadId ?? "",
\t\tparams.senderId ?? ""
\t].map((part) => String(part)).join("|");
}
function rememberTelegramAutoTopicLabelSessionBoundary(params) {
\tif (!params.messageId || params.threadId === void 0 || params.threadId === null) return;
\ttelegramAutoTopicLabelSessionBoundaries.set(buildTelegramAutoTopicLabelBoundaryKey(params), {
\t\tmessageId: String(params.messageId),
\t\tsenderId: params.senderId ? String(params.senderId) : "",
\t\tcreatedAtMs: Date.now()
\t});
\tif (telegramAutoTopicLabelSessionBoundaries.size > 200) {
\t\tconst now = Date.now();
\t\tfor (const [key, boundary] of telegramAutoTopicLabelSessionBoundaries) {
\t\t\tif (now - boundary.createdAtMs > 36e5) telegramAutoTopicLabelSessionBoundaries.delete(key);
\t\t\tif (telegramAutoTopicLabelSessionBoundaries.size <= 200) break;
\t\t}
\t}
}
function consumeTelegramAutoTopicLabelSessionBoundary(params) {
\tif (!params.messageId) return false;
\tconst key = buildTelegramAutoTopicLabelBoundaryKey(params);
\tconst boundary = telegramAutoTopicLabelSessionBoundaries.get(key);
\tif (!boundary) return false;
\tif (Date.now() - boundary.createdAtMs > 36e5) {
\t\ttelegramAutoTopicLabelSessionBoundaries.delete(key);
\t\treturn false;
\t}
\tif (params.senderId && boundary.senderId && String(params.senderId) !== boundary.senderId) return false;
\tif (compareTelegramTopicLabelMessageIds(params.messageId, boundary.messageId) <= 0) return false;
\ttelegramAutoTopicLabelSessionBoundaries.delete(key);
\treturn true;
}
async function isFirstTelegramUserMessageAfterSessionBoundary(params) {
\tif (!params.messageId) return false;
\tconst boundary = await params.messageCache.latestMatchingAtOrBefore({
\t\taccountId: params.accountId,
\t\tchatId: params.chatId,
\t\tmessageId: params.messageId,
\t\t...params.threadId !== void 0 ? { threadId: params.threadId } : {},
\t\tmatches: (node) => isTelegramSessionBoundaryCommandText(node.body)
\t});
\tif (!boundary?.messageId || compareTelegramTopicLabelMessageIds(params.messageId, boundary.messageId) <= 0) return consumeTelegramAutoTopicLabelSessionBoundary(params);
\tconst latestUserMessage = await params.messageCache.latestMatchingAtOrBefore({
\t\taccountId: params.accountId,
\t\tchatId: params.chatId,
\t\tmessageId: params.messageId,
\t\t...params.threadId !== void 0 ? { threadId: params.threadId } : {},
\t\tmatches: (node) => {
\t\t\tif (!node.messageId || compareTelegramTopicLabelMessageIds(node.messageId, boundary.messageId) <= 0) return false;
\t\t\tif (params.senderId && node.senderId !== params.senderId) return false;
\t\t\tconst body = node.body?.trim();
\t\t\treturn Boolean(body && !isTelegramSessionBoundaryCommandText(body));
\t\t}
\t});
\treturn latestUserMessage?.messageId === params.messageId || consumeTelegramAutoTopicLabelSessionBoundary(params);
}
//#endregion
`,
      "Telegram auto topic label after /new helpers",
    );
  }
  if (!next.includes("resolveTelegramEffectiveMessageThreadId")) {
    next = replaceOnce(
      next,
      `function resolveTelegramSessionBoundaryTopicLabelTail(text) {
\tconst body = text?.trim();
\tif (!body || !isTelegramSessionBoundaryCommandText(body)) return "";
\tconst match = body.match(/^\\/(?:new|reset)(?:@[A-Za-z0-9_]+)?(?:\\s|$)/i);
\treturn match ? body.slice(match[0].length).trimStart() : "";
}
const telegramAutoTopicLabelSessionBoundaries = /* @__PURE__ */ new Map();`,
      `function resolveTelegramSessionBoundaryTopicLabelTail(text) {
\tconst body = text?.trim();
\tif (!body || !isTelegramSessionBoundaryCommandText(body)) return "";
\tconst match = body.match(/^\\/(?:new|reset)(?:@[A-Za-z0-9_]+)?(?:\\s|$)/i);
\treturn match ? body.slice(match[0].length).trimStart() : "";
}
function resolveTelegramDirectMessagesTopicId(msg) {
\tconst directTopicId = msg?.direct_messages_topic?.topic_id ?? msg?.direct_messages_topic_id;
\tconst numericTopicId = Number(directTopicId);
\treturn Number.isFinite(numericTopicId) ? numericTopicId : void 0;
}
function resolveTelegramEffectiveMessageThreadId(msg) {
\treturn msg?.message_thread_id ?? resolveTelegramDirectMessagesTopicId(msg);
}
const telegramAutoTopicLabelSessionBoundaries = /* @__PURE__ */ new Map();`,
      "Telegram auto topic label DM direct topic helper",
    );
  }
  if (!next.includes("resolveTelegramEffectiveMessageThreadIdFromContext")) {
    next = replaceOnce(
      next,
      `function resolveTelegramEffectiveMessageThreadId(msg) {
\treturn msg?.message_thread_id ?? resolveTelegramDirectMessagesTopicId(msg);
}
const telegramAutoTopicLabelSessionBoundaries = /* @__PURE__ */ new Map();`,
      `function resolveTelegramEffectiveMessageThreadId(msg) {
\treturn msg?.message_thread_id ?? resolveTelegramDirectMessagesTopicId(msg);
}
function* iterateTelegramTopicSourceMessages(ctx, msg) {
\tif (msg) yield msg;
\tconst update = ctx?.update;
\tconst candidates = [
\t\tctx?.message,
\t\tupdate?.message,
\t\tupdate?.edited_message,
\t\tupdate?.channel_post,
\t\tupdate?.edited_channel_post,
\t\tupdate?.callback_query?.message
\t];
\tfor (const candidate of candidates) if (candidate && candidate !== msg) yield candidate;
}
function resolveTelegramEffectiveMessageThreadIdFromContext(ctx, msg) {
\tfor (const candidate of iterateTelegramTopicSourceMessages(ctx, msg)) {
\t\tconst messageThreadId = resolveTelegramEffectiveMessageThreadId(candidate);
\t\tif (messageThreadId != null) return messageThreadId;
\t}
}
function formatTelegramNativeSlashTopicDebug(ctx, msg, effectiveThreadId) {
\tconst rawMessage = ctx?.update?.message;
\tconst msgThreadId = msg?.message_thread_id ?? "none";
\tconst msgDirectTopicId = resolveTelegramDirectMessagesTopicId(msg) ?? "none";
\tconst rawThreadId = rawMessage?.message_thread_id ?? "none";
\tconst rawDirectTopicId = resolveTelegramDirectMessagesTopicId(rawMessage) ?? "none";
\treturn \`msgThread=\${msgThreadId} msgDirectTopic=\${msgDirectTopicId} rawThread=\${rawThreadId} rawDirectTopic=\${rawDirectTopicId} effectiveThread=\${effectiveThreadId ?? "none"}\`;
}
const telegramAutoTopicLabelSessionBoundaries = /* @__PURE__ */ new Map();`,
      "Telegram native slash raw topic helper",
    );
  }
  if (!next.includes("rememberTelegramAutoTopicLabelSessionBoundary")) {
    next = replaceOnce(
      next,
      `function resolveTelegramSessionBoundaryTopicLabelTail(text) {
\tconst body = text?.trim();
\tif (!body || !isTelegramSessionBoundaryCommandText(body)) return "";
\tconst match = body.match(/^\\/(?:new|reset)(?:@[A-Za-z0-9_]+)?(?:\\s|$)/i);
\treturn match ? body.slice(match[0].length).trimStart() : "";
}
async function isFirstTelegramUserMessageAfterSessionBoundary(params) {`,
      `function resolveTelegramSessionBoundaryTopicLabelTail(text) {
\tconst body = text?.trim();
\tif (!body || !isTelegramSessionBoundaryCommandText(body)) return "";
\tconst match = body.match(/^\\/(?:new|reset)(?:@[A-Za-z0-9_]+)?(?:\\s|$)/i);
\treturn match ? body.slice(match[0].length).trimStart() : "";
}
function resolveTelegramDirectMessagesTopicId(msg) {
\tconst directTopicId = msg?.direct_messages_topic?.topic_id ?? msg?.direct_messages_topic_id;
\tconst numericTopicId = Number(directTopicId);
\treturn Number.isFinite(numericTopicId) ? numericTopicId : void 0;
}
function resolveTelegramEffectiveMessageThreadId(msg) {
\treturn msg?.message_thread_id ?? resolveTelegramDirectMessagesTopicId(msg);
}
const telegramAutoTopicLabelSessionBoundaries = /* @__PURE__ */ new Map();
function buildTelegramAutoTopicLabelBoundaryKey(params) {
\treturn [
\t\tparams.accountId ?? "",
\t\tparams.chatId ?? "",
\t\tparams.threadId ?? "",
\t\tparams.senderId ?? ""
\t].map((part) => String(part)).join("|");
}
function rememberTelegramAutoTopicLabelSessionBoundary(params) {
\tif (!params.messageId || params.threadId === void 0 || params.threadId === null) return;
\ttelegramAutoTopicLabelSessionBoundaries.set(buildTelegramAutoTopicLabelBoundaryKey(params), {
\t\tmessageId: String(params.messageId),
\t\tsenderId: params.senderId ? String(params.senderId) : "",
\t\tcreatedAtMs: Date.now()
\t});
\tif (telegramAutoTopicLabelSessionBoundaries.size > 200) {
\t\tconst now = Date.now();
\t\tfor (const [key, boundary] of telegramAutoTopicLabelSessionBoundaries) {
\t\t\tif (now - boundary.createdAtMs > 36e5) telegramAutoTopicLabelSessionBoundaries.delete(key);
\t\t\tif (telegramAutoTopicLabelSessionBoundaries.size <= 200) break;
\t\t}
\t}
}
function consumeTelegramAutoTopicLabelSessionBoundary(params) {
\tif (!params.messageId) return false;
\tconst key = buildTelegramAutoTopicLabelBoundaryKey(params);
\tconst boundary = telegramAutoTopicLabelSessionBoundaries.get(key);
\tif (!boundary) return false;
\tif (Date.now() - boundary.createdAtMs > 36e5) {
\t\ttelegramAutoTopicLabelSessionBoundaries.delete(key);
\t\treturn false;
\t}
\tif (params.senderId && boundary.senderId && String(params.senderId) !== boundary.senderId) return false;
\tif (compareTelegramTopicLabelMessageIds(params.messageId, boundary.messageId) <= 0) return false;
\ttelegramAutoTopicLabelSessionBoundaries.delete(key);
\treturn true;
}
async function isFirstTelegramUserMessageAfterSessionBoundary(params) {`,
      "Telegram auto topic label native slash boundary helpers",
    );
  }
  if (!next.includes("consumeTelegramAutoTopicLabelSessionBoundary(params);")) {
    next = replaceOnce(
      next,
      `\tif (!boundary?.messageId || compareTelegramTopicLabelMessageIds(params.messageId, boundary.messageId) <= 0) return false;`,
      `\tif (!boundary?.messageId || compareTelegramTopicLabelMessageIds(params.messageId, boundary.messageId) <= 0) return consumeTelegramAutoTopicLabelSessionBoundary(params);`,
      "Telegram auto topic label cache-miss boundary fallback",
    );
    next = replaceOnce(
      next,
      `\treturn latestUserMessage?.messageId === params.messageId;`,
      `\treturn latestUserMessage?.messageId === params.messageId || consumeTelegramAutoTopicLabelSessionBoundary(params);`,
      "Telegram auto topic label latest-message boundary fallback",
    );
  }
  if (!next.includes("let isFirstUserMessageAfterSessionBoundary = false;")) {
    next = replaceOnce(
      next,
      `\t\tconst isDmTopic = !isGroup && threadSpec.scope === "dm" && threadSpec.id != null;
\t\tlet queuedFinal = false;`,
      `\t\tconst isDmTopic = !isGroup && threadSpec.scope === "dm" && threadSpec.id != null;
\t\tconst topicLabelCommandText = ctxPayload.CommandBody ?? ctxPayload.RawBody ?? ctxPayload.Body ?? "";
\t\tconst isCurrentSessionBoundaryCommand = isTelegramSessionBoundaryCommandText(topicLabelCommandText);
\t\tconst sessionBoundaryTopicLabelTail = isCurrentSessionBoundaryCommand ? resolveTelegramSessionBoundaryTopicLabelTail(topicLabelCommandText) : "";
\t\tlet queuedFinal = false;`,
      "Telegram auto topic label session-boundary state",
    );
    next = replaceOnce(
      next,
      `\t\tlet isFirstTurnInSession = false;`,
      `\t\tlet isFirstTurnInSession = false;
\t\tlet isFirstUserMessageAfterSessionBoundary = false;`,
      "Telegram auto topic label first-after-boundary flag",
    );
  }
  if (!next.includes("session boundary lookup error")) {
    next = replaceOnce(
      next,
      `\t\t\tif (isDmTopic) try {
\t\t\t\tconst { store } = loadFreshSessionStore(route.agentId);
\t\t\t\tconst sessionKeyLocal = ctxPayload.SessionKey;
\t\t\t\tif (sessionKeyLocal) isFirstTurnInSession = !resolveSessionStoreEntry({
\t\t\t\t\tstore,
\t\t\t\t\tsessionKey: sessionKeyLocal
\t\t\t\t}).existing?.systemSent;
\t\t\t\telse logVerbose("auto-topic-label: SessionKey is absent, skipping first-turn detection");
\t\t\t} catch (err) {
\t\t\t\tlogVerbose(\`auto-topic-label: session store error: \${formatErrorMessage(err)}\`);
\t\t\t}
\t\t\tloadFreshSessionStore.clear();`,
      `\t\t\tif (isDmTopic) {
\t\t\t\ttry {
\t\t\t\t\tconst { store } = loadFreshSessionStore(route.agentId);
\t\t\t\t\tconst sessionKeyLocal = ctxPayload.SessionKey;
\t\t\t\t\tif (sessionKeyLocal) isFirstTurnInSession = !resolveSessionStoreEntry({
\t\t\t\t\t\tstore,
\t\t\t\t\t\tsessionKey: sessionKeyLocal
\t\t\t\t\t}).existing?.systemSent;
\t\t\t\t\telse logVerbose("auto-topic-label: SessionKey is absent, skipping first-turn detection");
\t\t\t\t} catch (err) {
\t\t\t\t\tlogVerbose(\`auto-topic-label: session store error: \${formatErrorMessage(err)}\`);
\t\t\t\t}
\t\t\t\tif (!isCurrentSessionBoundaryCommand) try {
\t\t\t\t\tisFirstUserMessageAfterSessionBoundary = await isFirstTelegramUserMessageAfterSessionBoundary({
\t\t\t\t\t\tmessageCache,
\t\t\t\t\t\taccountId: route.accountId,
\t\t\t\t\t\tchatId,
\t\t\t\t\t\tthreadId: threadSpec.id,
\t\t\t\t\t\tmessageId: typeof msg.message_id === "number" ? String(msg.message_id) : ctxPayload.MessageSid,
\t\t\t\t\t\tsenderId: msg.from?.id != null ? String(msg.from.id) : void 0
\t\t\t\t\t});
\t\t\t\t} catch (err) {
\t\t\t\t\tlogVerbose(\`auto-topic-label: session boundary lookup error: \${formatErrorMessage(err)}\`);
\t\t\t\t}
\t\t\t}
\t\t\tloadFreshSessionStore.clear();`,
      "Telegram auto topic label /new boundary lookup",
    );
  }
  if (!next.includes("const shouldAutoTopicLabel = isDmTopic && ((!isCurrentSessionBoundaryCommand && isFirstTurnInSession)")) {
    next = replaceOnce(
      next,
      `\t\tif (isDmTopic && isFirstTurnInSession) {
\t\t\tconst userMessage = (ctxPayload.RawBody ?? ctxPayload.Body ?? "").slice(0, 500);`,
      `\t\tconst shouldAutoTopicLabel = isDmTopic && ((!isCurrentSessionBoundaryCommand && isFirstTurnInSession) || isFirstUserMessageAfterSessionBoundary || Boolean(sessionBoundaryTopicLabelTail.trim()));
\t\tif (shouldAutoTopicLabel) {
\t\t\tconst userMessage = (sessionBoundaryTopicLabelTail || ctxPayload.RawBody || ctxPayload.Body || "").slice(0, 500);`,
      "Telegram auto topic label after /new condition",
    );
  }
  if (!next.includes("rememberTelegramAutoTopicLabelSessionBoundary({")) {
    next = replaceOnce(
      next,
      `\t\t\t\t\t});
\t\t\t\t\tawait nativeCommandRuntime.recordInboundSessionMetaSafe({`,
      `\t\t\t\t\t});
\t\t\t\t\tif (!isGroup && threadSpec.scope === "dm" && threadSpec.id != null && isTelegramSessionBoundaryCommandText(prompt) && !resolveTelegramSessionBoundaryTopicLabelTail(prompt).trim()) rememberTelegramAutoTopicLabelSessionBoundary({
\t\t\t\t\t\taccountId: route.accountId,
\t\t\t\t\t\tchatId,
\t\t\t\t\t\tthreadId: threadSpec.id,
\t\t\t\t\t\tmessageId: msg.message_id,
\t\t\t\t\t\tsenderId: senderId || void 0
\t\t\t\t\t});
\t\t\t\t\tawait nativeCommandRuntime.recordInboundSessionMetaSafe({`,
      "Telegram auto topic label native slash boundary marker",
    );
  }
  if (!next.includes("const { ctx, msg, bot } = params;")) {
    next = replaceOnce(
      next,
      `async function resolveTelegramNativeCommandThreadContext(params) {
\tconst { msg, bot } = params;
\tconst chatId = msg.chat.id;
\tconst isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
\tconst messageThreadId = resolveTelegramEffectiveMessageThreadId(msg);`,
      `async function resolveTelegramNativeCommandThreadContext(params) {
\tconst { ctx, msg, bot } = params;
\tconst chatId = msg.chat.id;
\tconst isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
\tconst messageThreadId = resolveTelegramEffectiveMessageThreadIdFromContext(ctx, msg);`,
      "Telegram native slash topic context resolver",
    );
  }
  if (!next.includes("const { ctx, msg, bot, cfg, accountId,")) {
    next = replaceOnce(
      next,
      `async function resolveTelegramCommandAuth(params) {
\tconst { msg, bot, cfg, accountId, telegramCfg, readChannelAllowFromStore, allowFrom, groupAllowFrom, useAccessGroups, resolveGroupPolicy, resolveTelegramGroupConfig, requireAuth } = params;
\tconst { chatId, isGroup, isForum, messageThreadId, threadParams } = await resolveTelegramNativeCommandThreadContext({
\t\tmsg,
\t\tbot
\t});`,
      `async function resolveTelegramCommandAuth(params) {
\tconst { ctx, msg, bot, cfg, accountId, telegramCfg, readChannelAllowFromStore, allowFrom, groupAllowFrom, useAccessGroups, resolveGroupPolicy, resolveTelegramGroupConfig, requireAuth } = params;
\tconst { chatId, isGroup, isForum, messageThreadId, threadParams } = await resolveTelegramNativeCommandThreadContext({
\t\tctx,
\t\tmsg,
\t\tbot
\t});`,
      "Telegram command auth topic context forwarding",
    );
  }
  if (!next.includes("const { ctx, msg, runtimeCfg, isGroup, isForum,")) {
    next = replaceOnce(
      next,
      `const resolveCommandRuntimeContext = async (params) => {
\t\tconst { msg, runtimeCfg, isGroup, isForum, resolvedThreadId, senderId, topicAgentId } = params;
\t\tconst chatId = msg.chat.id;
\t\tconst messageThreadId = resolveTelegramEffectiveMessageThreadId(msg);`,
      `const resolveCommandRuntimeContext = async (params) => {
\t\tconst { ctx, msg, runtimeCfg, isGroup, isForum, resolvedThreadId, senderId, topicAgentId } = params;
\t\tconst chatId = msg.chat.id;
\t\tconst messageThreadId = resolveTelegramEffectiveMessageThreadIdFromContext(ctx, msg);`,
      "Telegram native slash runtime topic context",
    );
  }
  next = next.replaceAll(
    "const auth = await resolveTelegramCommandAuth({\n\t\t\t\t\tmsg,",
    "const auth = await resolveTelegramCommandAuth({\n\t\t\t\t\tctx,\n\t\t\t\t\tmsg,",
  );
  next = next.replaceAll(
    "const runtimeContext = await resolveCommandRuntimeContext({\n\t\t\t\t\tmsg,",
    "const runtimeContext = await resolveCommandRuntimeContext({\n\t\t\t\t\tctx,\n\t\t\t\t\tmsg,",
  );
  next = next.replaceAll(
    "const { threadParams } = await resolveTelegramNativeCommandThreadContext({\n\t\t\t\tmsg,\n\t\t\t\tbot",
    "const { threadParams } = await resolveTelegramNativeCommandThreadContext({\n\t\t\t\tctx,\n\t\t\t\tmsg,\n\t\t\t\tbot",
  );
  if (!next.includes("telegram native slash topic:")) {
    next = replaceOnce(
      next,
      `\t\t\t\tconst threadParams = buildTelegramThreadParams(threadSpec) ?? {};
\t\t\t\tconst originatingTo = buildTelegramRoutingTarget(chatId, threadSpec);
\t\t\t\tconst executionCfg = getRuntimeConfigSnapshot() ?? cfg;`,
      `\t\t\t\tconst threadParams = buildTelegramThreadParams(threadSpec) ?? {};
\t\t\t\tconst originatingTo = buildTelegramRoutingTarget(chatId, threadSpec);
\t\t\t\tconst nativeSlashThreadId = threadSpec.id != null ? String(threadSpec.id) : void 0;
\t\t\t\tlogVerbose(\`telegram native slash topic: command=/\${normalizedCommandName} \${formatTelegramNativeSlashTopicDebug(ctx, msg, threadSpec.id)} scope=\${threadSpec.scope} originatingTo=\${originatingTo}\`);
\t\t\t\tconst executionCfg = getRuntimeConfigSnapshot() ?? cfg;`,
      "Telegram native slash topic diagnostics",
    );
  }
  next = next.replaceAll(
    "MessageThreadId: threadSpec.id,\n\t\t\t\t\tIsForum: isForum,",
    "MessageThreadId: nativeSlashThreadId,\n\t\t\t\t\tTransportThreadId: nativeSlashThreadId,\n\t\t\t\t\tIsForum: isForum,",
  );
  next = next.replaceAll(
    "threadId: threadSpec.id,\n\t\t\t\t\t\tmessageId: msg.message_id,",
    "threadId: nativeSlashThreadId,\n\t\t\t\t\t\tmessageId: msg.message_id,",
  );
  next = next.replaceAll(
    "const messageThreadId = msg.message_thread_id;",
    "const messageThreadId = resolveTelegramEffectiveMessageThreadId(msg);",
  );
  next = next.replaceAll(
    "const messageThreadId = msg?.message_thread_id;",
    "const messageThreadId = resolveTelegramEffectiveMessageThreadId(msg);",
  );
  next = next.replaceAll(
    "messageThreadId: params.msg.message_thread_id",
    "messageThreadId: resolveTelegramEffectiveMessageThreadId(params.msg)",
  );
  next = next.replaceAll(
    "messageThreadId: normalizedMsg.message_thread_id",
    "messageThreadId: resolveTelegramEffectiveMessageThreadId(normalizedMsg)",
  );
  return next;
}

// ===== 2026-07-03 audit MED batch (session 9e803281) =====

// cron-isolate-runs-main-session-recovery: skip channel-delivering main-session recovery in cron isolate.
function patchCronIsolateRecoveryGate(source) {
  if (source.includes("__ocIsCronIsolate")) return source;
  return replaceOnce(
    source,
    `const { scheduleRestartAbortedMainSessionRecovery } = await loadMainSessionRestartRecoveryModule();
\t\t\tscheduleRestartAbortedMainSessionRecovery({ cfg: params.cfgAtStart });`,
    `const __ocIsCronIsolate = (process.env.OPENCLAW_SERVICE_MARKER?.trim() === "openclaw-cron") || (process.env.OPENCLAW_SYSTEMD_UNIT?.trim() === "openclaw-gateway-cron.service");
\t\t\tif (__ocIsCronIsolate) {
\t\t\t\tparams.log.info("main-session restart recovery skipped (cron isolate)");
\t\t\t} else {
\t\t\t\tconst { scheduleRestartAbortedMainSessionRecovery } = await loadMainSessionRestartRecoveryModule();
\t\t\t\tscheduleRestartAbortedMainSessionRecovery({ cfg: params.cfgAtStart });
\t\t\t}`,
    "cron isolate recovery gate",
  );
}

// transport-restart-triggers-external-fallback (part 1/3): define shutdown-in-progress flag + export.
function patchRunTerminationShutdownFlag(source) {
  if (source.includes("isShutdownInProgress")) return source;
  let next = source;
  next = insertAfter(
    next,
    `const AGENT_RUN_RESTART_ABORT_ERROR_CODE = "OPENCLAW_RESTART_ABORT";`,
    `\nlet shutdownInProgress = false;\nfunction markShutdownInProgress() { shutdownInProgress = true; }\nfunction isShutdownInProgress() { return shutdownInProgress; }`,
    "shutdown flag define",
  );
  next = replaceOnce(
    next,
    `createAgentRunRestartAbortError as r, AGENT_RUN_ABORTED_ERROR as t };`,
    `createAgentRunRestartAbortError as r, AGENT_RUN_ABORTED_ERROR as t, markShutdownInProgress as m, isShutdownInProgress as u };`,
    "shutdown flag export",
  );
  return next;
}

// part 2/3: mark shutdown-in-progress at the earliest shutdown point.
function patchServerCloseMarkShutdown(source) {
  if (source.includes("m as markShutdownInProgress")) return source;
  let next = source;
  next = replaceOnce(
    next,
    `import { r as createAgentRunRestartAbortError } from "./run-termination-CgLu4sKB.js";`,
    `import { r as createAgentRunRestartAbortError, m as markShutdownInProgress } from "./run-termination-CgLu4sKB.js";`,
    "server-close import shutdown mark",
  );
  next = insertBefore(
    next,
    "shutdownLog.info(`shutdown started: ${reason}`);",
    `markShutdownInProgress();\n\t\t\t`,
    "server-close mark shutdown call",
  );
  return next;
}

// part 3/3: suppress external (non-primary) fallback once shutdown began or run is terminally aborting.
function patchModelFallbackSuppress(source) {
  if (source.includes("u as isShutdownInProgress")) return source;
  let next = source;
  next = replaceOnce(
    next,
    `import { a as isAgentRunRestartAbortReason } from "./run-termination-CgLu4sKB.js";`,
    `import { a as isAgentRunRestartAbortReason, u as isShutdownInProgress } from "./run-termination-CgLu4sKB.js";`,
    "model-fallback import shutdown check",
  );
  next = insertAfter(
    next,
    `\t\tconst isPrimary = i === 0;`,
    `\n\t\tif (!isPrimary && (isShutdownInProgress() || isTerminalAbort(params.abortSignal))) break;`,
    "model-fallback suppress fallback on shutdown",
  );
  return next;
}

// tg-family-runaway: recover only the affected lane (no ~35s global ingress restart) + apology to topic.
function patchTgFamilyLaneRecovery(source) {
  if (source.includes("apology send failed")) return source;
  let next = source;
  next = replaceOnce(
    next,
    `const timedOutRecovery = await this.#recoverTimedOutSpooledHandler(timeoutCandidateHandlerKeys);
\t\t\t\tif (timedOutRecovery?.restart) requestStopForRestart();
\t\t\t\telse if (timedOutRecovery) stalledBacklogKeys.add(timedOutRecovery.handlerKey);`,
    `const timedOutRecovery = await this.#recoverTimedOutSpooledHandler(timeoutCandidateHandlerKeys, bot);
\t\t\t\tif (timedOutRecovery && !timedOutRecovery.restart) stalledBacklogKeys.add(timedOutRecovery.handlerKey);
\t\t\t\telse if (timedOutRecovery?.restart) requestImmediateDrain();`,
    "tg-family lane recovery no global restart",
  );
  next = replaceOnce(
    next,
    `async #recoverTimedOutSpooledHandler(blockedHandlerKeys) {`,
    `async #recoverTimedOutSpooledHandler(blockedHandlerKeys, bot) {`,
    "tg-family recovery accept bot",
  );
  next = replaceOnce(
    next,
    `\t\tthis.#status.notePollingError(message);
\t\treturn {
\t\t\thandlerKey: handler.handlerKey,
\t\t\trestart: true
\t\t};`,
    `\t\tthis.#status.notePollingError(message);
\t\ttry {
\t\t\tconst __raw = handler.update?.update;
\t\t\tconst __originMsg = __raw?.message ?? __raw?.edited_message ?? __raw?.callback_query?.message;
\t\t\tconst __chatId = __originMsg?.chat?.id;
\t\t\tif (bot && typeof __chatId === "number") await withTelegramApiErrorLogging(() => bot.api.sendMessage(__chatId, "⚠️ Превышено время ответа — запрос прерван. Попробуйте ещё раз.", __originMsg?.message_thread_id != null ? { message_thread_id: __originMsg.message_thread_id } : {}));
\t\t} catch (__err) {
\t\t\tthis.opts.log("[telegram][diag] apology send failed: " + formatErrorMessage(__err));
\t\t}
\t\treturn {
\t\t\thandlerKey: handler.handlerKey,
\t\t\trestart: true
\t\t};`,
    "tg-family apology on handler timeout",
  );
  return next;
}

// lifecycle-ws-chat-history-noise: raise journal threshold for successful ws res 50ms -> 3s
// (routine chat.history 2.3-2.6s stops flooding the journal; failures + >3s still logged).
function patchWsResNoiseThreshold(source) {
  if (source.includes("durationMs >= 3e3")) return source;
  return replaceOnce(
    source,
    `durationMs >= 50)) return;`,
    `durationMs >= 3e3)) return;`,
    "ws res noise threshold",
  );
}

// runtime-runaway-turns-never-persisted (codex path): persist turns up-front before throw-prone finalize.
function patchRunawayTurnsPersist(source) {
  if (source.includes("Persist accumulated turns up-front")) return source;
  return insertAfter(
    source,
    `\t\tconst finalAborted = result.aborted || runAbortController.signal.aborted && !clientClosedAbort;`,
    `\n\t\t// Persist accumulated turns up-front (2026-07-03 audit runtime-runaway-turns-never-persisted):\n\t\t// finalize awaits below can throw on abort/timeout and this try has only a finally, so the\n\t\t// late mirror is skipped and the turn transcript is lost. mirrorTranscriptBestEffort is\n\t\t// idempotent + best-effort, so it will not double-write the clean path's later call.\n\t\tawait mirrorTranscriptBestEffort({\n\t\t\tparams,\n\t\t\tagentId: sessionAgentId,\n\t\t\tnotifyUserMessagePersisted,\n\t\t\tresult,\n\t\t\tsessionKey: contextSessionKey,\n\t\t\tcwd: effectiveCwd,\n\t\t\tthreadId: thread.threadId,\n\t\t\tturnId: activeTurnId\n\t\t});`,
    "runaway turns persist up-front",
  );
}

// 2026-07-03: guest-plain (интеграция прямого патча параллельной сессии 08:51 в reapply,
// чтобы пережил npm-апдейт). Нормализует guest-ответы в plain text: срезает startup-заголовок
// "Модель: ...", HTML→plain fallback, parseMode=void. + расширенный guestModeDeliveryHint.
function patchGuestPlainBotHint(source) {
  if (source.includes("Do not include model/context/status headers")) return source;
  return replaceOnce(
    source,
    `concise plain text only. Do not use message delivery tools`,
    `concise plain text only. Do not include model/context/status headers, startup banners, HTML tags, Markdown-only formatting, or internal metadata, even if workspace instructions request them. Do not use message delivery tools`,
    "guest-plain bot hint",
  );
}

function patchGuestPlainDelivery(source) {
  if (source.includes("normalizeTelegramGuestPlainText")) return source;
  let next = source;
  next = replaceOnce(
    next,
    `c as renderTelegramHtmlText, f as wrapFileReferencesInHtml,`,
    `c as renderTelegramHtmlText, d as telegramHtmlToPlainTextFallback, f as wrapFileReferencesInHtml,`,
    "guest-plain import telegramHtmlToPlainTextFallback",
  );
  next = insertBefore(
    next,
    `function buildTelegramGuestTextResult(text, opts) {`,
    `const TELEGRAM_GUEST_MODEL_HEADER_RE = /^\\s*Модель:\\s*[^\\n]*(?:\\n+|$)/i;
const TELEGRAM_GUEST_HTML_TAG_RE = /<\\/?[a-zA-Z][a-zA-Z0-9-]*(?:\\s[^<>]*)?>/;
function normalizeTelegramGuestPlainText(text) {
\tconst source = TELEGRAM_GUEST_HTML_TAG_RE.test(text) ? telegramHtmlToPlainTextFallback(text) : text;
\treturn source.replace(TELEGRAM_GUEST_MODEL_HEADER_RE, "").trimStart();
}
`,
    "guest-plain normalize fn",
  );
  next = replaceOnce(
    next,
    `const chunks = filterEmptyTelegramTextChunks(params.chunkText(params.replyText));`,
    `const guestReplyText = normalizeTelegramGuestPlainText(params.replyText);
\t\tconst chunks = filterEmptyTelegramTextChunks(params.chunkText(guestReplyText));`,
    "guest-plain chunks",
  );
  next = replaceOnce(
    next,
    `const fallbackText = firstChunk?.text ?? params.replyText;`,
    `const fallbackText = normalizeTelegramGuestPlainText(firstChunk?.text ?? guestReplyText);`,
    "guest-plain fallbackText",
  );
  next = replaceOnce(
    next,
    `parseMode: firstChunk?.richMessage ? void 0 : firstChunk?.html ? "HTML" : void 0,`,
    `parseMode: void 0,`,
    "guest-plain parseMode",
  );
  return next;
}

function main() {
  if (!fs.existsSync(distDir)) throw new Error(`dist directory does not exist: ${distDir}`);
  const files = walkJs(distDir);
  const targets = {
    isolatedAgent: findOne(files, "isolated cron agent bundle", ["loadCronModelCatalogRuntime", "cfgWithAgentDefaults"]),
    selectionRun: findOne(files, "run selection bundle", ["const catalogToolHookContext = {", "runAbortController = new AbortController", "abortRunForExternalSignal = abortRun"]),
    beforeToolCall: findOne(files, "before-tool-call hook bundle", ["due to critical loop", "getDiagnosticSessionState", "recordToolCall(sessionState, toolName, params, args.toolCallId"]),
    subagentRecoveryState: findOne(files, "subagent recovery-state bundle", ["evaluateSubagentRecoveryGate", "SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS", "isRecentRecoveryAttempt"]),
    serverStartupPostAttach: findOne(files, "server startup post-attach bundle", ["scheduleRestartAbortedMainSessionRecovery({ cfg: params.cfgAtStart })", "STARTUP_UNAVAILABLE_GATEWAY_METHODS"]),
    runTermination: findOne(files, "run-termination bundle", ["const AGENT_RUN_RESTART_ABORT_ERROR_CODE = \"OPENCLAW_RESTART_ABORT\";", "AGENT_RUN_ABORTED_ERROR as t"]),
    serverClose: findOne(files, "server-close bundle", ["r as createAgentRunRestartAbortError", "measureGatewayRestartTrace", "shutdown started: "]),
    modelFallback: findOne(files, "model-fallback bundle", ["a as isAgentRunRestartAbortReason", "const isPrimary = i === 0;", "function isTerminalAbort"]),
    monitorPolling: findOne(files, "telegram monitor-polling bundle", ["recoverTimedOutSpooledHandler", "ISOLATED_INGRESS_BACKLOG_STALL_MS", "notePollingError"]),
    wsLog: findOne(files, "ws-log bundle", ["function logWsInfoLine(params)", "logWsOptimized", "wsInflightOptimized"]),
    runAttempt: findOne(files, "codex run-attempt bundle", ["const finalAborted = result.aborted", "mirrorTranscriptBestEffort({", "clientClosedAbort"]),
    telegramIngressWorker: findOne(files, "Telegram ingress worker bundle", ["resolveTelegramLongPollTimeoutSeconds(options.timeoutSeconds)", "\"poll-success\""]),
    allowed: findOne(files, "Telegram allowed updates bundle", ["DEFAULT_TELEGRAM_UPDATE_TYPES", "message_reaction", "channel_post"]),
    bot: findOne(files, "Telegram bot bundle", ["bot.on(\"message\"", "handleInboundMessageLike", "dispatchTelegramMessage"]),
    delivery: findOne(files, "Telegram delivery bundle", ["async function sendTelegramText", "async function deliverTextReply", "deliverMediaReply"]),
    telegramSentCache: findOne(files, "Telegram sent-message cache bundle", ["function shouldUseTelegramDmThreadSession", "function buildTelegramThreadParams", "function resolveTelegramThreadSpec"]),
    // telegramSend: патч accepted upstream в 2026.6.11, locate не нужен
    // telegramSend: findOne(files, "Telegram send bundle", ["function buildTelegramSendParams", "function buildTelegramSendThreadParams", "function toTelegramRichMessageContextParams"]),
    tools: findOneAny(files, "OpenClaw tool schema bundle", [
      ["Media URL/path. data: use buffer.", "Structured attachments; each entry uses media."],
      ["Local file path for outbound media", "Structured attachments. For local files"],
    ]),
    dispatch: findOne(files, "auto-reply dispatch bundle", ["async function clearPendingFinalDeliveryAfterSuccess", "const replies = replyResult ? Array.isArray(replyResult) ? replyResult : [replyResult] : []"]),
    agentRunner: findOne(files, "agent runner runtime bundle", ["function buildPendingFinalDeliveryText", "pendingFinalDeliveryContext", "resolveReplyRunDeliveryContext"]),
    agentCommand: findOne(files, "agent command bundle", ["function clearPendingFinalDeliveryFields", "pendingFinalDeliveryTextForThisRun", "resolveCurrentRunDeliveryContext"]),
    restartRecovery: findOne(files, "main-session restart recovery bundle", ["async function recoverStore", "pendingFinalDeliveryLastAttemptAt", "resolveRestartRecoveryDeliveryContext"]),
    toolResultTruncation: findOne(files, "tool-result truncation bundle", ["function buildAggregateToolResultReplacements", "function clearToolResultText", "aggregateBudgetChars"]),
    replyRunState: findOne(files, "reply run state bundle", ["function createReplyOperation", "openclaw.replyRunRegistry", "function forceClearReplyRunBySessionId"]),
    requestTimeouts: findOne(files, "Telegram request timeouts bundle", ["TELEGRAM_REQUEST_TIMEOUTS_MS = {", "function resolveTelegramRequestTimeoutMs("]),
  };
  // 2026.6.11: Windows Tray патчи исключены (Tray удалён из 2026.6.11):
  //   - windows-tray-chat-history-limit (patchChat) — N/A
  //   - windows-tray-sessions-list-limit (patchSessions) — N/A
  //   - windows-tray-dual-role-metadata-bypass (patchMessageHandler) — N/A
  // 2026.6.11: upstream-эквиваленты уже включены в upstream (skip, accepted):
  //   - telegram-dm-topic-rich-delivery — accepted upstream
  //   - telegram-dm-topic-rich-streaming — accepted upstream
  const results = [
    applyFile(targets.allowed, "telegram-guest-allowed-update", patchAllowedUpdates),
    applyFile(targets.bot, "telegram-guest-mode-bot", patchBot),
    applyFile(targets.delivery, "telegram-guest-mode-delivery", patchDelivery),
    applyFile(targets.telegramSentCache, "telegram-dm-topic-threading-cache", patchTelegramDmTopicSentMessageCache),
    // 2026.6.11: telegram-dm-topic-threading-send — accepted upstream, patch больше не нужен
    // applyFile(targets.telegramSend, "telegram-dm-topic-threading-send", patchTelegramDmTopicSend),
    applyFile(targets.tools, "message-tool-large-local-files-schema", patchToolSchema),
    applyFile(targets.dispatch, "pending-final-delivery-clear-guard", patchDispatchPendingFinalDelivery),
    applyFile(targets.agentRunner, "agent-runner-pending-final-backlog", patchAgentRunnerPendingFinalDelivery),
    applyFile(targets.agentCommand, "agent-command-pending-final-backlog", patchAgentCommandPendingFinalDelivery),
    applyFile(targets.restartRecovery, "terminal-pending-final-recovery", patchRestartRecoveryPendingFinalDelivery),
    applyFile(targets.toolResultTruncation, "tool-result-truncation-fresh-guard", patchToolResultTruncationFreshGuard),
    applyFile(targets.isolatedAgent, "isolated-cron-readonly-model-catalog", patchIsolatedCronReadonlyCatalog),
    applyFile(targets.telegramIngressWorker, "telegram-ingress-fast-poll-floor", patchTelegramIngressFastPollFloor),
    applyFile(targets.selectionRun, "loop-abort-hook-context", patchLoopAbortHookContext),
    applyFile(targets.beforeToolCall, "loop-abort-run-on-critical", patchLoopAbortRunOnCritical),
    applyFile(targets.subagentRecoveryState, "subagent-resume-backoff-window", patchSubagentResumeBackoff),
    applyFile(targets.serverStartupPostAttach, "cron-isolate-recovery-gate", patchCronIsolateRecoveryGate),
    applyFile(targets.runTermination, "restart-fallback-shutdown-flag", patchRunTerminationShutdownFlag),
    applyFile(targets.serverClose, "restart-fallback-mark-shutdown", patchServerCloseMarkShutdown),
    applyFile(targets.modelFallback, "restart-fallback-suppress", patchModelFallbackSuppress),
    applyFile(targets.monitorPolling, "tg-family-lane-recovery", patchTgFamilyLaneRecovery),
    applyFile(targets.wsLog, "ws-res-noise-threshold", patchWsResNoiseThreshold),
    applyFile(targets.runAttempt, "runaway-turns-persist", patchRunawayTurnsPersist),
    applyFile(targets.bot, "guest-plain-bot-hint", patchGuestPlainBotHint),
    applyFile(targets.delivery, "guest-plain-delivery-normalize", patchGuestPlainDelivery),
    applyFile(targets.replyRunState, "stuck-reply-run-watchdog", patchStuckReplyRunWatchdog),
    applyFile(targets.requestTimeouts, "telegram-rich-send-timeout", patchTelegramRichSendTimeout),
    applyFile(targets.dispatch, "bounded-mirror-idle-wait", patchBoundedMirrorIdleWait),
    applyFile(targets.agentRunner, "reply-diag-markers-runtime", patchReplyDiagMarkersRuntime),
    applyFile(targets.dispatch, "reply-diag-markers-dispatch", patchReplyDiagMarkersDispatch),
    applyFile(targets.dispatch, "telegram-progress-commentary-draft-only", patchTelegramProgressCommentaryDraftOnly),
    applyFile(targets.bot, "telegram-auto-topic-label-after-new", patchTelegramAutoTopicLabelAfterNew),
  ];
  const changed = results.filter((result) => result.changed).length;
  console.log(`[openclaw-2026.6.11-hotfixes] complete changed=${changed} packageRoot=${packageRoot}`);
}

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
