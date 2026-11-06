// OpenClaw 2026.11.1: telegram-dm-topic-adopt-created.
import { replaceOnce, insertBefore, contains, notContains } from "../helpers.mjs";
export const label = "telegram-dm-topic-adopt-created";
export const verdict = "port";
export const target = { key: "helpers", label: "Telegram helpers bundle (resolveTelegramMessageThreadSpec)", needles: ["function resolveTelegramMessageThreadSpec(message, isForum) {", "function shouldUseTelegramDmThreadSession(params) {", "function buildTelegramThreadParams(thread) {"] };
const MARKER = "hotfix: telegram-dm-topic-adopt-created";
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
export function patch(source) {
  if (source.includes(MARKER)) return source;
  let next = source;
  next = insertBefore(next, "function resolveTelegramMessageThreadSpec(message, isForum) {", REGION, label + " region");
  next = replaceOnce(next, FN_HEAD, FN_HEAD_PATCHED, label + " resolver head");
  return next;
}
export const check = { gate: "required", assertions: [
  contains(MARKER, "dm-topic-adopt marker"),
  contains("function resolveHotfixDmTopicAdoptThreadId(message) {", "adopt resolver helper"),
  contains("function getHotfixDmTopicAdoptState() {", "adopt state singleton"),
  contains("const hotfixAdoptedDmThreadId = resolveHotfixDmTopicAdoptThreadId(message);", "resolver consults adoption first"),
  contains("[hotfix][dm-topic-adopt] adopted chat=", "visible adoption log"),
  contains("function resolveTelegramMessageThreadSpec(message, isForum) {", "upstream resolver still present"),
  contains("parseStrictPositiveInteger(message.direct_messages_topic?.topic_id)", "parseStrictPositiveInteger in scope of the resolver (import from number-coercion chunk)"),
  notContains(FN_HEAD, "vanilla resolver head must be replaced"),
] };
