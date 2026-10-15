#!/usr/bin/env node
// OpenClaw 2026.9.7 hotfix: subagent-inherit-owner-scope.
//
// Symptom: every child run started through the `sessions_spawn` tool runs as a
// NON-owner, even when the parent run was started by the gateway owner.
// `callSubagentGatewayWithDispatchMode` launches the child with least-privilege
// operator scopes (no `operator.admin`), so the gateway `agent` handler derives
// `senderIsOwner = false` for the child and the owner-only core tool denylist
// (`GATEWAY_OWNER_ONLY_CORE_TOOLS`: nodes, computer, mobile_ui, sessions,
// terminal, portal, conversations_*, openclaw, screen) is applied to the child.
// The sub-agent then fails with `Unknown tool id: openclaw:core:nodes` and the
// like. Observed on 2026-10-15: the parent's code-mode catalog listed 97 tools,
// the child's 72.
//
// Fix (two bundles under dist/, located by code signatures, never by file name):
//
// 1. `openclaw-tools-*.mjs` — `createOpenClawTools` already knows
//    `options.senderIsOwner` (it forwards it to the message / nodes / sessions
//    tools) but did not pass it to `createSessionsSpawnTool`. The call site now
//    forwards `senderIsOwner: options?.senderIsOwner`.
// 2. `sessions-spawn-tool-*.mjs` — the spawn context handed to
//    `spawnSubagentDirect` carries `senderIsOwner` from the tool options, and
//    `launchChildRun` adds `scopes: ["operator.admin"]` to the gateway `agent`
//    request when `ctx.senderIsOwner === true`. This is the same
//    `params.scopes ?? …` contract the dispatcher already uses for
//    `launch.authorization` / out-of-process model override authorization.
//
// A child inherits owner privileges only when the parent run itself was an
// owner run (`senderIsOwner === true`). Group chats and non-owner senders keep
// the previous behaviour; collector runs (`collect: true`) are not touched.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const expectedVersion = "2026.9.7";
export const hotfixId = "subagent-owner-scope";
export const MARKER = "hotfix: subagent-inherit-owner-scope";
export const CALLSITE_MARKER = "hotfix: subagent-inherit-owner-scope.callsite";

// The standalone updater bundle (dist/package-update-activation-recovery.mjs)
// duplicates almost the whole gateway and therefore matches every signature
// below a second time; it is not part of the gateway runtime and is skipped.
export const EXCLUDED_BUNDLES = new Set(["package-update-activation-recovery.mjs"]);

// --- target 1: createOpenClawTools → createSessionsSpawnTool call site -------
export const CALLSITE_BEFORE = "\t\t\trequesterRunId: options?.runId,\n\t\t\tswarmCollector: options?.swarmCollector,\n";
export const CALLSITE_AFTER =
  "\t\t\trequesterRunId: options?.runId,\n" +
  "\t\t\tsenderIsOwner: options?.senderIsOwner, // " + CALLSITE_MARKER + "\n" +
  "\t\t\tswarmCollector: options?.swarmCollector,\n";

// --- target 2: sessions_spawn tool (native sub-agent launch) ------------------
export const CTX_BEFORE =
  "\t\t\t\tsessionPermissionPolicy: opts?.sessionPermissionPolicy,\n" +
  "\t\t\t\trequesterRunId: opts?.requesterRunId\n" +
  "\t\t\t}, parentExecutionIdentityToken));";
export const CTX_AFTER =
  "\t\t\t\tsessionPermissionPolicy: opts?.sessionPermissionPolicy,\n" +
  "\t\t\t\tsenderIsOwner: opts?.senderIsOwner, // " + MARKER + "\n" +
  "\t\t\t\trequesterRunId: opts?.requesterRunId\n" +
  "\t\t\t}, parentExecutionIdentityToken));";
export const LAUNCH_BEFORE =
  "\t\t\t\tparams: childLaunch.request,\n" +
  "\t\t\t\ttimeoutMs: childLaunch.timeoutMs\n" +
  "\t\t\t}, {\n";
export const LAUNCH_LINE =
  "\t\t\t\t...ctx.senderIsOwner === true ? { scopes: [\"operator.admin\"] } : {}, // " + MARKER +
  ": owner parent → owner child (no GATEWAY_OWNER_ONLY_CORE_TOOLS deny)\n";
export const LAUNCH_AFTER =
  "\t\t\t\tparams: childLaunch.request,\n" +
  LAUNCH_LINE +
  "\t\t\t\ttimeoutMs: childLaunch.timeoutMs\n" +
  "\t\t\t}, {\n";

export function fail(message) {
  throw new Error(message);
}

export function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index === -1) fail(`missing ${label}`);
  if (source.indexOf(before, index + before.length) !== -1) fail(`ambiguous ${label}`);
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

/** Pure transformation of the openclaw-tools bundle; unchanged when the marker is present. */
export function patchCallsiteSource(source) {
  if (source.includes(CALLSITE_MARKER)) return source;
  return replaceOnce(source, CALLSITE_BEFORE, CALLSITE_AFTER, "sessions_spawn call site (requesterRunId/swarmCollector options)");
}

/** Pure transformation of the sessions-spawn-tool bundle; unchanged when the marker is present. */
export function patchSpawnToolSource(source) {
  if (source.includes(MARKER)) return source;
  let next = replaceOnce(source, CTX_BEFORE, CTX_AFTER, "spawn context (sessionPermissionPolicy/requesterRunId)");
  next = replaceOnce(next, LAUNCH_BEFORE, LAUNCH_AFTER, "launchChildRun gateway request (params/timeoutMs)");
  return next;
}

export const targets = [
  {
    id: "openclaw-tools",
    label: "createOpenClawTools bundle (createSessionsSpawnTool call site)",
    // Needles must survive the patch (the call-site anchor itself is rewritten).
    needles: ["[createSessionsSpawnTool({", "\t\t\tswarmCollector: options?.swarmCollector,\n\t\t\tworkspaceDir: spawnWorkspaceDir,\n"],
    patch: patchCallsiteSource,
  },
  {
    id: "sessions-spawn-tool",
    label: "sessions_spawn tool bundle (spawnSubagentDirect / launchChildRun)",
    needles: [
      "async function spawnSubagentDirect(params, ctx) {",
      "const launchChildRun = async (assertDispatchCurrent) => {",
    ],
    patch: patchSpawnToolSource,
  },
];

export function parseArgs(argv) {
  const options = { packageRoot: undefined, backupDir: undefined, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check" || arg === "--dry-run") options.dryRun = true;
    else if (arg === "--package-root") options.packageRoot = argv[++index];
    else if (arg.startsWith("--package-root=")) options.packageRoot = arg.slice("--package-root=".length);
    else if (arg === "--backup-dir") options.backupDir = argv[++index];
    else if (arg.startsWith("--backup-dir=")) options.backupDir = arg.slice("--backup-dir=".length);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else fail(`unknown argument: ${arg}`);
  }
  return options;
}

export function resolvePackageRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.OPENCLAW_PACKAGE_ROOT) return path.resolve(process.env.OPENCLAW_PACKAGE_ROOT);
  const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8" });
  if (npm.status === 0 && npm.stdout.trim()) return path.join(npm.stdout.trim(), "openclaw");
  fail("cannot resolve the global npm root; pass --package-root or set OPENCLAW_PACKAGE_ROOT");
}

export function walkBundles(root) {
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) && !EXCLUDED_BUNDLES.has(entry.name)) files.push(target);
    }
  }
  return files.sort();
}

export function findOne(files, label, needles) {
  const matches = files.filter((file) => {
    const content = fs.readFileSync(file, "utf8");
    return needles.every((needle) => content.includes(needle));
  });
  if (matches.length !== 1) fail(`${label}: expected one matching bundle, found ${matches.length}`);
  return matches[0];
}

export function assertVersion(packageRoot) {
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) fail(`not an OpenClaw package root (no package.json): ${packageRoot}`);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== "openclaw") fail(`package at ${packageRoot} is ${packageJson.name}, expected openclaw`);
  if (packageJson.version !== expectedVersion) {
    fail(`unsupported OpenClaw version ${packageJson.version}; expected ${expectedVersion}`);
  }
  return packageJson.version;
}

/**
 * Locates both bundles by content. Needles describe pristine code that the
 * patch keeps intact, so the same locator works on vanilla and patched installs.
 * Returns [{ target, file }] in apply order.
 */
export function locateTargetFiles(packageRoot) {
  const distDir = path.join(packageRoot, "dist");
  if (!fs.existsSync(distDir)) fail(`dist directory does not exist: ${distDir}`);
  const files = walkBundles(distDir);
  return targets.map((target) => ({ target, file: findOne(files, target.label, target.needles) }));
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function nodeCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) fail(`node --check failed for ${file}:\n${(result.stderr || result.stdout || "").trim()}`);
}

function usage() {
  console.log(`Usage: node scripts/apply-subagent-owner-scope-hotfix-2026-9-7.mjs [--package-root <dir>] [--backup-dir <dir>] [--dry-run|--check]

  --package-root  OpenClaw package directory (default: OPENCLAW_PACKAGE_ROOT or <npm root -g>/openclaw)
  --backup-dir    where the original bundles are copied before patching
                  (default: OPENCLAW_HOTFIX_BACKUP_DIR or ./openclaw-hotfix-backups/subagent-owner-scope-hotfix)
  --dry-run       compute the patches and report, write nothing`);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return;
  }
  const packageRoot = resolvePackageRoot(options.packageRoot);
  const backupRoot = path.resolve(
    options.backupDir || process.env.OPENCLAW_HOTFIX_BACKUP_DIR || path.join("openclaw-hotfix-backups", "subagent-owner-scope-hotfix"),
  );
  const version = assertVersion(packageRoot);
  console.log(`[${hotfixId}] package=${packageRoot} version=${version}`);

  // All-or-nothing: every patch is computed in memory before anything is written.
  const plans = locateTargetFiles(packageRoot).map(({ target, file }) => {
    const source = fs.readFileSync(file, "utf8");
    const next = target.patch(source);
    return { target, file, relative: path.relative(packageRoot, file), source, next, changed: next !== source };
  });
  const changedCount = plans.filter((plan) => plan.changed).length;

  if (options.dryRun) {
    for (const plan of plans) console.log(`[${plan.changed ? "would-patch" : "ok"}] ${hotfixId}/${plan.target.id} ${plan.relative}`);
    console.log(`[${hotfixId}] dry-run changed=${changedCount}`);
    return;
  }

  if (changedCount === 0) {
    for (const plan of plans) console.log(`[ok] ${hotfixId}/${plan.target.id} ${plan.relative} (marker already present)`);
    console.log(`[${hotfixId}] complete changed=0`);
    return;
  }

  const backupDir = path.join(backupRoot, timestamp());
  for (const plan of plans) {
    if (!plan.changed) {
      console.log(`[ok] ${hotfixId}/${plan.target.id} ${plan.relative} (marker already present)`);
      continue;
    }
    const backupFile = path.join(backupDir, plan.relative);
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.copyFileSync(plan.file, backupFile);
    console.log(`[${hotfixId}] backup=${backupFile}`);

    const temporary = `${plan.file}.${hotfixId}-hotfix.tmp.mjs`;
    const mode = fs.statSync(plan.file).mode;
    fs.writeFileSync(temporary, plan.next, "utf8");
    fs.chmodSync(temporary, mode);
    try {
      nodeCheck(temporary);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      fail(`${error instanceof Error ? error.message : String(error)}\n[${hotfixId}] original bundle left untouched: ${plan.relative}`);
    }
    fs.renameSync(temporary, plan.file);
    try {
      nodeCheck(plan.file);
    } catch (error) {
      fs.copyFileSync(backupFile, plan.file);
      fail(`${error instanceof Error ? error.message : String(error)}\n[${hotfixId}] restored ${plan.relative} from ${backupFile}`);
    }
    console.log(`[patched] ${hotfixId}/${plan.target.id} ${plan.relative}`);
  }
  console.log(`[${hotfixId}] complete changed=${changedCount} — restart the OpenClaw gateway to activate`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(`[${hotfixId}] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
