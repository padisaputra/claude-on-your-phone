// Agent core tests, with a stubbed claude and a fake clock. Plus one real spawn of a fake `claude` script.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, loadMemory, COMMANDS_HELP } from "./agent.js";
import { makeClaudeRunner } from "./claude.js";
import { dayStamp } from "./lib.js";

const HOUR = 3_600_000;
const isHandoff = (call) => /memory\/handoff\.md/.test(call.prompt);

function setup(opts = {}) {
  const workdir = mkdtempSync(join(tmpdir(), "agent-"));
  mkdirSync(join(workdir, "memory"));
  const stateDir = join(workdir, "state");
  const calls = [];
  const clock = { t: new Date(2026, 0, 5, 10).getTime() };
  const runClaude = async (call) => {
    const i = calls.push(call); // numbered on entry, so overlapping calls keep their own numbers
    if (opts.respond) {
      const r = await opts.respond(call, i);
      if (r) return r;
    }
    if (isHandoff(call) && !opts.noHandoffFile) writeFileSync(join(workdir, "memory", "handoff.md"), "Pick up the invoice.");
    const sessionId = call.fork ? `fork-${i}` : call.sessionId ?? `sess-${i}-xxxxxxxx`;
    const tokens = typeof opts.tokens === "function" ? opts.tokens() : opts.tokens;
    return { text: `reply ${i}`, sessionId, contextTokens: tokens ?? 1000, usage: { input_tokens: 10, output_tokens: 5 }, costUsd: opts.cost ?? 0 };
  };
  const make = (extra = {}) => createAgent({ workdir, stateDir, runClaude, now: () => clock.t, ...opts.agent, ...extra });
  return { workdir, stateDir, calls, clock, make };
}

// A promise you can resolve from outside, to hold a turn open.
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test("memory loads into a fresh session, handoff first, archive ignored", () => {
  const { workdir } = setup();
  writeFileSync(join(workdir, "memory", "about-me.md"), "Likes tea.");
  writeFileSync(join(workdir, "memory", "handoff.md"), "Was mid-way through the invoice.");
  mkdirSync(join(workdir, "memory", "archive"));
  writeFileSync(join(workdir, "memory", "archive", "old.md"), "SHOULD NOT LOAD");
  const mem = loadMemory(workdir);
  assert.ok(mem.includes("Likes tea."));
  assert.ok(mem.indexOf("invoice") < mem.indexOf("tea"));
  assert.ok(!mem.includes("SHOULD NOT LOAD"));
  assert.equal(loadMemory(join(workdir, "nowhere")), "");
});

test("first message starts a session with memory, later ones resume without re-sending it", async () => {
  const t = setup();
  writeFileSync(join(t.workdir, "memory", "about-me.md"), "Likes tea.");
  const agent = t.make();
  const emitted = [];
  const out = await agent.handle("1", "hi", (x) => emitted.push(x));
  await agent.handle("1", "again");
  assert.deepEqual(emitted, ["reply 1"]);
  assert.deepEqual(out, ["reply 1"]);
  assert.equal(t.calls[0].sessionId, undefined);
  assert.ok(t.calls[0].appendSystemPrompt.includes("Likes tea."));
  assert.equal(t.calls[1].sessionId, "sess-1-xxxxxxxx");
  assert.equal(t.calls[1].appendSystemPrompt, undefined);
});

test("session, recent messages and model survive a restart", async () => {
  const t = setup();
  const a = t.make();
  await a.handle("1", "/model sonnet");
  await a.handle("1", "hi");
  assert.ok(existsSync(join(t.stateDir, "sessions.json")));
  const b = t.make(); // a brand new agent object reads the file
  await b.handle("1", "after restart");
  assert.equal(t.calls[1].sessionId, "sess-1-xxxxxxxx");
  assert.equal(t.calls[1].model, "sonnet");
  assert.equal(b.sessions()["1"].recent.length, 4);
  assert.equal(b.lastUserAt("1"), t.clock.t);
  assert.equal(b.lastUserAt("nobody"), 0);
});

test("rotation by context size is invisible, runs after the reply, and the next session continues the thread", async () => {
  let tokens = 120_000; // 200k * 0.6
  const t = setup({ tokens: () => tokens });
  const agent = t.make();
  const order = [];
  const emit = (x) => order.push(`emit ${x}`);
  await agent.handle("1", "one", emit);
  assert.equal(t.calls.length, 2);
  assert.ok(isHandoff(t.calls[1]));
  assert.equal(t.calls[1].sessionId, "sess-1-xxxxxxxx"); // handoff runs inside the old session
  assert.deepEqual(order, ["emit reply 1"]); // no rotation notice, ever
  assert.equal(agent.sessions()["1"].sessionId, undefined);

  tokens = 1000;
  await agent.handle("1", "two", emit);
  const next = t.calls[2];
  assert.equal(next.sessionId, undefined); // brand new session
  assert.ok(next.appendSystemPrompt.indexOf("Pick up the invoice.") < next.appendSystemPrompt.indexOf("User: one"));
  assert.match(next.appendSystemPrompt, /You: reply 1/);
  assert.equal(existsSync(join(t.workdir, "memory", "handoff.md")), false); // archived after being read
  assert.equal(readdirSync(join(t.workdir, "memory", "archive")).length, 1);
  assert.ok(order.every((x) => /^emit reply \d+$/.test(x)));
});

test("just under the threshold does not rotate", async () => {
  const t = setup({ tokens: 119_999 });
  await t.make().handle("1", "hi");
  assert.equal(t.calls.length, 1);
});

test("rotation by turns, and only the last recentKeep messages are replayed", async () => {
  const t = setup({ agent: { maxTurns: 3, recentKeep: 4 } });
  const agent = t.make();
  for (const m of ["a1", "a2", "a3"]) await agent.handle("1", m);
  assert.ok(isHandoff(t.calls[3]));
  await agent.handle("1", "a4");
  const sys = t.calls[4].appendSystemPrompt;
  assert.ok(!sys.includes("User: a1") && sys.includes("User: a2") && sys.includes("User: a3"));
  assert.equal(agent.sessions()["1"].turns, 1);
});

test("a long quiet gap hands off the old session before answering, then starts fresh", async () => {
  const t = setup();
  const agent = t.make();
  await agent.handle("1", "evening chat");
  t.clock.t += 5 * HOUR;
  await agent.handle("1", "still here");
  assert.equal(t.calls.length, 2); // under 6h: plain resume
  t.clock.t += 7 * HOUR;
  const out = await agent.handle("1", "good morning");
  assert.ok(isHandoff(t.calls[2]));
  assert.equal(t.calls[2].sessionId, "sess-1-xxxxxxxx");
  assert.equal(t.calls[3].sessionId, undefined);
  assert.match(t.calls[3].appendSystemPrompt, /User: still here/);
  assert.deepEqual(out, ["reply 4"]);
});

test("idle handoff failure still starts fresh with the recent messages", async () => {
  const t = setup({ respond: (call) => (isHandoff(call) ? { text: "No conversation found", failed: true } : null) });
  const agent = t.make();
  await agent.handle("1", "hi");
  t.clock.t += 8 * HOUR;
  await agent.handle("1", "back");
  assert.equal(t.calls[2].sessionId, undefined);
  assert.match(t.calls[2].appendSystemPrompt, /User: hi/);
});

test("a failed handoff keeps the session once, then rotates anyway", async () => {
  const t = setup({ agent: { maxTurns: 1 }, noHandoffFile: true });
  const agent = t.make();
  await agent.handle("1", "hi");
  assert.equal(agent.sessions()["1"].sessionId, "sess-1-xxxxxxxx"); // note not written: keep and retry
  await agent.handle("1", "again");
  assert.equal(agent.sessions()["1"].sessionId, undefined); // second miss: recent messages are enough
});

test("fast lane: a message during a running turn gets an immediate forked reply and a note for the main session", async () => {
  const hold = deferred();
  let blockNext = false;
  const t = setup({ respond: async (call) => (blockNext && !call.fork ? ((blockNext = false), await hold.promise, null) : null) });
  const agent = t.make();
  await agent.handle("1", "hi"); // establishes sess-1
  blockNext = true;
  const emitted = [];
  const main = agent.handle("1", "do the long thing", (x) => emitted.push(x));
  const quick = await agent.handle("1", "how is it going?", (x) => emitted.push(x));
  assert.deepEqual(quick, ["reply 3"]);
  const fastCall = t.calls[2];
  assert.equal(fastCall.fork, true);
  assert.equal(fastCall.sessionId, "sess-1-xxxxxxxx");
  assert.match(fastCall.appendSystemPrompt, /main self is busy/);

  hold.resolve();
  await main;
  assert.deepEqual(emitted, ["reply 3", "reply 2"]);
  const s = agent.sessions()["1"];
  assert.equal(s.sessionId, "sess-1-xxxxxxxx"); // the fork id never replaced the main session
  assert.equal(s.turns, 2);

  await agent.handle("1", "next");
  assert.match(t.calls[3].prompt, /while you were busy, the user said "how is it going\?" and a quick reply said "reply 3"/);
  assert.match(t.calls[3].prompt, /next$/);
  await agent.handle("1", "after");
  assert.equal(t.calls[4].prompt, "after"); // the note is delivered once
});

test("fast lane before any session exists uses a light fresh call", async () => {
  const hold = deferred();
  const t = setup({ respond: async (call, i) => (i === 1 ? (await hold.promise, null) : null) });
  writeFileSync(join(t.workdir, "memory", "about-me.md"), "Likes tea.");
  const agent = t.make();
  const main = agent.handle("1", "first");
  await agent.handle("1", "second");
  assert.equal(t.calls[1].sessionId, undefined);
  assert.equal(t.calls[1].fork, undefined);
  assert.match(t.calls[1].appendSystemPrompt, /Likes tea\.[\s\S]*main self is busy/);
  hold.resolve();
  await main;
  assert.equal(agent.sessions()["1"].sessionId, "sess-1-xxxxxxxx");
});

test("addContext notes go in front of the next main turn, then clear", async () => {
  const t = setup();
  const agent = t.make();
  agent.addContext("1", "the backup job finished");
  await agent.handle("1", "hi");
  assert.match(t.calls[0].prompt, /^\[note: the backup job finished\]\n\nhi$/);
  await agent.handle("1", "again");
  assert.equal(t.calls[1].prompt, "again");
});

test("notes survive a failed turn and wait while a slash command passes through", async () => {
  let fail = true;
  const t = setup({ respond: () => (fail ? { text: "Not logged in", failed: true } : null) });
  const agent = t.make();
  agent.addContext("1", "remember me");
  assert.deepEqual(await agent.handle("1", "hi"), ["Not logged in"]);
  assert.equal(agent.sessions()["1"].sessionId, undefined); // a failed turn is not saved
  fail = false;
  await agent.handle("1", "/context");
  assert.equal(t.calls[1].prompt, "/context"); // unknown slash commands go to claude untouched
  await agent.handle("1", "ok");
  assert.match(t.calls[2].prompt, /remember me/);
});

test("oneShot uses memory, saves nothing, and throws on failure", async () => {
  const t = setup({ respond: (call) => (call.prompt === "bad" ? { text: "boom", failed: true } : null) });
  writeFileSync(join(t.workdir, "memory", "about-me.md"), "Likes tea.");
  const agent = t.make();
  assert.equal(await agent.oneShot("summarise"), "reply 1");
  assert.equal(t.calls[0].sessionId, undefined);
  assert.match(t.calls[0].appendSystemPrompt, /Likes tea/);
  assert.deepEqual(agent.sessions(), {});
  assert.equal(existsSync(join(t.stateDir, "sessions.json")), false);
  await assert.rejects(agent.oneShot("bad"), /boom/);
});

test("/compact rotates now and says so; the next message starts fresh", async () => {
  const t = setup();
  const agent = t.make();
  assert.match((await agent.handle("1", "/compact"))[0], /Already fresh/);
  await agent.handle("1", "hi");
  const [reply] = await agent.handle("1", "/compact");
  assert.match(reply, /^Done\. Saved a handoff note/);
  assert.ok(isHandoff(t.calls[1]));
  await agent.handle("1", "go on");
  assert.equal(t.calls[2].sessionId, undefined);
  assert.match(t.calls[2].appendSystemPrompt, /Pick up the invoice[\s\S]*User: hi/);
});

test("/clear and /new drop the session and the recent messages but keep the model", async () => {
  for (const cmd of ["/clear", "/new"]) {
    const t = setup();
    const agent = t.make();
    await agent.handle("1", "/model haiku");
    await agent.handle("1", "hi");
    agent.addContext("1", "stale");
    await agent.handle("1", cmd);
    await agent.handle("1", "hello again");
    assert.equal(t.calls[1].sessionId, undefined);
    assert.equal(t.calls[1].appendSystemPrompt, undefined); // empty memory, no recent block
    assert.equal(t.calls[1].prompt, "hello again");
    assert.equal(t.calls[1].model, "haiku");
  }
});

test("/model shows, sets, rejects junk and resets", async () => {
  const t = setup();
  const agent = t.make();
  assert.match((await agent.handle("1", "/model"))[0], /default/);
  await agent.handle("1", "/model claude-opus-4-1");
  await agent.handle("1", "hi");
  assert.equal(t.calls[0].model, "claude-opus-4-1");
  assert.match((await agent.handle("1", "/model --dangerous"))[0], /does not look like/);
  assert.match((await agent.handle("1", "/Model@my_bot"))[0], /claude-opus-4-1/);
  await agent.handle("1", "/model default");
  await agent.handle("1", "again");
  assert.equal(t.calls[1].model, undefined);
});

test("/cost reports tokens and cost, and says n/a when there is none", async () => {
  const t = setup({ cost: 0.0123 });
  const agent = t.make();
  assert.match((await agent.handle("1", "/cost"))[0], /0 tokens, estimated cost n\/a/);
  await agent.handle("1", "hi");
  await agent.handle("1", "again");
  const [reply] = await agent.handle("1", "/cost");
  assert.match(reply, /30 tokens, estimated cost \$0\.0246/);
  assert.match(reply, /not billed/);
});

test("/status and /start", async () => {
  const t = setup();
  const agent = t.make();
  assert.match((await agent.handle("1", "/status"))[0], /none yet/);
  await agent.handle("1", "hi");
  const [s] = await agent.handle("1", "/status");
  assert.match(s, /sess-1-x, turn 1 of 40/);
  assert.match(s, /1k of 200k tokens, refreshes at 120k/);
  assert.match(s, /Model: default/);
  assert.match((await agent.handle("1", "/start"))[0], /\/compact/);
  assert.ok(COMMANDS_HELP.every(([c, d]) => c.startsWith("/") && d));
});

test("every message and reply lands in the daily conversation log", async () => {
  const t = setup();
  const agent = t.make();
  await agent.handle("1", "hi");
  await agent.handle("1", "/status");
  const file = join(t.stateDir, "convo", `${dayStamp(t.clock.t)}.jsonl`);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.role), ["user", "agent", "user", "agent"]);
  assert.deepEqual(lines[0], { t: new Date(t.clock.t).toISOString(), key: "1", role: "user", text: "hi" });
});

test("a vanished session starts fresh automatically", async () => {
  const t = setup({
    respond: (call) => (call.sessionId === "sess-1-xxxxxxxx" ? { text: "No conversation found with session ID", failed: true } : null),
  });
  const agent = t.make();
  await agent.handle("1", "hi");
  const replies = await agent.handle("1", "still there?");
  assert.equal(t.calls.length, 3);
  assert.equal(t.calls[2].sessionId, undefined);
  assert.match(t.calls[2].appendSystemPrompt, /User: hi/);
  assert.deepEqual(replies, ["reply 3"]);
});

test("the real runner passes --resume, --fork-session, --model and --append-system-prompt to claude", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fakeclaude-"));
  const argsFile = join(dir, "args.txt");
  writeFileSync(join(dir, "claude"), `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
cat > "${argsFile}.stdin"
echo '{"is_error":false,"result":"hi there","session_id":"s-new","total_cost_usd":0.25,"usage":{"input_tokens":5,"cache_read_input_tokens":100,"output_tokens":7,"iterations":[{"input_tokens":3,"cache_read_input_tokens":50,"cache_creation_input_tokens":2}]}}'
`);
  chmodSync(join(dir, "claude"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const run = makeClaudeRunner({ workdir: dir, permissionMode: "acceptEdits", allowedTools: "Read", timeoutMs: 10_000 });
    const res = await run({ prompt: "--not-a-flag", sessionId: "s-old", fork: true, model: "opus", appendSystemPrompt: "be brief" });
    const args = readFileSync(argsFile, "utf8").trim().split("\n");
    const after = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(after("--resume"), "s-old");
    assert.ok(args.includes("--fork-session"));
    assert.equal(after("--model"), "opus");
    assert.equal(after("--append-system-prompt"), "be brief");
    assert.ok(!args.includes("--not-a-flag"));
    assert.equal(readFileSync(`${argsFile}.stdin`, "utf8"), "--not-a-flag"); // prompt goes in on stdin
    assert.equal(res.text, "hi there");
    assert.equal(res.sessionId, "s-new");
    assert.equal(res.costUsd, 0.25);
    assert.equal(res.contextTokens, 55); // last API call only
    assert.equal(res.usage.output_tokens, 7);

    await run({ prompt: "x", sessionId: "s-old" }); // no fork, no model
    const plain = readFileSync(argsFile, "utf8").trim().split("\n");
    assert.ok(!plain.includes("--fork-session") && !plain.includes("--model"));
  } finally {
    process.env.PATH = oldPath;
  }
});
