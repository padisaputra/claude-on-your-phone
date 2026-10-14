// Background workers. Anything that takes more than a minute or two runs as its own detached
// `claude -p` process, so the main chat stays free. The registry is jobs.json in the state dir;
// the bot, the worker.js CLI and every worker supervisor all edit it, always under a lock.
//
// Process layout per job:  supervisor (node worker.js _run jN, its own process group)  ->  claude -p
// Signals always go to the whole group (-pid) and only to a pid recorded here, after checking that
// it still is our supervisor. Nothing is ever killed by name.
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson, withLock, enqueue } from "./outbox.js";
import { createUsage } from "./usage.js";

const ACTIVE = new Set(["queued", "running", "paused"]);
const KEEP_FINISHED = 30;
const KILL_AFTER_MS = 10_000; // SIGTERM first so claude can stop cleanly, SIGKILL if it hasn't

function footer(id, appDir) {
  return `

---
You are a background worker (job ${id}). Nobody is watching this run live.
- Do the task above end to end. Never stop to ask the user a question; make a sensible choice and say which.
- Write anything worth keeping (findings, drafts, data) to files in the workspace, and mention where.
- When finished, message the user once: node "${join(appDir, "send.js")}" "<short plain result>"
- If you get stuck, send what you have and what blocked you the same way.
`;
}

// Is this pid still our supervisor for this job? A dead pid, a zombie, or a pid the OS has
// reused for something else (after a reboot, say) all answer no.
function defaultProbe(job, stateDir) {
  if (!job.pid) return false;
  try { process.kill(job.pid, 0); } catch (e) { if (e.code !== "EPERM") return false; }
  try {
    const cmd = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(job.pid)], { encoding: "utf8" });
    return cmd.includes(`_run ${job.id} --state ${stateDir}`);
  } catch (e) {
    return e.code === "ENOENT"; // no ps on this box: the kill(0) check above is all we have
  }
}

function defaultSignal(pid, sig) {
  try { process.kill(-pid, sig); return true; } catch { return false; }
}

const ago = (ms) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

export function createJobs({
  stateDir, appDir, workdir, usage, now = () => Date.now(), spawn = nodeSpawn,
  maxWorkers = Number(process.env.MAX_WORKERS) || 3,
  probe = (job) => defaultProbe(job, stateDir),
  signal = defaultSignal,
}) {
  const dir = join(stateDir, "jobs");
  mkdirSync(dir, { recursive: true });
  const file = join(stateDir, "jobs.json");

  const load = () => {
    const r = readJson(file, null);
    return { jobs: Array.isArray(r?.jobs) ? r.jobs : [] };
  };
  const save = (reg) => {
    const done = reg.jobs.filter((j) => !ACTIVE.has(j.status));
    const drop = new Set(done.slice(0, Math.max(0, done.length - KEEP_FINISHED)));
    reg.jobs = reg.jobs.filter((j) => !drop.has(j));
    writeJson(file, reg);
  };
  // Every change is: lock, re-read from disk, change, write. Never from a stale copy.
  const edit = (fn) => withLock(file, () => { const reg = load(); const out = fn(reg); save(reg); return out; });

  // Ids keep counting up even if jobs.json was lost, so a new job never overwrites an old log.
  function nextId(reg) {
    let max = 0;
    const bump = (s) => { const m = /^j(\d+)/.exec(s); if (m) max = Math.max(max, Number(m[1])); };
    reg.jobs.forEach((j) => bump(j.id));
    readdirSync(dir).forEach(bump);
    return `j${max + 1}`;
  }

  function launch(job) {
    const env = { ...process.env, CLAUDE_PHONE_STATE: stateDir, CLAUDE_PHONE_APP: appDir, WORKDIR: workdir };
    delete env.TELEGRAM_BOT_TOKEN;
    try {
      const child = spawn(process.execPath, [join(appDir, "worker.js"), "_run", job.id, "--state", stateDir],
        { cwd: workdir, env, detached: true, stdio: "ignore" });
      child.on?.("error", () => {}); // reaped as failed by tick() if it never came up
      child.unref?.();
      if (!child.pid) throw new Error("no pid");
      Object.assign(job, { status: "running", pid: child.pid, startedAt: now() });
    } catch (e) {
      Object.assign(job, { status: "failed", finishedAt: now(), error: `could not start: ${e.message}` });
    }
  }

  const running = (reg) => reg.jobs.filter((j) => j.status === "running").length;

  function start({ title, brief }) {
    brief = String(brief ?? "").trim();
    if (!brief) throw new Error("empty brief");
    title = String(title || brief.split("\n")[0]).trim().slice(0, 80);
    const level = usage.level();
    return edit((reg) => {
      const id = nextId(reg);
      writeFileSync(join(dir, `${id}.brief.md`), brief + footer(id, appDir));
      const job = { id, title, status: "queued", pid: null, createdAt: now(), startedAt: null, finishedAt: null };
      reg.jobs.push(job);
      if (level === "ok" && running(reg) < maxWorkers) launch(job);
      return { id, status: job.status };
    });
  }

  function list() {
    return load().jobs.map(({ id, title, status, pid, startedAt, finishedAt, error }) =>
      ({ id, title, status, pid, startedAt, finishedAt, ...(error ? { error } : {}) }));
  }

  function stop(id) {
    return edit((reg) => {
      const job = reg.jobs.find((j) => j.id === id);
      if (!job || !ACTIVE.has(job.status)) return false;
      if (job.status !== "queued" && probe(job)) {
        signal(job.pid, "SIGTERM");
        signal(job.pid, "SIGCONT"); // a paused group can't act on SIGTERM until it runs again
        job.killAt = now() + KILL_AFTER_MS;
      }
      Object.assign(job, { status: "stopped", finishedAt: now() });
      return true;
    });
  }

  // Called by the bot every ~15s.
  function tick() {
    const level = usage.level();
    const notices = [];
    edit((reg) => {
      for (const job of reg.jobs) {
        if ((job.status === "running" || job.status === "paused") && !probe(job)) {
          // The supervisor marks done/failed itself before exiting, so a gone pid here means it crashed.
          Object.assign(job, { status: "failed", finishedAt: now(), error: "the worker process died" });
          notices.push(`Job ${job.id} (${job.title}) stopped unexpectedly: the worker process died. Log: jobs/${job.id}.log`);
        } else if (job.status === "stopped" && job.killAt && now() >= job.killAt) {
          if (probe(job)) signal(job.pid, "SIGKILL");
          delete job.killAt;
        }
      }
      if (level === "pause") {
        for (const job of reg.jobs.filter((j) => j.status === "running")) {
          if (signal(job.pid, "SIGSTOP")) job.status = "paused";
        }
      } else if (level === "ok") {
        for (const job of reg.jobs.filter((j) => j.status === "paused")) {
          if (signal(job.pid, "SIGCONT")) job.status = "running";
        }
        for (const job of reg.jobs.filter((j) => j.status === "queued")) {
          if (running(reg) >= maxWorkers) break;
          launch(job);
        }
      }
      // "queue": nothing new starts and paused jobs stay paused until usage is clearly back down.
    });
    for (const text of notices) enqueue(stateDir, text);
  }

  function format() {
    const jobs = list();
    if (!jobs.length) return "No background jobs yet.";
    const t = now();
    const active = jobs.filter((j) => ACTIVE.has(j.status));
    const recent = jobs.filter((j) => !ACTIVE.has(j.status)).slice(-5).reverse();
    const lines = [];
    if (active.length) {
      lines.push("Background jobs:");
      for (const j of active) {
        const when = j.startedAt ? `, ${ago(t - j.startedAt)}` : "";
        lines.push(`${j.id} ${j.status}${when}: ${j.title}`);
      }
      lines.push("Stop one with /stop <id>.");
    } else {
      lines.push("Nothing running in the background.");
    }
    if (recent.length) {
      lines.push("", "Recent:");
      for (const j of recent) lines.push(`${j.id} ${j.status}${j.finishedAt ? ` ${ago(t - j.finishedAt)} ago` : ""}: ${j.title}`);
    }
    const lvl = usage.level();
    if (lvl !== "ok") lines.push("", lvl === "pause" ? "Plan usage is high (80%+): jobs are paused." : "Plan usage is at 60%+: new jobs wait.");
    return lines.join("\n");
  }

  return { start, list, stop, tick, format };
}

// The supervisor body (worker.js _run jN). Runs claude on the brief, logs, records usage, marks the
// result in jobs.json, and makes sure the user always hears back even if claude never called send.js.
export function runWorker({ stateDir, id, env = process.env, spawn = nodeSpawn, now = () => Date.now() }) {
  const file = join(stateDir, "jobs.json");
  const log = join(stateDir, "jobs", `${id}.log`);
  // The launcher spawns us before it saves "running", so read under the same lock it holds.
  const job = withLock(file, () => readJson(file, { jobs: [] }).jobs?.find((j) => j.id === id));
  if (!job || job.status !== "running") return Promise.resolve(false); // stopped before it got going
  const brief = readFileSync(join(stateDir, "jobs", `${id}.brief.md`), "utf8");
  const stamp = () => new Date(now()).toISOString();
  appendFileSync(log, `[${stamp()}] ${id} started: ${job.title}\n`);

  const usage = createUsage({ stateDir, limit5h: env.USAGE_LIMIT_5H, limitWeek: env.USAGE_LIMIT_WEEK, now });
  const args = ["-p", "--output-format", "json",
    "--permission-mode", env.CLAUDE_PERMISSION_MODE || "acceptEdits",
    "--allowedTools", env.CLAUDE_ALLOWED_TOOLS || "Bash,Read,Edit,Write,Glob,Grep"];
  const childEnv = { ...env, CLAUDE_PHONE_STATE: stateDir, CLAUDE_PHONE_JOB: id };
  delete childEnv.TELEGRAM_BOT_TOKEN;

  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (ok, text) => {
      if (settled) return;
      settled = true;
      appendFileSync(log, `[${stamp()}] ${ok ? "done" : "failed"}\n${text}\n`);
      const sent = existsSync(join(stateDir, "jobs", `${id}.sent`));
      const stillOurs = withLock(file, () => {
        const reg = readJson(file, { jobs: [] });
        const j = reg.jobs?.find((x) => x.id === id);
        if (!j || !["running", "paused"].includes(j.status)) return false; // stopped by the user: say nothing
        Object.assign(j, { status: ok ? "done" : "failed", finishedAt: now(), ...(ok ? {} : { error: text.slice(0, 300) }) });
        writeJson(file, reg);
        return true;
      });
      const short = text.trim().slice(0, 1500);
      if (stillOurs && !ok) enqueue(stateDir, `Job ${id} (${job.title}) failed: ${short || "no output"}\nLog: jobs/${id}.log`);
      else if (stillOurs && !sent) enqueue(stateDir, `Job ${id} (${job.title}) finished:\n${short || "(no text)"}`);
      resolve(ok);
    };

    let child;
    const errFd = openSync(log, "a");
    try {
      child = spawn("claude", args, { cwd: env.WORKDIR || process.cwd(), env: childEnv, stdio: ["pipe", "pipe", errFd] });
    } catch (e) {
      closeSync(errFd);
      return finish(false, `could not start claude: ${e.message}`);
    }
    closeSync(errFd); // the child has its own copy
    child.on("error", (e) => finish(false, `could not start claude (is it installed for this user?): ${e.message}`));
    child.stdout.on("data", (d) => (out += d));
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      let json;
      try { json = JSON.parse(out); } catch {
        return finish(false, out.trim() || `claude exited with code ${code} and no output`);
      }
      usage.record(json.usage);
      if (json.is_error || code) return finish(false, json.result || `claude hit an error (${json.subtype ?? code})`);
      finish(true, json.result || "");
    });
    child.stdin.end(brief);
  });
}
