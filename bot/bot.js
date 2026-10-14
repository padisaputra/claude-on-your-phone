// Telegram front-end for the agent in agent.js. No dependencies, Node 20+.
// This file only does Telegram: polling, the allowlist, typing, splitting, and the background loops (outbox, workers, schedules).

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitMessage, parseAllowlist, isAllowed } from "./lib.js";
import { createAgent } from "./agent.js";
import { makeClaudeRunner, stopAllClaude } from "./claude.js";
import { createUsage } from "./usage.js";
import { createJobs } from "./jobs.js";
import { createScheduler } from "./scheduler.js";
import { drain } from "./outbox.js";
import { createRouter } from "./router.js";

const EX_CONFIG = 78; // systemd is told not to restart on this code (see the unit file)

function fail(msg, code = EX_CONFIG) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(code);
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!TOKEN || TOKEN.includes("paste")) {
  fail("TELEGRAM_BOT_TOKEN is not set. Get one from @BotFather in Telegram, put it in .env, then restart.");
}
const ALLOWED = parseAllowlist(process.env.ALLOWED_USER_IDS);
if (ALLOWED.size === 0) {
  fail("ALLOWED_USER_IDS is not set. Message @userinfobot in Telegram to get your numeric ID, put it in .env, then restart.");
}
// A private chat id equals the user id, so the first allowed id is where proactive messages go.
const OWNER_CHAT = [...ALLOWED][0];

const WORKDIR = process.env.WORKDIR || join(homedir(), "workspace");
const APP_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.CLAUDE_PHONE_STATE || join(homedir(), ".claude-phone");
// Claude (and the workers it starts) find the helper scripts and the state folder through these.
process.env.CLAUDE_PHONE_STATE = STATE_DIR;
process.env.CLAUDE_PHONE_APP = APP_DIR;
process.env.WORKDIR = WORKDIR;

const num = (v, d) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Number(v)); // 0 is a valid setting
const on = (v) => String(v ?? "on").toLowerCase() !== "off";

const usage = createUsage({
  stateDir: STATE_DIR,
  limit5h: num(process.env.USAGE_LIMIT_5H, undefined),
  limitWeek: num(process.env.USAGE_LIMIT_WEEK, undefined),
});
const runClaude = makeClaudeRunner({
  workdir: WORKDIR,
  permissionMode: process.env.CLAUDE_PERMISSION_MODE || "acceptEdits",
  allowedTools: process.env.CLAUDE_ALLOWED_TOOLS || "Bash,Read,Edit,Write,Glob,Grep",
  timeoutMs: num(process.env.CLAUDE_TIMEOUT_MINUTES, 20) * 60_000,
});
const agent = createAgent({
  workdir: WORKDIR,
  stateDir: STATE_DIR,
  maxTurns: num(process.env.SESSION_MAX_TURNS, 40),
  contextWindow: num(process.env.CONTEXT_WINDOW, 200_000),
  rotateAt: num(process.env.ROTATE_AT, 0.6),
  idleHours: num(process.env.IDLE_HOURS, 6),
  recentKeep: num(process.env.RECENT_KEEP, 6),
  runClaude: async (call) => {
    const res = await runClaude(call);
    if (res.usage) usage.record(res.usage); // every chat turn counts toward the plan-usage guard
    return res;
  },
});
const jobs = createJobs({ stateDir: STATE_DIR, appDir: APP_DIR, workdir: WORKDIR, usage });
const scheduler = createScheduler({
  stateDir: STATE_DIR,
  workdir: WORKDIR,
  oneShot: agent.oneShot,
  addContext: agent.addContext,
  lastUserAt: agent.lastUserAt,
  notify: (text) => send(OWNER_CHAT, text),
  jobs,
  usage,
  config: {
    chatKey: String(OWNER_CHAT),
    nightlyOn: on(process.env.NIGHTLY),
    nightlyAt: process.env.NIGHTLY_AT || "03:00",
    heartbeatOn: on(process.env.HEARTBEAT),
    heartbeatEveryMin: num(process.env.HEARTBEAT_EVERY_MIN, 30),
    heartbeatHours: process.env.HEARTBEAT_HOURS || "09:00-22:00",
    heartbeatMaxPerDay: num(process.env.HEARTBEAT_MAX_PER_DAY, 3),
    morningAt: process.env.MORNING_AT || "08:30",
  },
});
const route = createRouter({ agent, jobs, scheduler, usage });
const API = `${process.env.TELEGRAM_API_BASE || "https://api.telegram.org"}/bot${TOKEN}`; // base is only overridden in tests

async function tg(method, body, retried = false) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000), // long polling waits 30s, so this only catches dead connections
  });
  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!data.ok && data.error_code === 429 && !retried) {
    await new Promise((r) => setTimeout(r, (data.parameters?.retry_after ?? 5) * 1000));
    return tg(method, body, true);
  }
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

async function send(chatId, text) {
  for (const part of splitMessage(text)) {
    await tg("sendMessage", { chat_id: chatId, text: part });
  }
}

// Ask the agent, showing "typing..." until it answers. Replies go out in order, one chain per chat.
// There is no per-chat queue on purpose: a message sent mid-turn gets the agent's fast lane.
const sendChains = new Map();
function sendInOrder(chatId, text) {
  const next = (sendChains.get(chatId) ?? Promise.resolve()).then(() => send(chatId, text));
  sendChains.set(chatId, next.catch(() => {}));
  return next;
}

async function ask(chatId, text) {
  const typing = setInterval(() => tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}), 4000);
  tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  try {
    await route(String(chatId), text, (reply) => sendInOrder(chatId, reply));
  } catch (e) {
    console.error(e);
    await sendInOrder(chatId, "Something went wrong. Check the server logs.").catch(() => {});
  } finally {
    clearInterval(typing);
  }
}

// Background loops: outbox (what workers and helper scripts want to say), workers, schedules, usage notices.
// Each loop skips a beat if the last one is still running.
function every(ms, fn) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(e.message);
    } finally {
      running = false;
    }
  }, ms).unref();
}

function startBackgroundLoops() {
  every(2_000, () => drain(STATE_DIR, async (text) => {
    await sendInOrder(OWNER_CHAT, text);
    agent.addContext(String(OWNER_CHAT), `[sent to the user: ${text.slice(0, 1500)}]`); // so "thanks" or "tweak it" makes sense
  }));
  every(15_000, async () => {
    await jobs.tick();
    for (const t of usage.newlyCrossed()) {
      await sendInOrder(OWNER_CHAT, t >= 80
        ? "Heads up: plan usage is past 80%. Background workers are paused so our chat keeps working. They resume when usage drops."
        : "Heads up: plan usage is past 60%. New background workers will wait in line until it drops. Chat is unaffected.");
    }
  });
  every(30_000, () => scheduler.tick());
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopAllClaude();
    process.exit(0);
  });
}

async function main() {
  let me;
  try {
    me = await tg("getMe", {});
  } catch (e) {
    // A bad token is a config problem (no restart). A network blip at boot should be retried by systemd.
    const bad = /unauthorized/i.test(e.message);
    fail(bad ? "Telegram rejected TELEGRAM_BOT_TOKEN. Check it in .env." : e.message, bad ? EX_CONFIG : 1);
  }
  console.log(`Connected as @${me.username}. Allowed user IDs: ${[...ALLOWED].join(", ")}. Working in ${WORKDIR}`);
  startBackgroundLoops();
  let offset = 0;
  for (;;) {
    let updates = [];
    try {
      updates = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
    } catch (e) {
      console.error(e.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      if (!isAllowed(u.message, ALLOWED)) {
        if (u.message) console.warn(`Ignored message from user ${u.message.from?.id}`);
        continue;
      }
      const chatId = u.message.chat.id;
      if (u.message.text) ask(chatId, u.message.text);
      else sendInOrder(chatId, "I only understand text for now.").catch((e) => console.error(e.message));
    }
  }
}

main().catch((e) => fail(e.message, 1));
