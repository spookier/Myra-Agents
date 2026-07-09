#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

const isDryRun = process.argv.includes("--dry-run");

function run(cmd, args) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function out(label, value) {
  if (value?.trim()) {
    console.log(`${label}: ${value.trim()}`);
  }
}

const ghVersion = run("gh", ["--version"]);
if (ghVersion.status !== 0) {
  console.error("GitHub CLI (`gh`) is not installed or not on PATH.");
  process.exit(1);
}

const loginRes = run("gh", ["api", "user", "--jq", ".login"]);
const currentLogin = loginRes.status === 0 ? loginRes.stdout.trim() : "";

if (!currentLogin) {
  console.log("No active `gh` login found. The app should already show Sign in with GitHub.");
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    console.log("Detected GH_TOKEN/GITHUB_TOKEN in environment. Clear it before demo if sign-in still appears active.");
  }
  process.exit(0);
}

if (isDryRun) {
  console.log(`[dry-run] Would log out GitHub user: ${currentLogin}`);
  process.exit(0);
}

console.log(`Logging out GitHub user: ${currentLogin}`);
const logoutRes = run("gh", ["auth", "logout", "--hostname", "github.com", "--user", currentLogin]);
out("gh auth logout stdout", logoutRes.stdout);
out("gh auth logout stderr", logoutRes.stderr);

if (logoutRes.status !== 0) {
  console.error("`gh auth logout` failed.");
  process.exit(logoutRes.status ?? 1);
}

const verifyRes = run("gh", ["api", "user", "--jq", ".login"]);
if (verifyRes.status === 0 && verifyRes.stdout.trim()) {
  console.log(`Still authenticated as ${verifyRes.stdout.trim()}.`);
  console.log("If this is a demo environment, clear GH_TOKEN/GITHUB_TOKEN and relaunch the app.");
  process.exit(2);
}

console.log("GitHub login reset complete. Reopen Settings and the button should show Sign in with GitHub.");
