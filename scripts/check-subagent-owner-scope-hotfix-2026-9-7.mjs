#!/usr/bin/env node
// Verifies that the OpenClaw 2026.9.7 `subagent-owner-scope` hotfix is present
// in the installed package (both bundles). Exit code 1 when any required
// signature is missing.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CALLSITE_AFTER,
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

const contains = (needle, detail = needle) => (content) => (content.includes(needle) ? null : `missing ${detail}`);
const countExactly = (needle, expected, detail = needle) => (content) => {
  const count = content.split(needle).length - 1;
  return count === expected ? null : `expected ${detail} exactly ${expected} time(s), found ${count}`;
};

export const assertionsByTarget = {
  "openclaw-tools": [
    contains(CALLSITE_MARKER, "call-site marker"),
    contains(CALLSITE_AFTER, "senderIsOwner forwarded into createSessionsSpawnTool"),
    countExactly("senderIsOwner: options?.senderIsOwner, // " + CALLSITE_MARKER, 1, "call-site line"),
    // Drift guard: the option must actually exist on createOpenClawTools options (other tools read it too).
    (content) => (content.split("senderIsOwner: options?.senderIsOwner").length - 1 >= 2 ? null : "options.senderIsOwner is used only by the hotfix line (did createOpenClawTools stop receiving senderIsOwner?)"),
  ],
  "sessions-spawn-tool": [
    contains(MARKER, "spawn-tool marker"),
    contains(CTX_AFTER, "senderIsOwner forwarded into spawnSubagentDirect ctx"),
    contains(LAUNCH_AFTER, "launchChildRun adds operator.admin scopes for an owner parent"),
    countExactly("...ctx.senderIsOwner === true ? { scopes: [\"operator.admin\"] } : {}", 1, "scopes spread line"),
    contains("const launchChildRun = async (assertDispatchCurrent) => {", "upstream launchChildRun still present"),
    contains("async function spawnSubagentDirect(params, ctx) {", "upstream spawnSubagentDirect still present"),
  ],
};

export function checkTargetContent(targetId, content) {
  const assertions = assertionsByTarget[targetId];
  if (!assertions) throw new Error(`no assertions for target ${targetId}`);
  return assertions.map((assertion) => assertion(content)).filter(Boolean);
}

export function totalAssertions() {
  return Object.values(assertionsByTarget).reduce((sum, list) => sum + list.length, 0);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageRoot = resolvePackageRoot(options.packageRoot);
  const version = assertVersion(packageRoot);
  console.log(`[${hotfixId}-check] package=${packageRoot} version=${version}`);
  let failedCount = 0;
  for (const { target, file } of locateTargetFiles(packageRoot)) {
    const relative = path.relative(packageRoot, file);
    const failures = checkTargetContent(target.id, fs.readFileSync(file, "utf8"));
    failedCount += failures.length;
    if (failures.length > 0) {
      console.log(`[fail] ${hotfixId}/${target.id} ${relative}`);
      for (const failure of failures) console.log(`  - ${failure}`);
    } else {
      console.log(`[ok] ${hotfixId}/${target.id} ${relative}`);
    }
  }
  console.log(`[${hotfixId}-check] required_ok=${totalAssertions() - failedCount} required_failed=${failedCount}`);
  if (failedCount > 0) process.exitCode = 1;
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
