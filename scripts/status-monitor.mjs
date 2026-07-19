#!/usr/bin/env node
/**
 * Outage monitor for the out-of-band status channel.
 *
 * Runs on a schedule (GitHub Actions). Health-checks the Supabase backend and
 * updates status.json with hysteresis so transient blips don't flap the status.
 * A human-set maintenance (manualHold=true) always wins and is left untouched.
 *
 * The app reads status.json from GitHub raw (independent of Supabase), so this
 * keeps working even during a Supabase outage.
 *
 * Env:
 *   SUPABASE_URL         (required) e.g. https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY    (required) anon key (safe; used only as apikey header)
 *   OPEN_THRESHOLD       consecutive failures before opening   (default 2)
 *   CLOSE_THRESHOLD      consecutive successes before clearing (default 2)
 *   AUTO_MODE            mode to set on outage: maintenance|degraded (default maintenance)
 *   STATUS_FILE          path to status.json (default ./status.json)
 */

import { readFile, writeFile } from "node:fs/promises";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OPEN_THRESHOLD = Number(process.env.OPEN_THRESHOLD ?? 2);
const CLOSE_THRESHOLD = Number(process.env.CLOSE_THRESHOLD ?? 2);
const AUTO_MODE = process.env.AUTO_MODE === "degraded" ? "degraded" : "maintenance";
const STATUS_FILE = process.env.STATUS_FILE ?? "status.json";

const AUTO_TITLE = "We'll be right back";
const AUTO_MESSAGE =
  "We're experiencing a temporary service disruption and are working to restore it. Please try again shortly.";

if (!SUPABASE_URL) {
  console.error("SUPABASE_URL is required");
  process.exit(1);
}

async function ping(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    // Any resolved response (even 4xx) means the endpoint is reachable.
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function isBackendHealthy() {
  const headers = SUPABASE_ANON_KEY ? { apikey: SUPABASE_ANON_KEY } : undefined;
  // Two independent signals; healthy only if both are reachable.
  const [auth, rest] = await Promise.all([
    ping(`${SUPABASE_URL}/auth/v1/health`, { headers }),
    ping(`${SUPABASE_URL}/rest/v1/`, { headers }),
  ]);
  return auth && rest;
}

function defaultStatus() {
  return {
    mode: "ok",
    title: "",
    message: "",
    updatedAt: new Date().toISOString(),
    source: "auto",
    manualHold: false,
    monitor: { failStreak: 0, okStreak: 0, lastCheckAt: "" },
  };
}

async function main() {
  let status;
  try {
    status = JSON.parse(await readFile(STATUS_FILE, "utf8"));
  } catch {
    status = defaultStatus();
  }
  status.monitor = status.monitor ?? { failStreak: 0, okStreak: 0, lastCheckAt: "" };

  const before = JSON.stringify(status);
  const now = new Date().toISOString();
  status.monitor.lastCheckAt = now;

  // Manual override always wins — never touch the mode a human set.
  if (status.manualHold === true) {
    console.log("manualHold is set; leaving status untouched.");
    await writeIfChanged(before, status);
    return;
  }

  const healthy = await isBackendHealthy();
  console.log(`health: ${healthy ? "OK" : "DOWN"}`);

  if (healthy) {
    status.monitor.okStreak = (status.monitor.okStreak ?? 0) + 1;
    status.monitor.failStreak = 0;
    if (status.mode !== "ok" && status.monitor.okStreak >= CLOSE_THRESHOLD) {
      status.mode = "ok";
      status.title = "";
      status.message = "";
      status.source = "auto";
      status.updatedAt = now;
      console.log("Backend recovered — cleared status.");
    }
  } else {
    status.monitor.failStreak = (status.monitor.failStreak ?? 0) + 1;
    status.monitor.okStreak = 0;
    if (status.mode !== AUTO_MODE && status.monitor.failStreak >= OPEN_THRESHOLD) {
      status.mode = AUTO_MODE;
      status.title = AUTO_TITLE;
      status.message = AUTO_MESSAGE;
      status.source = "auto";
      status.updatedAt = now;
      console.log(`Outage detected — set mode=${AUTO_MODE}.`);
    }
  }

  await writeIfChanged(before, status);
}

async function writeIfChanged(before, status) {
  const after = JSON.stringify(status);
  if (after === before) {
    console.log("No change.");
    return;
  }
  await writeFile(STATUS_FILE, JSON.stringify(status, null, 2) + "\n", "utf8");
  console.log("status.json updated.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
