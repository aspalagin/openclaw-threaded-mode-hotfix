import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Corpus, walkJs } from "../patches/2026.11.1/corpus.mjs";
import { modules } from "../patches/2026.11.1/plan.mjs";

export const expectedVersion = "2026.11.1";

export function optionsFromArgs(argv = process.argv.slice(2)) {
  const options = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--package-root" || arg === "--backup-dir") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`missing value for ${arg}`);
      options[arg === "--package-root" ? "packageRoot" : "backupDir"] = argv[++i];
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function resolvePackageRoot(options) {
  if (options.packageRoot || process.env.OPENCLAW_PACKAGE_ROOT) return path.resolve(options.packageRoot || process.env.OPENCLAW_PACKAGE_ROOT);
  const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8" });
  if (npm.error) throw npm.error;
  if (npm.status !== 0 || !npm.stdout.trim()) throw new Error("pass --package-root or set OPENCLAW_PACKAGE_ROOT");
  return path.join(npm.stdout.trim(), "openclaw");
}

export function assertVersion(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (pkg.name !== "openclaw" || pkg.version !== expectedVersion) {
    throw new Error(`unsupported package ${pkg.name}@${pkg.version}; expected openclaw@${expectedVersion}`);
  }
}

export function checkSyntax(source, label) {
  const result = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: source, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label}: syntax check failed: ${result.stderr || result.stdout}`);
}

export async function prepare(root, checkOnly = false) {
  assertVersion(root);
  const corpus = new Corpus(walkJs(path.join(root, "dist")));
  const files = new Map();
  for (const name of modules) {
    const mod = await import(new URL(`../patches/2026.11.1/ports/${name}.mjs`, import.meta.url));
    const { file } = corpus.locateModule(mod);
    let entry = files.get(file);
    if (!entry) {
      const before = corpus.read(file);
      entry = { file, before, after: before, modules: [] };
      files.set(file, entry);
    }
    if (!checkOnly) {
      entry.after = mod.patch(entry.after);
      if (mod.patch(entry.after) !== entry.after) throw new Error(`${name}: patch is not idempotent`);
    }
    entry.modules.push({ name, mod });
  }
  for (const entry of files.values()) {
    for (const { name, mod } of entry.modules) {
      for (const assertion of mod.check.assertions) {
        const error = assertion(entry.after, entry.file);
        if (error) throw new Error(`${name}: ${error}`);
      }
    }
    checkSyntax(entry.after, entry.file);
  }
  return [...files.values()];
}

export async function main(checkOnly = false) {
  const options = optionsFromArgs();
  if (options.help) {
    console.log("Usage: node scripts/" + (checkOnly ? "check" : "apply") + "-2026-11-1.mjs [--package-root DIR] [--backup-dir DIR] [--dry-run]");
    return;
  }
  const root = resolvePackageRoot(options);
  const entries = await prepare(root, checkOnly);
  const changed = entries.filter((entry) => entry.before !== entry.after);
  for (const entry of entries) console.log(`[${entry.before === entry.after ? "ok" : "would-patch"}] ${path.relative(root, entry.file)}`);
  if (checkOnly || options.dryRun || changed.length === 0) {
    console.log(`${checkOnly ? "check passed" : options.dryRun ? "dry-run" : "complete"} changed=${changed.length}`);
    return;
  }
  const backupRoot = path.resolve(options.backupDir || process.env.OPENCLAW_HOTFIX_BACKUP_DIR || "openclaw-hotfix-backups");
  const backup = path.join(backupRoot, `2026.11.1-${Date.now()}-${process.pid}`);
  // Compute, validate and back up every file before replacing any bundle.
  for (const entry of changed) {
    entry.backup = path.join(backup, path.relative(root, entry.file));
    entry.temporary = `${entry.file}.hotfix-${process.pid}.tmp.mjs`;
    fs.mkdirSync(path.dirname(entry.backup), { recursive: true });
    fs.copyFileSync(entry.file, entry.backup, fs.constants.COPYFILE_EXCL);
  }
  const written = [];
  try {
    for (const entry of changed) {
      fs.writeFileSync(entry.temporary, entry.after, { flag: "wx", mode: fs.statSync(entry.file).mode });
      fs.renameSync(entry.temporary, entry.file);
      written.push(entry);
    }
  } catch (error) {
    for (const entry of written) fs.copyFileSync(entry.backup, entry.file);
    throw error;
  } finally {
    for (const entry of changed) fs.rmSync(entry.temporary, { force: true });
  }
  console.log(`backup=${backup}`);
  console.log(`complete changed=${changed.length} — restart the gateway to activate`);
}
