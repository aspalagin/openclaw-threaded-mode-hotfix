#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const expectedVersion = "2026.7.1-2";
const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/usr/lib/node_modules/openclaw";
const distDir = path.join(packageRoot, "dist");

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
  if (matches.length !== 1) throw new Error(`${label}: expected one matching bundle, found ${matches.length}`);
  return { file: matches[0], content: fs.readFileSync(matches[0], "utf8") };
}

function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (packageJson.version !== expectedVersion) {
    throw new Error(`unsupported OpenClaw version ${packageJson.version}; expected ${expectedVersion}`);
  }
  const files = walkJs(distDir);
  const checks = [
    {
      id: "telegram-dm-topic-model-isolation",
      target: findOne(files, "stored model override bundle", [
        "function resolveParentSessionKeyCandidate(params)",
        "function resolveStoredModelOverride(params)",
        "source: \"parent\"",
      ]),
      expected: [
        "hotfix: telegram-dm-topic-model-isolation",
        "/^agent:[^:]+:telegram:direct:[^:]+:thread:/.test(params.sessionKey)",
        "if (explicit && explicit !== params.sessionKey) return explicit;",
      ],
    },
    {
      id: "new-clears-user-model-override-core",
      target: findOne(files, "reset-preserved selection bundle", [
        "function resolveResetPreservedSelection(params)",
        "recoveredAutoFallbackOverride",
        "preserved.modelOverrideSource = \"user\"",
      ]),
      expected: [
        "hotfix: new-clears-user-model-override",
        "params.preserveUserModelOverride !== false",
      ],
    },
    {
      id: "new-clears-user-model-override-call",
      target: findOne(files, "get-reply session lifecycle bundle", [
        "const previousSessionEndReason = resetTriggered",
        "function resolveExplicitSessionEndReason",
        "preserveUserModelOverride: previousSessionEndReason",
      ]),
      expected: [
        "hotfix: /new clears user model override",
        "preserveUserModelOverride: previousSessionEndReason !== \"new\"",
      ],
    },
  ];

  let failed = 0;
  for (const check of checks) {
    const missing = check.expected.filter((signature) => !check.target.content.includes(signature));
    if (missing.length > 0) {
      failed += 1;
      console.log(`[fail] ${check.id} ${path.relative(packageRoot, check.target.file)}`);
      for (const signature of missing) console.log(`  - missing: ${signature}`);
    } else {
      console.log(`[ok] ${check.id} ${path.relative(packageRoot, check.target.file)}`);
    }
  }
  console.log(`[thread-model-hotfix-check] required_ok=${checks.length - failed} required_failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`[thread-model-hotfix-check] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
