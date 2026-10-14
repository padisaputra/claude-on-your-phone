import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { enqueue, drain, readJson, writeJson, withLock } from "./outbox.js";

const tmp = () => mkdtempSync(join(tmpdir(), "outbox-"));
const files = (d) => readdirSync(join(d, "outbox"));

test("drain sends oldest first and empties the outbox", async () => {
  const d = tmp();
  for (const t of ["one", "two", "three"]) enqueue(d, t);
  const got = [];
  assert.equal(await drain(d, async (t) => got.push(t)), 3);
  assert.deepEqual(got, ["one", "two", "three"]);
  assert.deepEqual(files(d), []);
});

test("a failed send keeps the message (and the ones after it) for next time", async () => {
  const d = tmp();
  enqueue(d, "a");
  enqueue(d, "b");
  let calls = 0;
  await drain(d, async () => { calls++; throw new Error("telegram down"); });
  assert.equal(calls, 1);
  assert.equal(files(d).length, 2);
  const got = [];
  await drain(d, async (t) => got.push(t));
  assert.deepEqual(got, ["a", "b"]);
});

test("overlapping drains never double-send", async () => {
  const d = tmp();
  enqueue(d, "x");
  let release;
  const got = [];
  const first = drain(d, (t) => new Promise((r) => { got.push(t); release = r; }));
  assert.equal(await drain(d, async (t) => got.push(t)), 0);
  release();
  await first;
  assert.deepEqual(got, ["x"]);
});

test("junk files in the outbox are dropped, not sent", async () => {
  const d = tmp();
  mkdirSync(join(d, "outbox"));
  writeFileSync(join(d, "outbox", "000-bad.json"), "{nope");
  enqueue(d, "good");
  const got = [];
  await drain(d, async (t) => got.push(t));
  assert.deepEqual(got, ["good"]);
});

test("drain on a missing outbox is a no-op", async () => {
  assert.equal(await drain(tmp(), async () => assert.fail()), 0);
});

test("corrupt JSON is moved aside and the fallback returned", () => {
  const d = tmp();
  const f = join(d, "x.json");
  writeFileSync(f, "{broken");
  assert.deepEqual(readJson(f, { ok: 1 }), { ok: 1 });
  assert.ok(readdirSync(d).some((n) => n.startsWith("x.json.corrupt-")));
  writeJson(f, { a: 1 });
  assert.deepEqual(readJson(f, null), { a: 1 });
  assert.deepEqual(readdirSync(d).filter((n) => n.endsWith(".tmp")), []);
});

test("withLock serialises writers across processes", () => {
  const d = tmp();
  const f = join(d, "count.json");
  writeJson(f, { n: 0 });
  const url = new URL("./outbox.js", import.meta.url).href;
  const script = `import { withLock, readJson, writeJson } from ${JSON.stringify(url)};
    for (let i = 0; i < 50; i++) withLock(${JSON.stringify(f)}, () => { const s = readJson(${JSON.stringify(f)}, {n:0}); s.n++; writeJson(${JSON.stringify(f)}, s); });`;
  const run = () => new Promise((res, rej) => {
    import("node:child_process").then(({ execFile }) =>
      execFile(process.execPath, ["--input-type=module", "-e", script], (e) => (e ? rej(e) : res())));
  });
  return Promise.all([run(), run(), run()]).then(() => assert.equal(readJson(f, null).n, 150));
});

test("send.js queues text, marks the job, and refuses empty text", () => {
  const d = tmp();
  const send = new URL("./send.js", import.meta.url).pathname;
  const env = { ...process.env, CLAUDE_PHONE_STATE: d, CLAUDE_PHONE_JOB: "j7" };
  assert.equal(execFileSync(process.execPath, [send, "hello", "there"], { env, encoding: "utf8" }).trim(), "queued");
  const [name] = files(d);
  assert.deepEqual(JSON.parse(readFileSync(join(d, "outbox", name), "utf8")), { text: "hello there" });
  assert.ok(readdirSync(join(d, "jobs")).includes("j7.sent"));
  assert.equal(execFileSync(process.execPath, [send], { env, input: "from stdin\n", encoding: "utf8" }).trim(), "queued");
  assert.throws(() => execFileSync(process.execPath, [send], { env, input: "  ", stdio: "pipe" }));
});
