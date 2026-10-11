#!/usr/bin/env node
// Verifies that the OpenClaw 2026.9.7 `dm-topic-adopt` hotfix is present in the
// installed package. Exit code 1 when any required signature is missing.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  MARKER,
  assertVersion,
  hotfixId,
  locateTargetFile,
  parseArgs,
  resolvePackageRoot,
} from "./apply-dm-topic-adopt-hotfix-2026-9-7.mjs";

const VANILLA_FN_HEAD = "function resolveTelegramMessageThreadSpec(message, isForum) {\n\tif (message.chat.is_direct_messages === true) {";

const contains = (needle, detail = needle) => (content) => (content.includes(needle) ? null : `missing ${detail}`);
const notContains = (needle, detail = needle) => (content) => (content.includes(needle) ? `unexpected ${detail}` : null);

export const assertions = [
  contains(MARKER, "dm-topic-adopt marker"),
  contains("function resolveHotfixDmTopicAdoptThreadId(message) {", "adopt resolver helper"),
  contains("function getHotfixDmTopicAdoptState() {", "adopt state singleton"),
  contains("const hotfixAdoptedDmThreadId = resolveHotfixDmTopicAdoptThreadId(message);", "resolver consults adoption first"),
  contains("[hotfix][dm-topic-adopt] adopted chat=", "visible adoption log"),
  contains("function resolveTelegramMessageThreadSpec(message, isForum) {", "upstream resolver still present"),
  contains("parseStrictPositiveInteger(message.direct_messages_topic?.topic_id)", "parseStrictPositiveInteger in scope of the resolver (import from number-coercion chunk)"),
  notContains(VANILLA_FN_HEAD, "vanilla resolver head must be replaced"),
];

export function checkContent(content) {
  return assertions.map((assertion) => assertion(content)).filter(Boolean);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageRoot = resolvePackageRoot(options.packageRoot);
  const version = assertVersion(packageRoot);
  const file = locateTargetFile(packageRoot);
  const relative = path.relative(packageRoot, file);
  const failures = checkContent(fs.readFileSync(file, "utf8"));
  console.log(`[${hotfixId}-check] package=${packageRoot} version=${version} bundle=${relative}`);
  if (failures.length > 0) {
    console.log(`[fail] ${hotfixId} ${relative}`);
    for (const failure of failures) console.log(`  - ${failure}`);
  } else {
    console.log(`[ok] ${hotfixId} ${relative}`);
  }
  console.log(`[${hotfixId}-check] required_ok=${assertions.length - failures.length} required_failed=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`[${hotfixId}-check] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
