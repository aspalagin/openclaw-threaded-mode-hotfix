#!/usr/bin/env node
import { assert, fs, path, vm, root, prepared, testVersion, sourceFor, functionSource, regionSource } from "./test-support-2026-11-1.mjs";
import { pathToFileURL } from "node:url";

if (testVersion === "2026.11.1") {
// Actual resolver/helper code from the candidate bundle; no gateway import or network.
const dm = sourceFor("telegram-dm-topic-adopt-created");
const numericImport = dm.match(/import \{[^\n]*w as parseStrictPositiveInteger[^\n]*from "(\.\/[^"]+)"/);
assert.ok(numericImport);
const numberModule = await import(pathToFileURL(path.join(root, "dist", numericImport[1])));
const context = vm.createContext({ parseStrictPositiveInteger: numberModule.w, console: { error() {} } });
vm.runInContext(regionSource(dm, "hotfix: telegram-dm-topic-adopt-created") + "\n" + [
  "resolveTelegramForumThreadId", "resolveTelegramThreadSpec", "resolveTelegramMessageForumFlagHint", "resolveTelegramMessageThreadSpec",
].map((name) => functionSource(dm, name)).join("\n"), context);
const resolve = (message) => JSON.parse(JSON.stringify(context.resolveTelegramMessageThreadSpec(message, false)));
const chat = { id: 10, type: "private" };
const user = { id: 20, is_bot: false };
const plain = (message_id, date, extra = {}) => ({ chat, from: user, message_id, date, text: "hello", ...extra });
const created = (id, date, thread, extra = {}) => plain(id, date, { message_thread_id: thread, forum_topic_created: { name: "hello" }, ...extra });
assert.deepEqual(resolve(created(1, 100, 101)), { id: 101, scope: "dm" });
assert.deepEqual(resolve(plain(2, 100)), { id: 101, scope: "dm" });
assert.deepEqual(resolve(plain(2, 100)), { id: 101, scope: "dm" });
assert.deepEqual(resolve(plain(3, 101)), { scope: "dm" });
resolve(created(10, 200, 102));
assert.deepEqual(resolve(plain(11, 200, { message_thread_id: 102 })), { id: 102, scope: "dm" });
assert.deepEqual(resolve(plain(12, 201)), { scope: "dm" });
resolve(created(20, 300, 103));
assert.deepEqual(resolve(plain(21, 304)), { scope: "dm" });
assert.deepEqual(resolve(plain(19, 300)), { scope: "dm" });
resolve(created(30, 400, 104, { from: { ...user, is_bot: true } }));
assert.deepEqual(resolve(plain(31, 400)), { scope: "dm" });
resolve(created(40, 500, 105));
assert.deepEqual(resolve(plain(41, 500, { from: { ...user, id: 21 } })), { scope: "dm" });
assert.deepEqual(resolve(plain(42, 503)), { id: 105, scope: "dm" });
assert.deepEqual(resolve(plain(50, 600, { chat: { id: -10, type: "group" }, message_thread_id: 99 })), { scope: "none" });
assert.deepEqual(resolve(plain(51, 600, { chat: { ...chat, is_direct_messages: true }, direct_messages_topic: { topic_id: 77 } })), { id: 77, scope: "direct-messages" });

} else {
  assert.ok(prepared.every((entry) => entry.modules.every(({ name }) => name !== "telegram-dm-topic-adopt-created")));
  assert.ok(prepared.every((entry) => !entry.after.includes("//#region hotfix: telegram-dm-topic-adopt-created")), "11.3 must not introduce DM topic adoption");
}

// Topic isolation does not remove explicit fork/spawn inheritance.
const model = vm.createContext({ normalizeOptionalString: (v) => typeof v === "string" ? v.trim() : undefined, resolveSessionParentSessionKey: () => "derived-parent" });
vm.runInContext(functionSource(sourceFor("telegram-dm-topic-model-isolation"), "resolveParentSessionKeyCandidate"), model);
const topic = "agent:a:telegram:direct:10:thread:10:101";
assert.equal(model.resolveParentSessionKeyCandidate({ sessionKey: topic }), null);
assert.equal(model.resolveParentSessionKeyCandidate({ sessionKey: topic, parentSessionKey: "explicit-parent" }), "explicit-parent");
assert.equal(model.resolveParentSessionKeyCandidate({ sessionKey: "agent:a:other:thread:1" }), "derived-parent");

// /new clears the user model pin; /reset preserves it and unrelated auth/communication survive.
const reset = vm.createContext({ resolveSessionModelOverrideSource: (entry) => entry.modelOverrideSource, resolveSessionAuthProfileOverrideSource: (entry) => entry.authProfileOverrideSource });
vm.runInContext(functionSource(sourceFor("new-clears-user-model-override-core"), "resolveResetPreservedSelection"), reset);
const entry = { modelOverrideSource: "user", modelOverride: "custom", providerOverride: "provider", communication: { verbose: true }, authProfileOverride: "auth", authProfileOverrideSource: "user" };
assert.equal(reset.resolveResetPreservedSelection({ entry, preserveUserModelOverride: false }).modelOverride, undefined);
assert.equal(reset.resolveResetPreservedSelection({ entry }).modelOverride, "custom");
assert.equal(reset.resolveResetPreservedSelection({ entry, preserveUserModelOverride: false }).authProfileOverride, "auth");
assert.equal(reset.resolveResetPreservedSelection({ entry, preserveUserModelOverride: false }).communication.verbose, true);
const caller = sourceFor("new-clears-user-model-override-call");
const stateLine = caller.split("\n").find((line) => line.includes("const preservedState = baseEntry ?"));
assert.ok(stateLine);
const preserve = new Function("resetTriggered", "matchedResetTriggerLower", "baseEntry", "entry", "sessionKey", "selectSessionModelOverride", "resolveReplySessionRolloverState", stateLine + "\nreturn preservedState;");
for (const [trigger, resetTriggered, expected] of [["/new", true, false], ["new hello", true, false], ["/reset", true, true], ["/new", false, true]]) {
  assert.equal(preserve(resetTriggered, trigger, null, {}, topic, () => {}, (_entry, _key, keep) => keep), expected);
}

// Evaluate the actual request literal; only strict owner=true gains admin scope.
const spawn = sourceFor("subagent-inherit-owner-scope");
const anchor = "const launch = await runWithAgentToolSourceExecutionScope(assertDispatchCurrent, () => callNativeSubagentGateway(withSubagentGatewayExecutionIdentity({";
const start = spawn.indexOf(anchor);
const end = spawn.indexOf("\n\t\t\t}, {", start);
assert.ok(start >= 0 && end > start);
const literal = "{" + spawn.slice(start + anchor.length, end) + "\n}";
const launch = new Function("ctx", "childLaunch", "assertDispatchCurrent", "return " + literal);
const childLaunch = { request: { message: "hello" }, timeoutMs: 1000 };
for (const owner of [true, false, undefined, "true", 1]) {
  const request = launch({ senderIsOwner: owner }, childLaunch, () => {});
  assert.equal("scopes" in request, owner === true);
  if (owner === true) assert.deepEqual(request.scopes, ["operator.admin"]);
  assert.equal(request.params, childLaunch.request);
  assert.equal(request.timeoutMs, 1000);
}
console.log(`PASS: ${testVersion === "2026.11.1" ? "DM adoption boundaries" : "DM adoption disabled"}, topic model isolation, /new vs /reset, strict owner-only child scope`);
