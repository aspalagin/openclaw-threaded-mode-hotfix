// OpenClaw 2026.11.1: new-clears-user-model-override-call.
import { replaceOnce, contains, notContains } from "../helpers.mjs";
export const label = "new-clears-user-model-override-call";
export const verdict = "rewrite";
export const target = { key: "getReply", label: "get-reply bundle", needles: ["function resolveReplySessionRolloverState(entry, sessionKey", "const preservedState = baseEntry ? selectSessionModelOverride(baseEntry) : entry ? resolveReplySessionRolloverState(entry, sessionKey"] };
export function patch(source) {
  if (source.includes("hotfix: /new clears user model override")) return source;
  let next = replaceOnce(source,
    "function resolveReplySessionRolloverState(entry, sessionKey) {\n\tconst preservedSelection = resolveResetPreservedSelection({ entry });",
    "function resolveReplySessionRolloverState(entry, sessionKey, preserveUserModelOverride) {\n\t// hotfix: /new clears user model override; /reset keeps it. (порт 2026.9.1: matchedResetTriggerLower)\n\tconst preservedSelection = resolveResetPreservedSelection({\n\t\tentry,\n\t\tpreserveUserModelOverride: preserveUserModelOverride !== false\n\t});",
    "/new reset-preserved selection (resolveReplySessionRolloverState)");
  next = replaceOnce(next,
    "\tconst preservedState = baseEntry ? selectSessionModelOverride(baseEntry) : entry ? resolveReplySessionRolloverState(entry, sessionKey) : void 0;",
    "\tconst preservedState = baseEntry ? selectSessionModelOverride(baseEntry) : entry ? resolveReplySessionRolloverState(entry, sessionKey, !(resetTriggered && typeof matchedResetTriggerLower === \"string\" && /^\\/?new(?:\\s|$)/.test(matchedResetTriggerLower))) : void 0;",
    "/new reset-preserved selection call (initSessionStateAttemptLocked)");
  return next;
}
export const check = { gate: "required", assertions: [
  contains("hotfix: /new clears user model override", "call marker"),
  contains("preserveUserModelOverride: preserveUserModelOverride !== false", "guard passthrough"),
  contains("/^\\/?new(?:\\s|$)/.test(matchedResetTriggerLower)", "/new discriminator"),
  // 9.7 drift guards: единственный вызов (без третьего аргумента не должно остаться) и дискриминатор в области видимости.
  notContains("resolveReplySessionRolloverState(entry, sessionKey);", "unpatched rollover call (new call site bypasses /new guard)"),
  notContains("resolveReplySessionRolloverState(entry, sessionKey) : void 0;", "unpatched 10.5 rollover call (preservedState expression without /new discriminator)"),
  (src) => (src.split("resolveReplySessionRolloverState(").length - 1) === 2 ? null : "new-clears-user-model-override-call: expected exactly 1 definition + 1 call of resolveReplySessionRolloverState",
  contains("\tconst matchedResetTriggerLower = ", "matchedResetTriggerLower binding in initSessionStateAttemptLocked"),
  (src) => {
    const fn = src.indexOf("async function initSessionStateAttemptLocked(");
    const bind = src.indexOf("\tconst matchedResetTriggerLower = ", fn);
    const call = src.indexOf("resolveReplySessionRolloverState(entry, sessionKey, !(resetTriggered", fn);
    const next = src.indexOf("\n}\n", bind);
    return fn >= 0 && bind > fn && call > bind && call < next ? null : "discriminator call must sit in initSessionStateAttemptLocked after matchedResetTriggerLower binding";
  },
] };
