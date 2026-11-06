// OpenClaw 2026.11.1: new-clears-user-model-override-core.
import { replaceOnce, contains } from "../helpers.mjs";
export const label = "new-clears-user-model-override-core";
export const verdict = "port";
export const target = { key: "resetPreservedSelection", label: "reset-preserved-selection bundle", needles: ["function resolveResetPreservedSelection(params) {", "resolveSessionModelOverrideSource(entry) === \"user\" && entry.modelOverride"] };
export function patch(source) {
  if (source.includes("hotfix: new-clears-user-model-override")) return source;
  return replaceOnce(source,
    "\tif (resolveSessionModelOverrideSource(entry) === \"user\" && entry.modelOverride) {",
    "\t// hotfix: new-clears-user-model-override (2026-08-08, порт 2026.9.1) — caller may request a clean configured model.\n\tif (params.preserveUserModelOverride !== false && resolveSessionModelOverrideSource(entry) === \"user\" && entry.modelOverride) {",
    "reset-preserved user model selection guard");
}
export const check = { gate: "required", assertions: [contains("hotfix: new-clears-user-model-override", "core marker"), contains("params.preserveUserModelOverride !== false && resolveSessionModelOverrideSource(entry) === \"user\"", "preserve guard")] };
