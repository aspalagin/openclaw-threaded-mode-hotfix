#!/usr/bin/env node
// Functional test for the OpenClaw 2026.9.7 `dm-topic-adopt` hotfix.
//
// Locates the Telegram helpers bundle in the given package, applies the patch
// to an in-memory copy when the bundle is still vanilla (or uses it as-is when
// already patched), writes the copy next to the original so relative imports
// resolve, imports it, and drives `resolveTelegramMessageThreadSpec` through
// the scenarios below. The temporary copy is always removed. The installed
// bundle itself is never modified by this script.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  MARKER,
  assertVersion,
  hotfixId,
  locateTargetFile,
  parseArgs,
  patchSource,
  resolvePackageRoot,
} from "./apply-dm-topic-adopt-hotfix-2026-9-7.mjs";
import { checkContent } from "./check-dm-topic-adopt-hotfix-2026-9-7.mjs";

function resolveExportName(source, localName) {
  const match = source.match(new RegExp(`\\b${localName} as ([A-Za-z_$][\\w$]*)\\b`));
  if (match) return match[1];
  if (new RegExp(`export \\{[^}]*\\b${localName}\\b[^}]*\\}`).test(source)) return localName;
  throw new Error(`cannot find the export name of ${localName}`);
}

const options = parseArgs(process.argv.slice(2));
const packageRoot = resolvePackageRoot(options.packageRoot);
const version = assertVersion(packageRoot);
const file = locateTargetFile(packageRoot);
const original = fs.readFileSync(file, "utf8");
const alreadyPatched = original.includes(MARKER);
const patched = alreadyPatched ? original : patchSource(original);
console.log(`[${hotfixId}-test] package=${packageRoot} version=${version} bundle=${path.relative(packageRoot, file)} state=${alreadyPatched ? "patched" : "vanilla"}`);

if (!alreadyPatched && patched === original) throw new Error("patch produced no change on a vanilla bundle");
if (patchSource(patched) !== patched) throw new Error("patch is not idempotent");
const failures = checkContent(patched);
if (failures.length > 0) throw new Error(`checker assertions failed on the patched copy: ${failures.join("; ")}`);
if (!alreadyPatched && checkContent(original).length === 0) throw new Error("checker assertions must fail on the vanilla bundle");

const temporary = path.join(path.dirname(file), `zz-${hotfixId}-test-${process.pid}.mjs`);
fs.writeFileSync(temporary, patched, "utf8");
const results = [];
let failed = 0;
try {
  const check = spawnSync(process.execPath, ["--check", temporary], { encoding: "utf8" });
  if (check.status !== 0) throw new Error(`node --check failed: ${check.stderr || check.stdout}`);
  const mod = await import(pathToFileURL(temporary).href);
  const resolve = mod[resolveExportName(patched, "resolveTelegramMessageThreadSpec")];
  if (typeof resolve !== "function") throw new Error("resolveTelegramMessageThreadSpec export is not a function");

  // Synthetic identifiers only.
  const user = { id: 1001, is_bot: false, first_name: "U" };
  const bot = { id: 2002, is_bot: true, first_name: "B" };
  const chat = { id: 1001, type: "private", first_name: "U" };
  const topicCreated = (id, thread, date, from = user) => ({
    message_id: id,
    from,
    chat,
    date,
    message_thread_id: thread,
    is_topic_message: true,
    forum_topic_created: { name: "hello", icon_color: 1, is_name_implicit: true },
  });
  const plain = (id, date, extra = {}) => ({ message_id: id, from: user, chat, date, text: "hello", ...extra });
  const expect = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed += 1;
    results.push(`${ok ? "ok  " : "FAIL"} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  };

  // 1. The failing pair: service forum_topic_created, then the same user's message without a thread id in the same second.
  expect("service message keeps its own thread", resolve(topicCreated(100, 5001, 1000), false), { id: 5001, scope: "dm" });
  expect("orphan message adopted into the created topic", resolve(plain(101, 1000), false), { id: 5001, scope: "dm" });
  expect("re-evaluation of the same message is stable", resolve(plain(101, 1000), false), { id: 5001, scope: "dm" });
  expect("next unthreaded message is NOT adopted (pending consumed)", resolve(plain(102, 1001), false), { scope: "dm" });

  // 2. Normal path: the first message arrives inside the topic, so pending is consumed and later orphans stay in root.
  resolve(topicCreated(200, 5002, 2000), false);
  expect("normal first message in topic", resolve(plain(201, 2000, { message_thread_id: 5002, is_topic_message: true }), false), { id: 5002, scope: "dm" });
  expect("later unthreaded message stays in root", resolve(plain(202, 2001), false), { scope: "dm" });

  // 3. Window: a message later than 3 seconds is not adopted.
  resolve(topicCreated(300, 5003, 3000), false);
  expect("message after the window is not adopted", resolve(plain(301, 3004), false), { scope: "dm" });

  // 4. Ordering: a message id lower than the service message is not adopted.
  resolve(topicCreated(400, 5004, 4000), false);
  expect("older message id is not adopted", resolve(plain(399, 4000), false), { scope: "dm" });

  // 5. A topic created by the bot does not create a pending entry.
  resolve(topicCreated(500, 5005, 5000, bot), false);
  expect("bot-created topic does not capture the user message", resolve(plain(501, 5000), false), { scope: "dm" });

  // 6. Groups and bot messages are untouched.
  const groupChat = { id: -1001234567890, type: "supergroup", title: "G" };
  expect("forum group message unchanged", resolve({ message_id: 1, from: user, chat: { ...groupChat, is_forum: true }, date: 6000, text: "x", message_thread_id: 77, is_topic_message: true }, true), { id: 77, scope: "forum" });
  expect("non-forum group message unchanged (vanilla ignores thread id)", resolve({ message_id: 1, from: user, chat: groupChat, date: 6000, text: "x", message_thread_id: 77 }, false), { scope: "none" });
  expect("bot message unchanged", resolve({ message_id: 2, from: bot, chat, date: 6000, text: "x" }, false), { scope: "dm" });

  // 7. A second pair in another topic is adopted independently.
  resolve(topicCreated(700, 5007, 7000), false);
  expect("second pair adopted independently", resolve(plain(701, 7000), false), { id: 5007, scope: "dm" });
} finally {
  fs.rmSync(temporary, { force: true });
}

console.log(results.join("\n"));
console.log(`[${hotfixId}-test] scenarios=${results.length} failed=${failed} RESULT: ${failed ? "FAIL" : "PASS"}`);
if (failed) process.exitCode = 1;
