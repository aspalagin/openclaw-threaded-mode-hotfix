#!/usr/bin/env node
// Functional test for the OpenClaw 2026.9.7 `subagent-owner-scope` hotfix.
//
// Locates both target bundles in the given package, applies the patches to
// in-memory copies when the bundles are still vanilla (or uses them as-is when
// already patched), verifies idempotency and the checker assertions, writes
// each copy next to its original for `node --check`, and then evaluates the
// three patched object literals in isolation (the `createSessionsSpawnTool`
// options, the spawn context handed to `spawnSubagentDirect`, and the gateway
// `agent` request built by `launchChildRun`) with synthetic inputs to prove
// that `senderIsOwner` flows from the tool options to the child launch and
// that `scopes: ["operator.admin"]` is added only for `senderIsOwner === true`.
// The temporary copies are always removed; the installed bundles are never
// modified by this script.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  CALLSITE_MARKER,
  CTX_AFTER,
  LAUNCH_AFTER,
  MARKER,
  assertVersion,
  hotfixId,
  locateTargetFiles,
  parseArgs,
  resolvePackageRoot,
} from "./apply-subagent-owner-scope-hotfix-2026-9-7.mjs";
import { checkTargetContent } from "./check-subagent-owner-scope-hotfix-2026-9-7.mjs";

const results = [];
let failed = 0;
const expect = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  results.push(`${ok ? "ok  " : "FAIL"} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

/** Returns the balanced `{ ... }` literal that starts at `openIndex`. */
function extractBraced(source, openIndex) {
  if (source[openIndex] !== "{") throw new Error("extractBraced: not at an opening brace");
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }
  throw new Error("extractBraced: unbalanced braces");
}

/** Finds the object literal that contains `needle`: the `{` right after `opener` that precedes the needle. */
function literalContaining(source, opener, needle, label) {
  const needleIndex = source.indexOf(needle);
  if (needleIndex === -1) throw new Error(`${label}: needle not found`);
  const openerIndex = source.lastIndexOf(opener, needleIndex);
  if (openerIndex === -1) throw new Error(`${label}: opener not found before the needle`);
  const literal = extractBraced(source, openerIndex + opener.length - 1);
  if (!literal.includes(needle)) throw new Error(`${label}: extracted literal does not contain the needle`);
  return literal;
}

const options = parseArgs(process.argv.slice(2));
const packageRoot = resolvePackageRoot(options.packageRoot);
const version = assertVersion(packageRoot);
const located = locateTargetFiles(packageRoot);
const prepared = located.map(({ target, file }) => {
  const original = fs.readFileSync(file, "utf8");
  const marker = target.id === "openclaw-tools" ? CALLSITE_MARKER : MARKER;
  const alreadyPatched = original.includes(marker);
  const patched = alreadyPatched ? original : target.patch(original);
  console.log(`[${hotfixId}-test] target=${target.id} bundle=${path.relative(packageRoot, file)} state=${alreadyPatched ? "patched" : "vanilla"}`);
  if (!alreadyPatched && patched === original) throw new Error(`${target.id}: patch produced no change on a vanilla bundle`);
  if (target.patch(patched) !== patched) throw new Error(`${target.id}: patch is not idempotent`);
  const failures = checkTargetContent(target.id, patched);
  if (failures.length > 0) throw new Error(`${target.id}: checker assertions failed on the patched copy: ${failures.join("; ")}`);
  if (!alreadyPatched && checkTargetContent(target.id, original).length === 0) throw new Error(`${target.id}: checker assertions must fail on the vanilla bundle`);
  return { target, file, patched };
});
console.log(`[${hotfixId}-test] package=${packageRoot} version=${version}`);

// 1. Syntax of the patched bundles (temporary copies next to the originals).
const temporaries = [];
try {
  for (const { target, file, patched } of prepared) {
    const temporary = path.join(path.dirname(file), `zz-${hotfixId}-test-${process.pid}-${target.id}.mjs`);
    temporaries.push(temporary);
    fs.writeFileSync(temporary, patched, "utf8");
    const check = spawnSync(process.execPath, ["--check", temporary], { encoding: "utf8" });
    expect(`${target.id}: node --check on the patched copy`, check.status, 0);
    if (check.status !== 0) console.log(check.stderr || check.stdout);
  }
} finally {
  for (const temporary of temporaries) fs.rmSync(temporary, { force: true });
}

// 2. Semantics of the patched fragments, evaluated in isolation with synthetic inputs.
const callsiteSource = prepared.find((item) => item.target.id === "openclaw-tools").patched;
const spawnSource = prepared.find((item) => item.target.id === "sessions-spawn-tool").patched;

const callsiteLiteral = literalContaining(callsiteSource, "[createSessionsSpawnTool({", "senderIsOwner: options?.senderIsOwner, // " + CALLSITE_MARKER, "call-site options");
const callsiteFactory = new Function("options", "sessionConfig", "sessionAgentId", "spawnWorkspaceDir", `return ${callsiteLiteral};`);
const callsiteOptions = (options) => callsiteFactory(options, { configured: true }, "agent-a", "/tmp/workspace");
expect("call site: owner parent forwards senderIsOwner=true", callsiteOptions({ senderIsOwner: true, runId: "run-1" }).senderIsOwner, true);
expect("call site: non-owner parent forwards senderIsOwner=false", callsiteOptions({ senderIsOwner: false }).senderIsOwner, false);
expect("call site: unknown sender forwards undefined", callsiteOptions({}).senderIsOwner, undefined);
expect("call site: no options object does not throw", callsiteOptions(undefined).senderIsOwner, undefined);
expect("call site: neighbouring options survive", callsiteOptions({ runId: "run-1", swarmCollector: "c" }).requesterRunId, "run-1");

const ctxLiteral = literalContaining(spawnSource, "withParentExecutionIdentity({", CTX_AFTER.split("\n")[1], "spawn context");
const ctxFactory = new Function("opts", "inheritedSpawnContext", `return ${ctxLiteral};`);
const spawnContext = (opts) => ctxFactory(opts, () => ({ inherited: true }));
expect("spawn ctx: senderIsOwner=true reaches the context", spawnContext({ senderIsOwner: true }).senderIsOwner, true);
expect("spawn ctx: senderIsOwner=false reaches the context", spawnContext({ senderIsOwner: false }).senderIsOwner, false);
expect("spawn ctx: missing opts leaves senderIsOwner undefined", spawnContext(undefined).senderIsOwner, undefined);
expect("spawn ctx: inherited context and requesterRunId survive", (() => {
  const ctx = spawnContext({ requesterRunId: "run-2" });
  return [ctx.inherited, ctx.requesterRunId];
})(), [true, "run-2"]);

const launchLiteral = literalContaining(spawnSource, "withSubagentGatewayExecutionIdentity({", LAUNCH_AFTER.split("\n")[1], "launchChildRun request");
const launchFactory = new Function("ctx", "childLaunch", "assertDispatchCurrent", `return ${launchLiteral};`);
const childLaunch = { request: { message: "hello", sessionKey: "agent:a:subagent:x" }, timeoutMs: 1234 };
const launch = (ctx) => launchFactory(ctx, childLaunch, () => {});
expect("launch: owner parent gets operator.admin scopes", launch({ senderIsOwner: true }).scopes, ["operator.admin"]);
expect("launch: non-owner parent gets no scopes key", "scopes" in launch({ senderIsOwner: false }), false);
expect("launch: unknown sender gets no scopes key", "scopes" in launch({}), false);
expect("launch: truthy non-boolean is NOT treated as owner", "scopes" in launch({ senderIsOwner: "true" }), false);
expect("launch: method/params/timeout preserved", (() => {
  const request = launch({ senderIsOwner: true });
  return [request.method, request.params === childLaunch.request, request.timeoutMs];
})(), ["agent", true, 1234]);

// 3. End to end through the three literals: tool options → spawn context → child launch request.
const endToEnd = (toolOptions) => launch(spawnContext(callsiteOptions(toolOptions)));
expect("end to end: owner run → child launched with operator.admin", endToEnd({ senderIsOwner: true }).scopes, ["operator.admin"]);
expect("end to end: non-owner run → least-privilege child", "scopes" in endToEnd({ senderIsOwner: false }), false);
expect("end to end: sender unknown → least-privilege child", "scopes" in endToEnd({}), false);

// 4. Version guard: a foreign package is refused.
const foreign = fs.mkdtempSync(path.join(os.tmpdir(), `${hotfixId}-foreign-`));
try {
  fs.writeFileSync(path.join(foreign, "package.json"), JSON.stringify({ name: "openclaw", version: "0.0.0" }));
  let message = "";
  try {
    assertVersion(foreign);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect("version guard rejects openclaw@0.0.0", message.includes("unsupported OpenClaw version 0.0.0"), true);
} finally {
  fs.rmSync(foreign, { recursive: true, force: true });
}

console.log(results.join("\n"));
console.log(`[${hotfixId}-test] scenarios=${results.length} failed=${failed} RESULT: ${failed ? "FAIL" : "PASS"}`);
if (failed) process.exitCode = 1;
