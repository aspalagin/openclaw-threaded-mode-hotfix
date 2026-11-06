import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepare, optionsFromArgs, resolvePackageRoot } from "./hotfix-2026-11-1.mjs";

export { assert, fs, path, vm };
export const root = resolvePackageRoot(optionsFromArgs());
export const prepared = await prepare(root);
export const sourceFor = (name) => prepared.find((entry) => entry.modules.some((mod) => mod.name === name)).after;
export function functionSource(source, name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}
export function regionSource(source, marker) {
  const start = source.indexOf("//#region " + marker);
  const end = source.indexOf("//#endregion", start);
  assert.ok(start >= 0 && end > start, `missing region ${marker}`);
  return source.slice(start, end);
}

// Exercise the real CLI on a disposable copy of its targets, never the input package.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hotfix-11.1-test-"));
try {
  const copy = path.join(temporary, "package");
  fs.mkdirSync(copy);
  fs.copyFileSync(path.join(root, "package.json"), path.join(copy, "package.json"));
  for (const entry of prepared) {
    const file = path.join(copy, path.relative(root, entry.file));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.before);
  }
  const snapshot = () => prepared.map((entry) => fs.readFileSync(path.join(copy, path.relative(root, entry.file)), "utf8"));
  const before = snapshot();
  const run = (script, args = [], expected = 0) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), "--package-root", copy, ...args], { encoding: "utf8" });
    if (result.error) throw result.error;
    assert.equal(result.status, expected, result.stderr || result.stdout);
    return result.stdout;
  };
  // A drifted last target must fail before any earlier target is replaced.
  const last = path.join(copy, path.relative(root, prepared.at(-1).file));
  fs.writeFileSync(last, "export {};\n");
  const drifted = snapshot();
  run("./apply-2026-11-1.mjs", [], 1);
  assert.deepEqual(snapshot(), drifted, "failed planning changed another target");
  fs.writeFileSync(last, prepared.at(-1).before);
  run("./apply-2026-11-1.mjs", ["--dry-run"]);
  assert.deepEqual(snapshot(), before, "dry-run changed a target");
  const wasVanilla = prepared.some((entry) => entry.before !== entry.after);
  run("./check-2026-11-1.mjs", [], wasVanilla ? 1 : 0);
  run("./apply-2026-11-1.mjs", ["--backup-dir", path.join(temporary, "backups")]);
  run("./check-2026-11-1.mjs");
  assert.match(run("./apply-2026-11-1.mjs"), /complete changed=0/);
  assert.deepEqual(snapshot(), prepared.map((entry) => entry.after), "CLI output differs from verified patch");
  const beforeGuard = snapshot();
  fs.writeFileSync(path.join(copy, "package.json"), '{"name":"openclaw","version":"0.0.0"}');
  run("./apply-2026-11-1.mjs", [], 1);
  run("./check-2026-11-1.mjs", [], 1);
  assert.deepEqual(snapshot(), beforeGuard, "version guard changed a target");
  console.log("PASS: non-writing dry-run, vanilla check, apply/check, idempotence, version guard");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
