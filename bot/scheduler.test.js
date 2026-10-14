import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduler, parseScheduleReply, isPass, NO_CODE_RULE } from "./scheduler.js";

const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);

// A scheduler with a fake clock and stubbed model, chat and jobs. Everything is recorded.
function setup({ replies = [], config = {}, level = "ok", lastUser = 0, jobList = [] } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "sched-state-"));
  const workdir = mkdtempSync(join(tmpdir(), "sched-work-"));
  mkdirSync(join(workdir, "memory"));
  const env = { time: at(2026, 10, 14, 1, 0), prompts: [], sent: [], context: [], level, lastUser };
  const queue = [...replies];
  const s = createScheduler({
    stateDir,
    workdir,
    oneShot: async (p) => {
      env.prompts.push(p);
      const r = queue.length ? queue.shift() : "PASS";
      if (r instanceof Error) throw r;
      return typeof r === "function" ? r(p) : r;
    },
    notify: async (text) => env.sent.push(text),
    addContext: (key, text) => env.context.push({ key, text }),
    jobs: { list: () => jobList },
    usage: { level: () => env.level },
    lastUserAt: () => env.lastUser,
    now: () => env.time,
    config: { chatKey: "42", heartbeatOn: false, nightlyOn: false, ...config },
  });
  return { s, env, stateDir, workdir, queue };
}

const json = (o) => JSON.stringify(o);

// ---------- parsing ----------

test("schedule reply parsing strips fences and validates cron", () => {
  const good = parseScheduleReply('Sure!\n```json\n{"cron":"0 8 * * 1-5","prompt":"Brief me","summary":"Weekdays 08:00 brief"}\n```');
  assert.deepEqual(good, { cron: "0 8 * * 1-5", prompt: "Brief me", summary: "Weekdays 08:00 brief", once: false });
  assert.equal(parseScheduleReply("I cannot do that"), null);
  assert.equal(parseScheduleReply('{"cron":"99 8 * * *","prompt":"x"}'), null);
  assert.equal(parseScheduleReply('{"cron":"0 8 * * *","prompt":""}'), null);
  assert.equal(parseScheduleReply("{not json}"), null);
});

test("PASS detection", () => {
  for (const p of ["PASS", " pass ", "Pass.", "PASS - nothing new", "", "  "]) assert.equal(isPass(p), true, p);
  for (const p of ["Hey, your 3pm is soon", "passing"]) assert.equal(isPass(p), false, p);
});

// ---------- schedules ----------

test("add stores a schedule with s1, s2 ids and tells the model the rules", async () => {
  const { s, env, stateDir } = setup({
    replies: [json({ cron: "0 8 * * 1-5", prompt: "Brief me on the news", summary: "Weekdays 08:00 news" }), json({ cron: "*/30 * * * *", prompt: "Check", summary: "check" })],
  });
  assert.deepEqual(await s.add("every weekday 8:00 brief me on the news"), { id: "s1", summary: "Weekdays 08:00 news" });
  assert.deepEqual(await s.add("every half hour check"), { id: "s2", summary: "check" });
  assert.match(env.prompts[0], /five-field cron/);
  assert.match(env.prompts[0], /self-contained/);
  assert.match(env.prompts[0], /"once":true/);
  assert.match(env.prompts[0], /2026-10-14 01:00/);
  const saved = JSON.parse(readFileSync(join(stateDir, "schedules.json"), "utf8"));
  assert.equal(saved.schedules.length, 2);
  assert.equal(saved.schedules[0].lastRun, 0);
  assert.match(s.format(), /s1: Weekdays 08:00 news\n {3}next: Wed 14 Oct 08:00/);
  assert.equal(s.remove("s1"), true);
  assert.equal(s.remove("s1"), false);
  assert.deepEqual(s.list().map((x) => x.id), ["s2"]);
});

test("ids are not reused after a removal", async () => {
  const reply = json({ cron: "0 9 * * *", prompt: "x", summary: "x" });
  const { s } = setup({ replies: [reply, reply] });
  await s.add("a");
  s.remove("s1");
  assert.equal((await s.add("b")).id, "s2");
});

test("bad JSON from the model gives a readable error and stores nothing", async () => {
  const { s } = setup({ replies: ["Sorry, I am not sure what you mean.", json({ cron: "every day", prompt: "x" })] });
  await assert.rejects(s.add("whenever"), /could not turn that into a schedule/);
  await assert.rejects(s.add("whenever"), /could not turn that into a schedule/);
  assert.equal(s.list().length, 0);
  assert.match(s.format(), /No schedules yet/);
});

test("a due job fires once per minute, notifies and adds context", async () => {
  const { s, env } = setup({ replies: [json({ cron: "0 8 * * *", prompt: "Say hi", summary: "daily hi" }), "Hi there, here is your brief."] });
  await s.add("every day at 8 say hi");
  env.time = at(2026, 10, 14, 7, 59, 40);
  await s.tick();
  assert.equal(env.sent.length, 0);
  env.time = at(2026, 10, 14, 8, 0, 5);
  await Promise.all([s.tick(), s.tick()]); // overlapping ticks
  env.time = at(2026, 10, 14, 8, 0, 35);
  await s.tick();
  assert.deepEqual(env.sent, ["Hi there, here is your brief."]);
  assert.equal(env.prompts.filter((p) => p === "Say hi").length, 1);
  assert.deepEqual(env.context, [{ key: "42", text: "[scheduled job s1 ran and told the user: Hi there, here is your brief.]" }]);
  // the next day it fires again
  env.time = at(2026, 10, 15, 8, 0, 10);
  await s.tick();
  assert.equal(env.prompts.filter((p) => p === "Say hi").length, 2);
});

test("missed runs are skipped, not caught up", async () => {
  const { s, env } = setup({ replies: [json({ cron: "0 8 * * *", prompt: "Say hi", summary: "hi" })] });
  await s.add("8am hi");
  env.time = at(2026, 10, 14, 8, 5);
  await s.tick();
  assert.equal(env.sent.length, 0);
});

test("once-jobs fire and delete themselves", async () => {
  const { s, env } = setup({ replies: [json({ cron: "30 14 14 10 *", prompt: "Remind: call the bank", summary: "call the bank", once: true }), "Reminder: call the bank."] });
  await s.add("remind me at 14:30 to call the bank");
  assert.match(s.format(), /\(once\)/);
  env.time = at(2026, 10, 14, 14, 30, 1);
  await s.tick();
  await s.tick();
  assert.deepEqual(env.sent, ["Reminder: call the bank."]);
  assert.equal(s.list().length, 0);
});

test("a failing job tells the user", async () => {
  const { s, env } = setup({ replies: [json({ cron: "* * * * *", prompt: "x", summary: "every minute" }), new Error("timeout")] });
  await s.add("x");
  env.time = at(2026, 10, 14, 9, 0);
  await s.tick();
  assert.match(env.sent[0], /Scheduled job s1 \(every minute\) failed: timeout/);
});

// ---------- heartbeat ----------

const hbConfig = { heartbeatOn: true, heartbeatEveryMin: 30, heartbeatHours: "09:00-22:00", heartbeatMaxPerDay: 3 };
const hbLog = (stateDir) => JSON.parse(readFileSync(join(stateDir, "heartbeat.json"), "utf8"));

test("heartbeat PASS sends nothing and logs PASS; prompt prefers PASS", async () => {
  const { s, env, stateDir } = setup({
    config: hbConfig,
    replies: ["pass."],
    lastUser: at(2026, 10, 14, 6, 0).getTime(),
    jobList: [{ id: "j1", title: "research", status: "running" }, { id: "j2", title: "old", status: "done", finishedAt: 1 }],
  });
  env.time = at(2026, 10, 14, 9, 30, 10);
  await s.tick();
  await s.tick();
  assert.equal(env.prompts.length, 1);
  assert.equal(env.sent.length, 0);
  const p = env.prompts[0];
  assert.match(p, /Reply exactly PASS/);
  assert.match(p, /Prefer PASS/);
  assert.match(p, /Wednesday 2026-10-14 09:30/);
  assert.match(p, /j1 "research": running/);
  assert.doesNotMatch(p, /j2/);
  assert.match(p, /0 of 3/);
  assert.match(p, /3\.5 hours/);
  assert.doesNotMatch(p, /following up/i);
  assert.equal(hbLog(stateDir).log.at(-1).decision, "PASS");
});

test("heartbeat message is sent and counted; cap stops model calls", async () => {
  const { s, env, stateDir } = setup({ config: { ...hbConfig, heartbeatMaxPerDay: 2 }, replies: ["Your 15:00 call is in an hour.", "Job j1 finished.", "never used"] });
  for (const [h, m] of [[9, 0], [9, 30], [10, 0]]) {
    env.time = at(2026, 10, 14, h, m);
    await s.tick();
  }
  assert.deepEqual(env.sent, ["Your 15:00 call is in an hour.", "Job j1 finished."]);
  assert.equal(env.prompts.length, 2);
  const hb = hbLog(stateDir);
  assert.equal(hb.sent["2026-10-14"], 2);
  assert.deepEqual(hb.log.map((l) => l.decision), ["message", "message", "skipped"]);
  assert.match(hb.log.at(-1).reason, /daily cap/);
  // a new day resets the count
  env.time = at(2026, 10, 15, 9, 0);
  await s.tick();
  assert.equal(env.prompts.length, 3);
});

test("heartbeat never runs in quiet hours or off-slot minutes", async () => {
  const { s, env } = setup({ config: hbConfig });
  for (const [h, m] of [[8, 30], [22, 0], [23, 30], [2, 0], [9, 15], [9, 31]]) {
    env.time = at(2026, 10, 14, h, m);
    await s.tick();
  }
  assert.equal(env.prompts.length, 0);
});

test("heartbeat skips without a model call on high usage or a recent user message", async () => {
  const { s, env, stateDir } = setup({ config: hbConfig, level: "queue" });
  env.time = at(2026, 10, 14, 9, 0);
  await s.tick();
  env.level = "ok";
  env.lastUser = at(2026, 10, 14, 9, 15).getTime();
  env.time = at(2026, 10, 14, 9, 30);
  await s.tick();
  assert.equal(env.prompts.length, 0);
  const reasons = hbLog(stateDir).log.map((l) => l.reason);
  assert.match(reasons[0], /usage level queue/);
  assert.match(reasons[1], /last 20 minutes/);
});

// ---------- nightly + morning ----------

function writeConvo(stateDir, turns) {
  mkdirSync(join(stateDir, "convo"), { recursive: true });
  for (const t of turns) {
    const d = new Date(t.t);
    const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.jsonl`;
    appendFileSync(join(stateDir, "convo", name), JSON.stringify(t) + "\n");
  }
}

test("nightly runs once per day with the convo and the no-code rule", async () => {
  const { s, env, stateDir } = setup({ config: { nightlyOn: true, nightlyAt: "03:00" }, replies: ["updated notes", "updated again"] });
  writeConvo(stateDir, [
    { t: at(2026, 10, 13, 20, 0).getTime(), key: "42", role: "user", text: "I prefer tea now, not coffee" },
    { t: at(2026, 10, 13, 20, 1).toISOString(), key: "42", role: "agent", text: "Noted." },
  ]);
  // first ever start at 01:00: not in the window yet
  await s.tick();
  assert.equal(env.prompts.length, 0);
  env.time = at(2026, 10, 14, 3, 0, 10);
  await s.tick();
  env.time = at(2026, 10, 14, 3, 0, 40);
  await s.tick();
  env.time = at(2026, 10, 14, 5, 0);
  await s.tick();
  assert.equal(env.prompts.length, 1);
  const p = env.prompts[0];
  assert.match(p, /I prefer tea now, not coffee/);
  assert.match(p, /you: Noted\./);
  assert.match(p, /memory\/journal\.md/);
  assert.match(p, /memory\/lessons\.md/);
  assert.match(p, /memory\/proposals\.md/);
  assert.match(p, /file tools/);
  assert.ok(p.includes(NO_CODE_RULE));
  assert.match(p, /NEVER change code, config/);
  assert.equal(env.sent.length, 0); // the nightly never messages the user
  const n = JSON.parse(readFileSync(join(stateDir, "nightly.json"), "utf8"));
  assert.equal(n.lastRun, at(2026, 10, 14, 3, 0, 10).getTime());
  assert.equal(n.runs.at(-1).ok, true);

  // next night only sees the new conversation
  writeConvo(stateDir, [{ t: at(2026, 10, 14, 19, 0).getTime(), key: "42", role: "user", text: "new thing today" }]);
  env.time = at(2026, 10, 15, 3, 0);
  await s.tick();
  assert.equal(env.prompts.length, 2);
  assert.match(env.prompts[1], /new thing today/);
  assert.doesNotMatch(env.prompts[1], /tea/);
});

test("nightly catches up once after downtime, only before noon", async () => {
  const { s, env, stateDir } = setup({ config: { nightlyOn: true }, replies: ["ok", "ok"] });
  writeConvo(stateDir, [{ t: at(2026, 10, 14, 1, 0).getTime(), key: "42", role: "user", text: "hello" }]);
  writeFileSync(join(stateDir, "nightly.json"), json({ lastRun: at(2026, 10, 13, 3, 0).getTime() }));
  env.time = at(2026, 10, 14, 13, 0); // started after noon: no catch-up
  await s.tick();
  assert.equal(env.prompts.length, 0);

  const b = setup({ config: { nightlyOn: true }, replies: ["ok"] });
  writeConvo(b.stateDir, [{ t: at(2026, 10, 14, 1, 0).getTime(), key: "42", role: "user", text: "hello" }]);
  writeFileSync(join(b.stateDir, "nightly.json"), json({ lastRun: at(2026, 10, 13, 3, 0).getTime() }));
  b.env.time = at(2026, 10, 14, 7, 0);
  await b.s.tick();
  b.env.time = at(2026, 10, 14, 7, 30);
  await b.s.tick();
  assert.equal(b.env.prompts.length, 1);
});

test("nightly with no conversation skips the model call but records the run", async () => {
  const { s, env, stateDir } = setup({ config: { nightlyOn: true } });
  env.time = at(2026, 10, 14, 3, 0);
  await s.tick();
  assert.equal(env.prompts.length, 0);
  const n = JSON.parse(readFileSync(join(stateDir, "nightly.json"), "utf8"));
  assert.match(n.runs.at(-1).skipped, /no conversation/);
});

test("morning sends proposals once and briefs the main agent", async () => {
  const { s, env } = setup();
  env.time = at(2026, 10, 14, 8, 30);
  await s.tick(); // no proposals file: nothing
  assert.equal(env.sent.length, 0);

  const c = setup();
  writeFileSync(join(c.workdir, "memory", "proposals.md"), "# Proposals\n\n1. Install a weather tool so briefings include rain.\n2. Move the daily brief to 07:30.\n");
  c.env.time = at(2026, 10, 14, 8, 30, 5);
  await c.s.tick();
  c.env.time = at(2026, 10, 14, 8, 30, 35);
  await c.s.tick();
  assert.equal(c.env.sent.length, 1);
  assert.match(c.env.sent[0], /1\. Install a weather tool/);
  assert.match(c.env.sent[0], /ok or no/);
  assert.equal(c.env.context.length, 1);
  assert.equal(c.env.context[0].key, "42");
  assert.match(c.env.context[0].text, /apply the approved ones/);
  assert.match(c.env.context[0].text, /delete every answered proposal/);
  assert.equal(c.env.prompts.length, 0); // nothing auto-applied, no model call

  // only headings means nothing to ask
  const d = setup();
  writeFileSync(join(d.workdir, "memory", "proposals.md"), "# Proposals\n\n");
  d.env.time = at(2026, 10, 14, 8, 30);
  await d.s.tick();
  assert.equal(d.env.sent.length, 0);
});
