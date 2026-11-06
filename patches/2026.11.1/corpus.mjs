// Locate Gateway bundles by unique code signatures; updater and worker copies are outside this patch.
import fs from "node:fs";
import path from "node:path";
export const EXCLUDED_DIST_FILES = new Set(["package-update-activation-recovery.mjs"]);
export function walkJs(dir) { const out = []; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory() && !(path.basename(dir) === "dist" && e.name === "worker")) out.push(...walkJs(f)); else if (e.isFile() && /\.(?:js|mjs)$/.test(e.name) && !EXCLUDED_DIST_FILES.has(e.name)) out.push(f); } return out; }
export class Corpus {
  constructor(files) { this.files = files; this.cache = new Map(); }
  read(f) { let c = this.cache.get(f); if (c === undefined) { c = fs.readFileSync(f, "utf8"); this.cache.set(f, c); } return c; }
  findOne(label, needles) { const m = this.files.filter((f) => needles.every((n) => this.read(f).includes(n))); if (m.length === 0) throw new Error(`could not find ${label}`); if (m.length > 1) throw new Error(`found multiple ${label}: ${m.join(", ")}`); return m[0]; }
  locate(target) { if (target.needleSets) { const errs = []; for (const n of target.needleSets) { try { return this.findOne(target.label, n); } catch (e) { errs.push(e.message); } } throw new Error(`${target.label}: ${errs.join("; ")}`); } return this.findOne(target.label, target.needles); }
  assertionsPass(mod, file) { const as = mod.check?.assertions ?? []; if (!as.length) return false; const c = this.read(file); return as.every((a) => a(c, file) === null); }
  locateModule(mod, hint = null) {
    try { return { file: this.locate(mod.target), via: "needles" }; } catch (e) {
      if (!/could not find/.test(e.message)) throw e;
      if (hint && this.assertionsPass(mod, hint)) return { file: hint, via: "hint+assertions" };
      const m = this.files.filter((f) => this.assertionsPass(mod, f));
      if (m.length === 1) return { file: m[0], via: "assertions" };
      throw new Error(`${e.message}; already-patched fallback: ${m.length === 0 ? "no file passes module assertions" : `multiple files pass assertions: ${m.map((f) => path.basename(f)).join(", ")}`}`);
    }
  }
}
