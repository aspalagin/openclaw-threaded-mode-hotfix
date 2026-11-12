#!/usr/bin/env node
import { main } from "./hotfix-2026-11-1.mjs";
try { await main(true, "2026.11.3"); } catch (error) { console.error(error.message); process.exitCode = 1; }
