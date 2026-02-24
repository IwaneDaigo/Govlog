#!/usr/bin/env node
// Cross-platform script runner: picks .ps1 on Windows, .sh on others
const { spawnSync } = require("child_process");
const { platform } = require("os");
const path = require("path");

const name = process.argv[2];
if (!name) { console.error("Usage: node scripts/run.js <script-name>"); process.exit(1); }

const isWin = platform() === "win32";
const ext = isWin ? ".ps1" : ".sh";
const file = path.join(__dirname, name + ext);

const result = isWin
  ? spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], { stdio: "inherit" })
  : spawnSync("bash", [file], { stdio: "inherit" });

process.exit(result.status ?? 0);
