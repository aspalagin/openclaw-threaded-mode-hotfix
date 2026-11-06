// OpenClaw 2026.11.1: subagent-inherit-owner-scope.
import { contains, replaceOnce } from "../helpers.mjs";

export const label = "subagent-inherit-owner-scope";
export const verdict = "port";
export const target = {
  key: "sessionsSpawnTool",
  label: "sessions_spawn tool (native subagent launch)",
  needles: [
    "async function spawnSubagentDirect(params, ctx) {",
    "const launchChildRun = async (assertDispatchCurrent) => {",
  ],
};

const MARKER = "hotfix: subagent-inherit-owner-scope";

// B (апстрим 10.5): ctx для spawnSubagentDirect уже получает senderIsOwner из opts инструмента.
const UP_B_CTX = "\t\t\tconst inheritedSpawnContext = () => ({\n\t\t\t\tassertActive,\n\t\t\t\tonSpawnEffectsStart,\n\t\t\t\tagentSessionKey: opts?.agentSessionKey,\n\t\t\t\tsenderIsOwner: opts?.senderIsOwner,\n";
const UP_B_NATIVE = "\t\t\tconst result = await spawnSubagentDirect({";
const UP_B_SPREAD = "\t\t\t}, withParentExecutionIdentity(withExecRequestOwners({\n\t\t\t\t...inheritedSpawnContext(),\n";

// C: запуск дочернего рана с operator.admin, если родительский ран — от владельца.
const C_BEFORE = "\t\t\t\tparams: childLaunch.request,\n\t\t\t\ttimeoutMs: childLaunch.timeoutMs\n\t\t\t}, {\n";
const C_LINE = "\t\t\t\t...ctx.senderIsOwner === true ? { scopes: [\"operator.admin\"] } : {}, // " + MARKER + ": owner parent → owner child (no GATEWAY_OWNER_ONLY_CORE_TOOLS deny)\n";
const C_AFTER = "\t\t\t\tparams: childLaunch.request,\n" + C_LINE + "\t\t\t\ttimeoutMs: childLaunch.timeoutMs\n\t\t\t}, {\n";

export function patch(source) {
  if (source.includes(MARKER)) return source;
  return replaceOnce(source, C_BEFORE, C_AFTER, "launchChildRun: admin scopes for owner parent");
}

export const check = { gate: "required", assertions: [
  contains(C_AFTER, "owner parent launches child with operator.admin scopes"),
  // C стоит внутри launchChildRun (вызов callNativeSubagentGateway(withSubagentGatewayExecutionIdentity({ method: "agent", … }))).
  (c) => { const l = c.indexOf("const launchChildRun = async (assertDispatchCurrent) => {"); const p = c.indexOf(C_LINE); const g = c.indexOf("const launch = await runWithAgentToolSourceExecutionScope(assertDispatchCurrent, () => callNativeSubagentGateway(withSubagentGatewayExecutionIdentity({\n\t\t\t\tmethod: \"agent\",", l); return l !== -1 && g > l && p > g && p - g < 400 ? null : "admin scopes not inside launchChildRun's agent dispatch"; },
  // Шаг B — апстрим: без него ctx.senderIsOwner всегда undefined и порт мёртв.
  contains(UP_B_CTX, "upstream inheritedSpawnContext forwards senderIsOwner (step B)"),
  (c) => { const n = c.indexOf(UP_B_NATIVE); return n !== -1 && c.indexOf(UP_B_SPREAD, n) !== -1 ? null : "native spawnSubagentDirect no longer receives ...inheritedSpawnContext() (ctx.senderIsOwner lost)"; },
  // контракт params.scopes ?? … живёт в subagent-spawn-cleanup-*.mjs (другой чанк) — проверяется отдельно в отчёте apply (см. манифест 15.10).
] };
