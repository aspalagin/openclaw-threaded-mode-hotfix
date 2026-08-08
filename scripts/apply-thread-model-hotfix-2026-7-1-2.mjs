#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const expectedVersion = "2026.7.1-2";
const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/usr/lib/node_modules/openclaw";
const distDir = path.join(packageRoot, "dist");
const backupRoot = process.env.OPENCLAW_HOTFIX_BACKUP_DIR || "/root/openclaw-backups/openclaw-thread-model-hotfix";
const dryRun = process.argv.includes("--check") || process.argv.includes("--dry-run");

function fail(message) {
  throw new Error(message);
}

function walkJs(root) {
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(target);
    }
  }
  return files.sort();
}

function findOne(files, label, signatures) {
  const matches = files.filter((file) => {
    const content = fs.readFileSync(file, "utf8");
    return signatures.every((signature) => content.includes(signature));
  });
  if (matches.length !== 1) fail(`${label}: expected one matching bundle, found ${matches.length}`);
  return matches[0];
}

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) fail(`${label}: expected one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

function patchTelegramDmTopicModelIsolation(source) {
  if (source.includes("hotfix: telegram-dm-topic-model-isolation")) return source;
  return replaceOnce(
    source,
    "\tif (explicit && explicit !== params.sessionKey) return explicit;\n\tconst derived = resolveSessionParentSessionKey(params.sessionKey);",
    "\tif (explicit && explicit !== params.sessionKey) return explicit;\n\t// hotfix: telegram-dm-topic-model-isolation — topic model pins are session-local.\n\tif (typeof params.sessionKey === \"string\" && /^agent:[^:]+:telegram:direct:[^:]+:thread:/.test(params.sessionKey)) return null;\n\tconst derived = resolveSessionParentSessionKey(params.sessionKey);",
    "Telegram DM topic derived-parent model inheritance",
  );
}

function patchResetPreservedSelection(source) {
  if (source.includes("hotfix: new-clears-user-model-override")) return source;
  return replaceOnce(
    source,
    "\tif ((entry.modelOverrideSource === \"user\" || entry.modelOverrideSource === void 0 && Boolean(entry.modelOverride) && !recoveredAutoFallbackOverride) && entry.modelOverride) {",
    "\t// hotfix: new-clears-user-model-override — callers may request the configured model.\n\tif (params.preserveUserModelOverride !== false && (entry.modelOverrideSource === \"user\" || entry.modelOverrideSource === void 0 && Boolean(entry.modelOverride) && !recoveredAutoFallbackOverride) && entry.modelOverride) {",
    "reset-preserved user model selection guard",
  );
}

function patchNewClearsUserModelOverrideCall(source) {
  if (source.includes("hotfix: /new clears user model override")) return source;
  return replaceOnce(
    source,
    "\t\t\tconst preservedSelection = resolveResetPreservedSelection({ entry });",
    "\t\t\t// hotfix: /new clears user model override; /reset keeps it.\n\t\t\tconst preservedSelection = resolveResetPreservedSelection({\n\t\t\t\tentry,\n\t\t\t\tpreserveUserModelOverride: previousSessionEndReason !== \"new\"\n\t\t\t});",
    "/new reset-preserved selection call",
  );
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (packageJson.version !== expectedVersion) {
    fail(`unsupported OpenClaw version ${packageJson.version}; expected ${expectedVersion}`);
  }
  if (!fs.existsSync(distDir)) fail(`dist directory does not exist: ${distDir}`);

  const files = walkJs(distDir);
  const patches = [
    {
      id: "telegram-dm-topic-model-isolation",
      file: findOne(files, "stored model override bundle", [
        "function resolveParentSessionKeyCandidate(params)",
        "function resolveStoredModelOverride(params)",
        "source: \"parent\"",
      ]),
      transform: patchTelegramDmTopicModelIsolation,
    },
    {
      id: "new-clears-user-model-override-core",
      file: findOne(files, "reset-preserved selection bundle", [
        "function resolveResetPreservedSelection(params)",
        "recoveredAutoFallbackOverride",
        "preserved.modelOverrideSource = \"user\"",
      ]),
      transform: patchResetPreservedSelection,
    },
    {
      id: "new-clears-user-model-override-call",
      file: findOne(files, "get-reply session lifecycle bundle", [
        "const previousSessionEndReason = resetTriggered",
        "resolveResetPreservedSelection",
        "function resolveExplicitSessionEndReason",
      ]),
      transform: patchNewClearsUserModelOverrideCall,
    },
  ];

  const prepared = patches.map((patch) => {
    const source = fs.readFileSync(patch.file, "utf8");
    const next = patch.transform(source);
    return { ...patch, source, next, changed: next !== source };
  });
  const changed = prepared.filter((patch) => patch.changed);

  if (dryRun) {
    for (const patch of prepared) {
      console.log(`[${patch.changed ? "would-patch" : "ok"}] ${patch.id} ${path.relative(packageRoot, patch.file)}`);
    }
    console.log(`[thread-model-hotfix] dry-run changed=${changed.length}`);
    return;
  }

  if (changed.length > 0) {
    const backupDir = path.join(backupRoot, timestamp());
    fs.mkdirSync(backupDir, { recursive: true });
    for (const patch of changed) {
      const relative = path.relative(packageRoot, patch.file);
      const backupFile = path.join(backupDir, relative);
      fs.mkdirSync(path.dirname(backupFile), { recursive: true });
      fs.copyFileSync(patch.file, backupFile);
    }
    for (const patch of changed) {
      const mode = fs.statSync(patch.file).mode;
      const temporary = `${patch.file}.thread-model-hotfix.tmp`;
      fs.writeFileSync(temporary, patch.next, "utf8");
      fs.chmodSync(temporary, mode);
      fs.renameSync(temporary, patch.file);
      console.log(`[patched] ${patch.id} ${path.relative(packageRoot, patch.file)}`);
    }
    console.log(`[thread-model-hotfix] backup=${backupDir}`);
  }
  for (const patch of prepared.filter((item) => !item.changed)) {
    console.log(`[ok] ${patch.id} ${path.relative(packageRoot, patch.file)}`);
  }
  console.log(`[thread-model-hotfix] complete changed=${changed.length}`);
}

try {
  main();
} catch (error) {
  console.error(`[thread-model-hotfix] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
