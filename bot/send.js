#!/usr/bin/env node
// Message the user from inside Claude: `node send.js "text"` (or the text on stdin).
// It only queues the message in the outbox; the bot, which holds the Telegram token, sends it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enqueue, defaultStateDir } from "./outbox.js";

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const text = (process.argv.slice(2).join(" ") || (await readStdin())).trim();
if (!text) {
  console.error('Nothing to send. Usage: node send.js "your message"');
  process.exit(1);
}
const stateDir = defaultStateDir();
enqueue(stateDir, text);

// Inside a background worker: leave a mark so the supervisor knows the user already heard back.
const job = process.env.CLAUDE_PHONE_JOB;
if (/^j\d+$/.test(job ?? "")) {
  mkdirSync(join(stateDir, "jobs"), { recursive: true });
  writeFileSync(join(stateDir, "jobs", `${job}.sent`), "");
}
console.log("queued");
