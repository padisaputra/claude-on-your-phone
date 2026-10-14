#!/usr/bin/env node
// Background workers from the command line. The agent calls this (via Bash) to hand off long tasks:
//   node worker.js start --title "Flight research" --brief-file /tmp/brief.md   (or the brief on stdin)
//   node worker.js list
//   node worker.js stop j3
// `_run <id>` is internal: the detached supervisor that jobs.js starts for each job.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createJobs, runWorker } from "./jobs.js";
import { createUsage } from "./usage.js";
import { defaultStateDir } from "./outbox.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const stateDir = flag("state") || defaultStateDir();

function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

if (cmd === "_run") {
  const ok = await runWorker({ stateDir, id: rest[0] });
  process.exit(ok ? 0 : 1);
}

const usage = createUsage({ stateDir, limit5h: process.env.USAGE_LIMIT_5H, limitWeek: process.env.USAGE_LIMIT_WEEK });
const jobs = createJobs({
  stateDir,
  appDir: process.env.CLAUDE_PHONE_APP || dirname(fileURLToPath(import.meta.url)),
  workdir: process.env.WORKDIR || process.cwd(),
  usage,
});

if (cmd === "start") {
  const file = flag("brief-file");
  let brief;
  try {
    brief = file ? readFileSync(file, "utf8") : await readStdin();
  } catch (e) {
    die(`Could not read the brief: ${e.message}`);
  }
  if (!brief.trim()) die('Empty brief. Usage: node worker.js start --title "T" --brief-file F');
  const { id, status } = jobs.start({ title: flag("title"), brief });
  console.log(status === "running" ? `started ${id}`
    : status === "queued" && usage.level() !== "ok" ? `queued ${id}, will start when plan usage drops`
    : status === "queued" ? `queued ${id}, will start when a running job finishes`
    : `${id} could not start, see /jobs`);
} else if (cmd === "list") {
  console.log(jobs.format());
} else if (cmd === "stop") {
  if (!rest[0]) die("Usage: node worker.js stop <id>");
  console.log(jobs.stop(rest[0]) ? `stopped ${rest[0]}` : `no running job called ${rest[0]}`);
} else {
  die('Usage: node worker.js start --title "T" --brief-file F | list | stop <id>');
}
