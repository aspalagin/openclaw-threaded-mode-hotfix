// OpenClaw 2026.11.1: telegram-dm-topic-model-isolation.
import { replaceOnce, contains, notContains } from "../helpers.mjs";
export const label = "telegram-dm-topic-model-isolation";
export const verdict = "port";
export const target = {
 "key": "storedModelOverride",
 "label": "stored model override bundle",
 "needles": [
  "function resolveParentSessionKeyCandidate(params)",
  "function resolveStoredModelOverride(params)",
  "source: \"parent\""
 ]
};
// ---- старый патч (inventory/patch-src/telegram-dm-topic-model-isolation.mjs) ----
// label=telegram-dm-topic-model-isolation target=storedModelOverride runApplyLine=5182 applyLines=4084-4100
// telegram-dm-topic-model-isolation (2026-08-08): topic-сессия не должна
// неявно наследовать пользовательский model pin родительского DM. Явный
// parentSessionKey (fork/spawn) сохраняет прежнюю семантику; блокируется только
// generic parent, выведенный из суффикса Telegram direct thread-key.
function patchTelegramDmTopicModelIsolation(source) {
  if (source.includes("hotfix: telegram-dm-topic-model-isolation")) return source;
  return replaceOnce(
    source,
    "\tif (explicit && explicit !== params.sessionKey) return explicit;\n\tconst derived = resolveSessionParentSessionKey(params.sessionKey);",
    "\tif (explicit && explicit !== params.sessionKey) return explicit;\n\t// hotfix: telegram-dm-topic-model-isolation (2026-08-08) — topic model pins are session-local.\n\tif (typeof params.sessionKey === \"string\" && /^agent:[^:]+:telegram:direct:[^:]+:thread:/.test(params.sessionKey)) return null;\n\tconst derived = resolveSessionParentSessionKey(params.sessionKey);",
    "Telegram DM topic derived parent model inheritance",
  );
}

// new-clears-user-model-override (2026-08-08): /new означает действительно
// новую сессию и возвращает configured primary. /reset и sessions.reset
// сохраняют прежнее поведение и пользовательский pin.

// ---- /старый патч ----
export function patch(source) { return patchTelegramDmTopicModelIsolation(source); }
export const check = { gate: "required", assertions: [
      contains("hotfix: telegram-dm-topic-model-isolation", "Telegram DM topic model isolation marker"),
      contains('/^agent:[^:]+:telegram:direct:[^:]+:thread:/.test(params.sessionKey)', "Telegram direct topic-key guard"),
      contains("if (explicit && explicit !== params.sessionKey) return explicit;", "explicit parent inheritance remains available"),
    ] };
