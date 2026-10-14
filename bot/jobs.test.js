import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobs, runWorker } from "./jobs.js";

// A fake world: spawn hands out pids, `alive` says which are still our supervisors, signals are recorded.
function setup({ level = "ok", maxWorkers = 2 } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "jobs-"));
  const clock = { t: 1_000_000 };
  const usage = { lvl: level, level() { return this.lvl; } };
  const spawned = [];
  const alive = new Set();
  const signals = [];
  let pid = 5000;
  const spawn = (cmd, args, opts) => {
    const child = { pid: ++pid, unref() {}, on() {} };
    spawned.push({ cmd, args, opts, pid: child.pid });
    alive.add(child.pid);
    return child;
  };
  const make = () => createJobs({
    stateDir, appDir: "/app", workdir: stateDir, usage, now: () => clock.t, spawn, maxWorkers,
    probe: (job) => alive.has(job.pid),
    signal: (p, sig) => { signals.push([p, sig]); return alive.has(p); },
  });
  return { stateDir, clock, usage, spawned, alive, signals, jobs: make(), make };
}
const outbox = (d) => { try { return readdirSync(join(d, "outbox")).map((n) => JSON.parse(readFileSync(join(d, "outbox", n), "utf8")).text); } catch { return []; } };

test("start runs a detached supervisor with a brief that has the footer", () => {
  const { jobs, spawned, stateDir } = setup();
  assert.deepEqual(jobs.start({ title: "Research", brief: "Find three hotels." }), { id: "j1", status: "running" });
  const [s] = spawned;
  assert.deepEqual(s.args.slice(1), ["_run", "j1", "--state", stateDir]);
  assert.equal(s.opts.detached, true);
  assert.equal(s.opts.env.CLAUDE_PHONE_STATE, stateDir);
  assert.equal(s.opts.env.TELEGRAM_BOT_TOKEN, undefined);
  const brief = readFileSync(join(stateDir, "jobs", "j1.brief.md"), "utf8");
  assert.match(brief, /^Find three hotels\./);
  assert.match(brief, /\/app\/send\.js/);
  assert.match(brief, /Never stop to ask/);
  const [j] = jobs.list();
  assert.equal(j.status, "running");
  assert.equal(j.pid, s.pid);
  assert.equal(j.startedAt, 1_000_000);
});

test("max workers: extra jobs queue and start in order as slots free up", () => {
  const { jobs, alive, spawned, stateDir } = setup({ maxWorkers: 2 });
  jobs.start({ brief: "a" });
  jobs.start({ brief: "b" });
  assert.equal(jobs.start({ brief: "c" }).status, "queued");
  assert.equal(jobs.start({ brief: "d" }).status, "queued");
  jobs.tick();
  assert.equal(spawned.length, 2);
  // j1 finishes normally: its supervisor marks done itself, then exits.
  const reg = JSON.parse(readFileSync(join(stateDir, "jobs.json"), "utf8"));
  reg.jobs[0].status = "done";
  writeFileSync(join(stateDir, "jobs.json"), JSON.stringify(reg));
  alive.delete(spawned[0].pid);
  jobs.tick();
  assert.deepEqual(jobs.list().map((j) => j.status), ["done", "running", "running", "queued"]);
  assert.equal(spawned[2].args[2], "j3");
  assert.deepEqual(outbox(stateDir), []); // a clean finish is not reported by tick
});

test("a dead supervisor is reaped as failed and the user is told", () => {
  const { jobs, alive, spawned, stateDir } = setup();
  jobs.start({ title: "Crashy", brief: "x" });
  alive.delete(spawned[0].pid);
  jobs.tick();
  assert.equal(jobs.list()[0].status, "failed");
  assert.match(outbox(stateDir)[0], /j1 \(Crashy\) stopped unexpectedly/);
});

test("usage guard: queue at 60%, pause at 80%, resume and drain the queue when it drops", () => {
  const { jobs, usage, signals, spawned } = setup({ maxWorkers: 3 });
  jobs.start({ brief: "a" });
  usage.lvl = "queue";
  assert.equal(jobs.start({ brief: "b" }).status, "queued");
  jobs.tick();
  assert.equal(spawned.length, 1);
  usage.lvl = "pause";
  jobs.tick();
  assert.deepEqual(signals, [[spawned[0].pid, "SIGSTOP"]]);
  assert.equal(jobs.list()[0].status, "paused");
  usage.lvl = "queue"; // in between: stay paused, start nothing
  jobs.tick();
  assert.deepEqual(jobs.list().map((j) => j.status), ["paused", "queued"]);
  usage.lvl = "ok";
  jobs.tick();
  assert.deepEqual(signals.at(-1), [spawned[0].pid, "SIGCONT"]);
  assert.deepEqual(jobs.list().map((j) => j.status), ["running", "running"]);
  assert.match(jobs.format(), /j1 running/);
});

test("stop terminates the group, then SIGKILLs it if it lingers", () => {
  const { jobs, signals, spawned, clock } = setup();
  jobs.start({ brief: "a" });
  const pid = spawned[0].pid;
  assert.equal(jobs.stop("j1"), true);
  assert.deepEqual(signals, [[pid, "SIGTERM"], [pid, "SIGCONT"]]);
  assert.equal(jobs.list()[0].status, "stopped");
  jobs.tick();
  assert.equal(signals.length, 2); // too early for SIGKILL
  clock.t += 11_000;
  jobs.tick();
  assert.deepEqual(signals.at(-1), [pid, "SIGKILL"]);
  assert.equal(jobs.stop("j1"), false);
  assert.equal(jobs.stop("j99"), false);
});

test("stop never signals a pid that is no longer ours", () => {
  const { jobs, signals, alive, spawned } = setup();
  jobs.start({ brief: "a" });
  alive.delete(spawned[0].pid); // e.g. pid reused after a reboot: probe says not ours
  assert.equal(jobs.stop("j1"), true);
  assert.deepEqual(signals, []);
});

test("stopping a queued job just drops it from the queue", () => {
  const { jobs, spawned } = setup({ level: "queue" });
  jobs.start({ brief: "a" });
  assert.equal(jobs.stop("j1"), true);
  jobs.tick();
  assert.equal(spawned.length, 0);
});

test("corrupt jobs.json: start fresh without reusing ids", () => {
  const { jobs, stateDir } = setup();
  jobs.start({ brief: "a" });
  jobs.start({ brief: "b" });
  writeFileSync(join(stateDir, "jobs.json"), "{{{");
  assert.equal(jobs.list().length, 0);
  assert.equal(jobs.start({ brief: "c" }).id, "j3");
  assert.ok(readdirSync(stateDir).some((n) => n.startsWith("jobs.json.corrupt-")));
});

test("two writers (bot and CLI) never lose each other's jobs", () => {
  const a = setup();
  const b = a.make();
  a.jobs.start({ brief: "from bot" });
  b.start({ brief: "from cli" });
  a.jobs.tick();
  assert.deepEqual(b.list().map((j) => j.id), ["j1", "j2"]);
});

test("format lists active and recent jobs", () => {
  const { jobs, clock } = setup();
  assert.match(jobs.format(), /No background jobs/);
  jobs.start({ title: "Write report", brief: "x" });
  jobs.stop("j1");
  jobs.start({ title: "Scan inbox", brief: "y" });
  clock.t += 5 * 60_000;
  const f = jobs.format();
  assert.match(f, /j2 running, 5 min: Scan inbox/);
  assert.match(f, /Recent:\nj1 stopped 5 min ago: Write report/);
});

// ---- the supervisor, with a fake claude child ----

function fakeClaude(script) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = { on() {}, end(text) { calls.push({ cmd, args, opts, stdin: text }); setImmediate(() => script(child, opts)); } };
    return child;
  };
  return { spawn, calls };
}

function workerSetup() {
  const s = setup();
  s.jobs.start({ title: "Hotels", brief: "Find hotels." });
  const env = { WORKDIR: s.stateDir, TELEGRAM_BOT_TOKEN: "secret", USAGE_LIMIT_5H: "1000" };
  return { ...s, env };
}

test("worker: success without send.js -> done, usage recorded, fallback message with the result", async () => {
  const { stateDir, env, jobs } = workerSetup();
  const { spawn, calls } = fakeClaude((child) => {
    child.stdout.emit("data", JSON.stringify({ result: "Found 3 hotels.", usage: { input_tokens: 100, output_tokens: 50 } }));
    child.emit("close", 0);
  });
  assert.equal(await runWorker({ stateDir, id: "j1", env, spawn }), true);
  const c = calls[0];
  assert.equal(c.cmd, "claude");
  assert.deepEqual(c.args.slice(0, 5), ["-p", "--output-format", "json", "--permission-mode", "acceptEdits"]);
  assert.equal(c.opts.env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(c.opts.env.CLAUDE_PHONE_JOB, "j1");
  assert.match(c.stdin, /Find hotels\./);
  assert.equal(jobs.list()[0].status, "done");
  assert.match(outbox(stateDir)[0], /Job j1 \(Hotels\) finished:\nFound 3 hotels\./);
  assert.equal(JSON.parse(readFileSync(join(stateDir, "usage.json"), "utf8")).records[0][1], 150);
  assert.match(readFileSync(join(stateDir, "jobs", "j1.log"), "utf8"), /done\nFound 3 hotels/);
});

test("worker: success after send.js -> no duplicate message", async () => {
  const { stateDir, env } = workerSetup();
  const { spawn } = fakeClaude((child) => {
    writeFileSync(join(stateDir, "jobs", "j1.sent"), "");
    child.stdout.emit("data", JSON.stringify({ result: "ok" }));
    child.emit("close", 0);
  });
  await runWorker({ stateDir, id: "j1", env, spawn });
  assert.deepEqual(outbox(stateDir), []);
});

test("worker: claude error or garbage output -> failed and the user is told", async () => {
  const { stateDir, env, jobs } = workerSetup();
  const { spawn } = fakeClaude((child) => { child.stdout.emit("data", "Invalid API key"); child.emit("close", 1); });
  assert.equal(await runWorker({ stateDir, id: "j1", env, spawn }), false);
  assert.equal(jobs.list()[0].status, "failed");
  assert.match(outbox(stateDir)[0], /Job j1 \(Hotels\) failed: Invalid API key/);
});

test("worker: claude missing -> failed, no crash", async () => {
  const { stateDir, env, jobs } = workerSetup();
  const { spawn } = fakeClaude((child) => child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })));
  assert.equal(await runWorker({ stateDir, id: "j1", env, spawn }), false);
  assert.match(jobs.list()[0].error, /ENOENT/);
});

test("worker: a job the user stopped stays stopped and silent", async () => {
  const { stateDir, env, jobs } = workerSetup();
  const { spawn } = fakeClaude((child) => {
    jobs.stop("j1");
    child.stdout.emit("data", JSON.stringify({ result: "late" }));
    child.emit("close", 0);
  });
  await runWorker({ stateDir, id: "j1", env, spawn });
  assert.equal(jobs.list()[0].status, "stopped");
  assert.deepEqual(outbox(stateDir), []);
  assert.ok(!existsSync(join(stateDir, "jobs", "j1.sent")));
});
