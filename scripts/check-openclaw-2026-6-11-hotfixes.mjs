#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/usr/lib/node_modules/openclaw";
const distDir = path.join(packageRoot, "dist");
const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const reapplyScriptPath = process.env.OPENCLAW_REAPPLY_SCRIPT || path.join(scriptDir, "apply-openclaw-2026-6-11-hotfixes.mjs");
const expectedCurrentVersion = "2026.6.11";
const legacyBaselineVersion = "2026.6.5";
const strictReview = process.argv.includes("--strict") || process.argv.includes("--strict-review");

function rel(file) {
  return path.relative("/", file);
}

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

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function findOneJs(files, label, needles) {
  const matches = [];
  for (const file of files) {
    const content = readText(file);
    if (needles.every((needle) => content.includes(needle))) matches.push({ file, content });
  }
  if (matches.length === 0) throw new Error(`could not locate ${label}`);
  if (matches.length > 1) {
    throw new Error(`located multiple ${label}: ${matches.map((match) => rel(match.file)).join(", ")}`);
  }
  return matches[0];
}

function contains(needle, detail = needle) {
  return (content) => content.includes(needle) ? null : `missing ${detail}`;
}

function countAtLeast(needle, min, detail = needle) {
  return (content) => {
    const count = countOccurrences(content, needle);
    return count >= min ? null : `expected at least ${min} occurrences of ${detail}, found ${count}`;
  };
}

function notContains(needle, detail = needle) {
  return (content) => content.includes(needle) ? `unexpected ${detail}` : null;
}

function locateFile(file) {
  if (!fs.existsSync(file)) throw new Error(`file does not exist: ${file}`);
  return { file, content: readText(file) };
}

function runCheck(files, check) {
  try {
    const target = check.locate(files);
    const failures = check.assertions.map((assertion) => assertion(target.content, target.file)).filter(Boolean);
    if (failures.length > 0) return { ...check, ok: false, file: target.file, failures };
    return { ...check, ok: true, file: target.file, failures: [] };
  } catch (err) {
    return {
      ...check,
      ok: false,
      file: null,
      failures: [err instanceof Error ? err.message : String(err)],
    };
  }
}

const checks = [
  {
    id: "reapply-script-2026-6-11-canonical",
    gate: "required",
    locate: () => locateFile(reapplyScriptPath),
    assertions: [
      contains("telegram-guest-allowed-update", "Telegram guest allowed-update patch"),
      contains("telegram-guest-mode-bot", "Telegram guest bot patch"),
      contains("telegram-guest-mode-delivery", "Telegram guest delivery patch"),
      contains("telegram-dm-topic-threading-cache", "Telegram DM topic cache patch"),
      contains("telegram-dm-topic-threading-send", "Telegram DM topic send patch"),
      contains("message-tool-large-local-files-schema", "message tool large local files patch"),
      contains("pending-final-delivery-clear-guard", "pending final delivery clear guard patch"),
      contains("agent-runner-pending-final-backlog", "agent runner pending final backlog patch"),
      contains("agent-command-pending-final-backlog", "agent command pending final backlog patch"),
      contains("terminal-pending-final-recovery", "terminal pending final recovery patch"),
      contains("tool-result-truncation-fresh-guard", "tool result truncation fresh guard patch"),
      contains("stuck-reply-run-watchdog", "stuck reply run watchdog patch"),
      contains("telegram-rich-send-timeout", "telegram rich send timeout patch"),
      contains("bounded-mirror-idle-wait", "bounded mirror idle wait patch"),
      contains("reply-diag-markers-runtime", "reply diag markers runtime patch"),
      contains("reply-diag-markers-dispatch", "reply diag markers dispatch patch"),
      contains("telegram-progress-commentary-draft-only", "Telegram progress commentary draft-only patch"),
      contains("telegram-auto-topic-label-after-new", "Telegram auto-topic label after /new patch"),
    ],
  },
  {
    id: "telegram-rich-send-timeout",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram request timeouts bundle", [
      "TELEGRAM_REQUEST_TIMEOUTS_MS = {",
      "function resolveTelegramRequestTimeoutMs(",
    ]),
    assertions: [
      contains("sendrichmessage: TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS", "sendrichmessage timeout entry"),
    ],
  },
  {
    id: "bounded-mirror-idle-wait",
    gate: "required",
    locate: (files) => findOneJs(files, "auto-reply dispatch bundle", [
      "async function clearPendingFinalDeliveryAfterSuccess",
      "const replies = replyResult ? Array.isArray(replyResult) ? replyResult : [replyResult] : []",
    ]),
    assertions: [
      contains("hotfix: bounded-mirror-idle-wait", "bounded mirror region marker"),
      contains("HOTFIX_MIRROR_IDLE_TIMEOUT_MS", "mirror idle timeout constant"),
      notContains("mirrorTranscriptAfterDispatcherDelivery(params) {\n\tawait params.dispatcher.waitForIdle();", "unbounded mirror idle wait"),
    ],
  },
  {
    id: "reply-diag-markers-runtime",
    gate: "required",
    locate: (files) => findOneJs(files, "agent runner runtime bundle", [
      "function buildPendingFinalDeliveryText",
      "resolveReplyRunDeliveryContext",
      "pendingFinalDeliveryContext",
    ]),
    assertions: [
      contains("[hotfix][reply-diag] post-run flush start", "post-run flush marker"),
      contains("[hotfix][reply-diag] post-run buildReplyPayloads start", "post-run buildReplyPayloads marker"),
      contains("[hotfix][reply-diag] post-run persisting pendingFinalDelivery", "post-run pendingFinalDelivery marker"),
    ],
  },
  {
    id: "reply-diag-markers-dispatch",
    gate: "required",
    locate: (files) => findOneJs(files, "auto-reply dispatch bundle", [
      "async function clearPendingFinalDeliveryAfterSuccess",
      "const replies = replyResult ? Array.isArray(replyResult) ? replyResult : [replyResult] : []",
    ]),
    assertions: [
      contains("[hotfix][reply-diag] final payload dispatch start", "final payload dispatch marker"),
      contains("[hotfix][reply-diag] dispatch reply operation complete", "dispatch complete marker"),
    ],
  },
  {
    id: "telegram-progress-commentary-draft-only",
    gate: "required",
    locate: (files) => findOneJs(files, "auto-reply dispatch bundle", [
      "const deliverStandaloneCommentaryProgress",
      "const canForwardItemEvents",
      "commentaryProgressEnabled",
    ]),
    assertions: [
      contains("hotfix: telegram-progress-commentary-draft-only", "Telegram progress commentary draft-only marker"),
      contains("channelDraftCommentaryProgressEnabled", "draft commentary guard"),
      contains("const deliverStandaloneCommentaryProgress = shouldEmitVerboseProgress() && !channelDraftCommentaryProgressEnabled;", "standalone commentary suppression"),
    ],
  },
  {
    id: "stuck-reply-run-watchdog",
    gate: "required",
    locate: (files) => findOneJs(files, "reply run state bundle", [
      "function createReplyOperation",
      "openclaw.replyRunRegistry",
      "function forceClearReplyRunBySessionId",
    ]),
    assertions: [
      contains("hotfix: stuck-reply-run-watchdog", "watchdog region marker"),
      contains("function scanForStuckReplyRuns()", "watchdog scan function"),
      contains("STUCK_REPLY_RUN_GRACE_MS", "watchdog grace constant"),
      contains("stuckReplyRunWatchdogTimer.unref?.()", "watchdog unref timer"),
    ],
  },
  {
    id: "tool-result-truncation-fresh-guard",
    gate: "required",
    locate: (files) => findOneJs(files, "tool-result truncation bundle", [
      "function buildAggregateToolResultReplacements",
      "function clearToolResultText",
      "aggregateBudgetChars",
    ]),
    assertions: [
      contains("protectedEntryIds", "trailing tool-result protection set"),
      countAtLeast("!protectedEntryIds.has(", 2, "protected-entry filters in aggregate passes"),
      contains("[tool result elided: aggregate tool-result budget exceeded", "non-empty clear placeholder"),
      notContains('content.map((block) => block && typeof block === "object" && block.type === "text" ? Object.assign({}, block, { text: "" }) : block)', "empty-string tool-result clearing"),
    ],
  },
  {
    id: "telegram-guest-allowed-update",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram allowed updates bundle", [
      "resolveTelegramAllowedUpdates",
      "message_reaction",
      "channel_post",
    ]),
    assertions: [
      contains('updates.includes("guest_message")', "guest_message allowed update"),
    ],
  },
  {
    id: "telegram-guest-mode-bot",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram bot bundle", [
      "handleInboundMessageLike",
      "buildChannelInboundEventContext",
      "sendTyping",
    ]),
    assertions: [
      contains('bot.on("guest_message"', "guest_message handler"),
      contains("resolveTelegramGuestSessionKey", "guest session key helper"),
      contains("const isGuest = Boolean(guestQueryId);", "guest mode flag"),
      contains('GuestMode: msg.guest_query_id ? true : void 0', "GuestMode context flag"),
      contains("GuestQueryId", "GuestQueryId context field"),
      contains("if (isGuest) return;", "guest typing/voice cue suppression"),
      contains("guestModeDeliveryHint", "guest delivery hint"),
    ],
  },
  {
    id: "telegram-guest-mode-delivery",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram delivery bundle", [
      "deliverTextReply",
      "sendChunkedTelegramReplyText",
      "formatErrorMessage",
    ]),
    assertions: [
      contains("answerGuestQuery", "answerGuestQuery API path"),
      contains("answerTelegramGuestQueryViaOfficialApi", "official API fallback"),
      contains("sendTelegramGuestText", "guest text sender"),
      contains("params.progress.guestAnswered", "guest duplicate-send guard"),
      contains("guestQueryId", "guest query id delivery option"),
    ],
  },
  {
    id: "telegram-auto-topic-label-after-new",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram bot bundle", [
      "generateTelegramTopicLabel",
      "isTelegramSessionBoundaryCommandText",
      "editForumTopic",
    ]),
    assertions: [
      contains("hotfix: telegram-auto-topic-label-after-new", "auto-topic /new hotfix marker"),
      contains("resolveTelegramSessionBoundaryTopicLabelTail", "session-boundary tail parser"),
      contains("isFirstTelegramUserMessageAfterSessionBoundary", "first user message after /new detector"),
      contains("rememberTelegramAutoTopicLabelSessionBoundary", "native slash /new boundary marker"),
      contains("consumeTelegramAutoTopicLabelSessionBoundary", "native slash /new boundary fallback"),
      contains("resolveTelegramDirectMessagesTopicId", "DM direct_messages_topic fallback helper"),
      contains("resolveTelegramEffectiveMessageThreadId(msg)", "effective Telegram message thread helper use"),
      contains("resolveTelegramEffectiveMessageThreadIdFromContext(ctx, msg)", "native slash raw-update topic resolver"),
      contains("iterateTelegramTopicSourceMessages", "native slash raw-update source iterator"),
      contains("ctx?.update?.message", "native slash raw update message lookup"),
      contains("direct_messages_topic?.topic_id", "Bot API direct_messages_topic topic id support"),
      contains("telegram native slash topic:", "native slash topic diagnostic log"),
      contains("MessageThreadId: nativeSlashThreadId", "native slash thread id in inbound context"),
      contains("TransportThreadId: nativeSlashThreadId", "native slash delivery thread id in inbound context"),
      contains("threadId: nativeSlashThreadId", "native slash auto-label boundary thread id"),
      contains("let isFirstUserMessageAfterSessionBoundary = false;", "first-after-boundary flag"),
      contains("session boundary lookup error", "session-boundary lookup error log"),
      contains("const shouldAutoTopicLabel = isDmTopic && ((!isCurrentSessionBoundaryCommand && isFirstTurnInSession) || isFirstUserMessageAfterSessionBoundary || Boolean(sessionBoundaryTopicLabelTail.trim()));", "expanded auto-topic condition"),
      contains("sessionBoundaryTopicLabelTail || ctxPayload.RawBody || ctxPayload.Body || \"\"", "topic label source tail fallback"),
    ],
  },
  {
    id: "telegram-dm-topic-rich-delivery",
    // 2026.6.11: accepted upstream — patch больше не нужен
    gate: "review",
    locate: (files) => findOneJs(files, "Telegram delivery bundle", [
      "async function sendTelegramText",
      "sendRichMessage",
      "sendMessage",
    ]),
    assertions: [
      contains("if (opts?.richMessages === true)", "rich delivery enabled for all Telegram threads"),
      notContains("shouldUseTelegramRichMessagesForText", "private topic rich bypass"),
      notContains("isTelegramPrivateTopicDelivery", "private topic plain fallback"),
    ],
  },
  {
    id: "telegram-dm-topic-rich-streaming",
    // 2026.6.11: accepted upstream — patch больше не нужен
    gate: "review",
    locate: (files) => findOneJs(files, "Telegram bot bundle", [
      "createTelegramDraftStream",
      "renderStreamText",
    ]),
    assertions: [
      contains("telegramCfg.richMessages === true ? TELEGRAM_RICH_TEXT_LIMIT : TELEGRAM_TEXT_CHUNK_LIMIT", "rich draft chunk limit"),
      contains("supportsBlockTables: telegramCfg.richMessages === true", "rich table mode"),
      contains("const renderStreamText = (text) => telegramCfg.richMessages === true ? {", "rich draft renderer"),
      contains("richMessages: telegramCfg.richMessages", "rich draft stream enabled"),
      notContains("telegramRichMessagesForThread", "private topic streaming rich bypass"),
    ],
  },
  {
    id: "telegram-dm-topic-threading-cache",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram sent-message cache bundle", [
      "function shouldUseTelegramDmThreadSession",
      "function resolveTelegramThreadSpec",
      "function buildTelegramThreadParams",
    ]),
    assertions: [
      // 2026.6.11: shouldUseTelegramDmThreadSession уже исправлено upstream — assertion не нужен
      contains("params.directMessagesTopicId ?? params.messageThreadId", "direct topic id preference"),
      // 2026.6.11: buildTelegramThreadParams dm scope уже использует message_thread_id upstream
      // contains("{ message_thread_id: normalized }", "private topic delivery param"),
      // 2026.6.11: buildTelegramRoutingTarget уже исправлено upstream — assertion не нужен
      // contains("threadParams?.message_thread_id ?? threadParams?.direct_messages_topic_id", "routing target accepts direct topic ids"),
    ],
  },
  {
    id: "telegram-dm-topic-threading-send",
    // 2026.6.11: accepted upstream — patch больше не нужен.
    // 2026-07-01: ассерты переписаны на живые upstream-маркеры (buildTelegramThreadParams
    // шлёт message_thread_id; resolveForumLaneKey обрабатывает direct_messages_topic_id),
    // чтобы пункт не краснел от устаревшей сигнатуры и сторожил регресс при апгрейде.
    gate: "review",
    locate: (files) => findOneJs(files, "Telegram send bundle", [
      "function buildTelegramSendParams",
      "function buildTelegramThreadReplyParams",
      "function toTelegramRichMessageContextParams",
    ]),
    assertions: [
      contains("buildTelegramThreadParams", "upstream thread params builder"),
      contains("resolveForumLaneKey", "upstream forum lane resolver"),
      contains("direct_messages_topic_id", "upstream direct-topic id handling"),
    ],
  },
  {
    id: "message-tool-large-local-files-schema",
    gate: "required",
    locate: (files) => findOneJs(files, "OpenClaw tools schema bundle", [
      "Structured attachments",
      "media-reference",
      "filePath",
    ]),
    assertions: [
      contains("Local file path for outbound media", "local outbound file path hint"),
      contains("filePath/path", "filePath/path guidance"),
      contains("gateway does not inline bytes into the WebSocket payload", "WebSocket payload avoidance hint"),
    ],
  },
  {
    id: "pending-final-delivery-clear-guard",
    gate: "required",
    locate: (files) => findOneJs(files, "auto-reply dispatch bundle", [
      "async function clearPendingFinalDeliveryAfterSuccess",
      "const replies = replyResult ? Array.isArray(replyResult) ? replyResult : [replyResult] : []",
    ]),
    assertions: [
      contains("buildDispatchPendingFinalDeliveryText", "dispatch pending-final text builder"),
      contains("expectedPendingFinalDeliveryText: buildDispatchPendingFinalDeliveryText(replies)", "expected payload clear guard"),
      contains("not cleared: delivered payload did not match stored pending final delivery", "mismatch preserve guard"),
      contains("promoteNextPendingFinalDeliveryOrClear", "pending backlog promotion on clear"),
    ],
  },
  {
    id: "agent-runner-pending-final-backlog",
    gate: "required",
    locate: (files) => findOneJs(files, "agent runner runtime bundle", [
      "function buildPendingFinalDeliveryText",
      "resolveReplyRunDeliveryContext",
      "pendingFinalDeliveryContext",
    ]),
    assertions: [
      contains("function appendPendingFinalDeliveryBacklog", "agent runner pending backlog helper"),
      contains("const pendingFinalDeliveryIntentId = crypto.randomUUID();", "agent runner pending intent id"),
      contains("pendingFinalDeliveryBacklog: backlog.slice(-20)", "agent runner pending backlog cap"),
    ],
  },
  {
    id: "agent-command-pending-final-backlog",
    gate: "required",
    locate: (files) => findOneJs(files, "agent command bundle", [
      "function clearPendingFinalDeliveryFields",
      "pendingFinalDeliveryTextForThisRun",
      "resolveCurrentRunDeliveryContext",
    ]),
    assertions: [
      contains("function appendPendingFinalDeliveryBacklog", "agent command pending backlog helper"),
      contains("pendingFinalDeliveryIntentId: runId", "agent command pending intent id"),
      contains("pendingFinalDeliveryBacklog: backlog.slice(-20)", "agent command pending backlog cap"),
    ],
  },
  {
    id: "terminal-pending-final-recovery",
    gate: "required",
    locate: (files) => findOneJs(files, "main-session restart recovery bundle", [
      "async function recoverStore",
      "resolveRestartRecoveryDeliveryContext",
      "pendingFinalDeliveryLastAttemptAt",
    ]),
    assertions: [
      contains("async function recoverTerminalPendingFinalDelivery", "terminal pending final drainer"),
      contains("isRecoverableTerminalPendingFinalDelivery(entry)", "terminal pending scan"),
      contains("buildPendingFinalDeliveryRecoveryIdempotencyKey", "terminal pending idempotency key"),
      contains("parseTelegramRecoveryThreadId", "Telegram thread id normalization for recovery"),
      contains("main-session-pending-final", "terminal pending idempotency prefix"),
    ],
  },
  {
    id: "gateway-main-tailnet-url-dropin",
    gate: "required",
    locate: () => locateFile("/etc/systemd/system/openclaw-gateway.service.d/60-gateway-url.conf"),
    assertions: [
      contains("[Service]", "systemd Service section"),
      contains("Environment=OPENCLAW_GATEWAY_URL=ws://100.100.40.51:18789", "main gateway tailnet URL override"),
    ],
  },
  {
    id: "gateway-shared-env-no-url-override",
    gate: "required",
    locate: () => locateFile("/root/.openclaw/service-env/openclaw-gateway.env"),
    assertions: [
      notContains("OPENCLAW_GATEWAY_URL", "shared OPENCLAW_GATEWAY_URL override inherited by cron isolate"),
    ],
  },
  {
    id: "status-summary-no-manifest-normalization",
    gate: "review",
    locate: (files) => findOneJs(files, "status summary runtime bundle", [
      "src/commands/status.summary.runtime.ts",
      "resolveStatusModelRefFromRaw",
    ]),
    assertions: [
      countAtLeast("allowManifestNormalization: false", 3, "status manifest-normalization bypasses"),
    ],
  },
  {
    id: "model-selection-propagates-manifest-normalization-flag",
    gate: "review",
    locate: (files) => findOneJs(files, "model-selection runtime bundle", [
      "src/agents/model-selection.ts",
      "resolvePersistedSelectedModelRef",
    ]),
    assertions: [
      countAtLeast(
        "allowManifestNormalization: params.allowManifestNormalization",
        5,
        "propagated allowManifestNormalization flag",
      ),
    ],
  },
  {
    id: "agent-runtime-label-cli-provider-cache",
    gate: "review",
    locate: (files) => findOneJs(files, "agent runtime label bundle", [
      "src/status/agent-runtime-label.ts",
      "resolveAgentRuntimeLabel",
    ]),
    assertions: [
      contains("const cliProviderCache", "CLI provider WeakMap cache"),
      contains("function resolveIsCliProvider", "cached CLI provider resolver"),
    ],
  },
  {
    // 2026-07-01: STILL-BROKEN в 2026.6.11 (цикл getUpdates без пола на мгновенные пустые ответы →
    // CPU-спин, инцидент cpu-max 2026-05-22). Адаптирован в apply-openclaw-2026-6-11-hotfixes.mjs,
    // гейт повышен до required.
    id: "telegram-ingress-fast-poll-floor",
    gate: "required",
    locate: (files) => findOneJs(files, "Telegram ingress worker bundle", [
      "extensions/telegram/src/telegram-ingress-worker.runtime.ts",
      "resolveTelegramLongPollTimeoutSeconds",
    ]),
    assertions: [
      contains("const emptyPollFastLoopFloorMs = 1e3", "1s empty-poll floor"),
      contains("const requestStartedAt = Date.now()", "poll elapsed timer"),
      contains("if (elapsedMs < emptyPollFastLoopFloorMs) await sleep", "fast-poll sleep"),
    ],
  },
  {
    // 2026-07-01 review-решение: UPSTREAM-EQUIVALENT. Старый guard (shouldSkipCronNestedLaneSuspension)
    // заменён upstream-механикой: классификация setup/stall-таймаутов в isolated-agent/server-cron
    // (isSetupTimeoutErrorText → requestSafeGatewayRestart, guard !observedLaneWait) + model-fallback
    // отбрасывает суспензию на abort/coordination/timeout и подвешивает только при исчерпании кандидатов.
    // Ассерты ниже сторожат апстрим-маркеры: если при апгрейде они исчезнут — пункт снова требует ревью.
    id: "cron-nested-lane-suspension-guard",
    gate: "review",
    locate: (files) => findOneJs(files, "model fallback bundle", [
      "src/agents/model-fallback.ts",
      "throwFallbackFailureSummary",
    ]),
    assertions: [
      contains("shouldDiscardDeferredSessionSuspension", "upstream deferred-suspension discard guard"),
      contains("isNonProviderRuntimeCoordinationError", "upstream coordination-error rethrow"),
      contains("suspended: !hasRemainingCandidates", "upstream suspend-only-on-exhaustion"),
    ],
  },
  {
    // 2026-07-01: адаптирован для 2026.6.11 (оба loadModelCatalog в isolated-cron снова write-форма
    // в апстриме), включён в apply-openclaw-2026-6-11-hotfixes.mjs → гейт повышен до required.
    id: "isolated-cron-readonly-model-catalog",
    gate: "required",
    locate: (files) => findOneJs(files, "isolated cron agent bundle", [
      "src/cron/isolated-agent/model-selection.ts",
      "src/cron/isolated-agent/run.ts",
    ]),
    assertions: [
      countAtLeast("readOnly: true", 2, "isolated cron read-only catalog loads"),
    ],
  },
  {
    id: "codex-app-server-marker-whitelist",
    gate: "review",
    locate: (files) => findOneJs(files, "model auth markers bundle", [
      "src/agents/model-auth-markers.ts",
      "CORE_NON_SECRET_API_KEY_MARKERS",
    ]),
    assertions: [
      contains("\"codex-app-server\"", "Codex app-server non-secret marker"),
    ],
  },
  {
    // 2026-07-01 review-решение: UPSTREAM-EQUIVALENT. Прямого loadModelCatalog({... readOnly: true})
    // в commands-models больше нет: браузинг идёт через loadModelCatalogForBrowse, который для
    // дефолтного view вызывает loadCatalog({ readOnly: true }) (литерал в model-catalog-browse-бандле);
    // full-discovery (readOnly: false) остаётся только для /models list all — осознанное поведение.
    id: "models-command-readonly-catalog",
    gate: "review",
    locate: (files) => findOneJs(files, "commands-models runtime bundle", [
      "src/auto-reply/reply/commands-models.ts",
      "async function buildModelsProviderData",
    ]),
    assertions: [
      contains("loadModelCatalogForBrowse", "upstream read-only browse catalog path"),
    ],
  },
  {
    // 2026-07-01 review-решение: UPSTREAM-EQUIVALENT (async). Апстрим встроил собственный ретрай
    // гонок чтения: readRegularFileWithRetry (5 попыток, exp backoff до 800ms), классификация по
    // FsSafeError.code === "path-mismatch" (== "File changed during read"), все async-читатели
    // (readJson/readJsonIfExists и обёртки) идут через него. Остаточный gap: readJsonSync без
    // ретрая — принят как низкорисковый (sync-чтения = конфиги/стартап), sync-часть не переносим.
    id: "json-read-race-retry",
    gate: "review",
    locate: (files) => findOneJs(files, "fs-safe JSON runtime bundle", [
      "node_modules/@openclaw/fs-safe/dist/json.js",
      "async function readJson(filePath)",
      "function readJsonSync(filePath)",
    ]),
    assertions: [
      contains("readRegularFileWithRetry", "upstream async read-retry helper"),
      contains('"path-mismatch"', "upstream read-race classifier by error code"),
      contains("READ_RETRY_MAX_ATTEMPTS", "upstream retry attempts constant"),
    ],
  },
  {
    id: "apdesktop-node-pairing-surface-repair-tool",
    gate: "required",
    locate: () => {
      const file = "/root/openclaw-hotfix/repair-apdesktop-node-pairing-surface.mjs";
      return { file, content: readText(file) };
    },
    assertions: [
      contains("2393f792a11236f7284c5297ffc1e4e0ff2c3dc69231bcfe8787baf8999b2262", "AP-DESKTOP node id"),
      contains("node.pair.request", "node pairing request repair"),
      contains("\"camera.capture\": true", "camera permission surface"),
      contains("\"screen.record\": true", "screen permission surface"),
      contains("\"device.status\"", "device.status validation"),
      contains("\"nodes\", \"approve\"", "admin-scope nodes approve path"),
    ],
  },
  {
    id: "gateway-prestart-reapply-hook-template",
    gate: "review",
    locate: () => {
      const file = "/root/openclaw-hotfixes/systemd/openclaw-gateway-hotfixes.conf";
      return { file, content: readText(file) };
    },
    assertions: [
      contains("ExecStartPre=/usr/bin/node /root/openclaw-hotfixes/apply-openclaw-hotfixes.mjs", "Gateway ExecStartPre hotfix hook template"),
    ],
  },
  {
    id: "watchdog-rpc-health-probe",
    gate: "review",
    locate: () => {
      const file = "/root/.openclaw/workspace-arseniy/scripts/gateway_watchdog.py";
      return { file, content: readText(file) };
    },
    assertions: [
      contains("def check_gateway_rpc_health", "watchdog Gateway RPC health function"),
      contains("'gateway'", "watchdog Gateway CLI argument"),
      contains("'health'", "watchdog health RPC method"),
      contains("rpc_ok", "watchdog rpc_ok state"),
      contains("rpc_duration_ms", "watchdog RPC duration state"),
    ],
  },
];

function main() {
  if (!fs.existsSync(distDir)) throw new Error(`dist directory does not exist: ${distDir}`);
  const packageJsonPath = path.join(packageRoot, "package.json");
  const pkg = readJson(packageJsonPath);
  const files = walkJs(distDir);
  const results = checks.map((check) => runCheck(files, check));
  const requiredResults = results.filter((result) => (result.gate ?? "review") === "required");
  const reviewResults = results.filter((result) => (result.gate ?? "review") !== "required");
  const failedRequired = requiredResults.filter((result) => !result.ok);
  const failedReview = reviewResults.filter((result) => !result.ok);

  console.log(`[openclaw-hotfix-check] package=${pkg.name ?? "openclaw"}@${pkg.version ?? "unknown"} root=${packageRoot}`);
  if (pkg.version !== expectedCurrentVersion) {
    console.log(`[openclaw-hotfix-check] warn version differs from current required baseline ${expectedCurrentVersion}; review required signatures before treating this as green`);
  }
  console.log(`[openclaw-hotfix-check] legacy-review-baseline=${legacyBaselineVersion}; review items do not fail the default gate`);
  for (const result of results) {
    const filePart = result.file ? ` ${rel(result.file)}` : "";
    const gate = result.gate ?? "review";
    const tag = gate === "required" ? result.ok ? "ok" : "fail" : result.ok ? "review-ok" : "review";
    console.log(`[${tag}] ${result.id}${filePart}`);
    for (const failure of result.failures) console.log(`  - ${failure}`);
  }
  console.log(`[openclaw-hotfix-check] summary required_ok=${requiredResults.length - failedRequired.length} required_failed=${failedRequired.length} review_ok=${reviewResults.length - failedReview.length} review_items=${failedReview.length}`);
  if (failedRequired.length > 0 || (strictReview && failedReview.length > 0)) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(`[openclaw-hotfix-check] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
