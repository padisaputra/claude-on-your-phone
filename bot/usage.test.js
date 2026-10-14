import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsage, weigh } from "./usage.js";

const H = 3_600_000;
function setup(limits = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "usage-"));
  const clock = { t: Date.UTC(2026, 0, 1) };
  const make = () => createUsage({ stateDir, limit5h: 1000, limitWeek: 10_000, now: () => clock.t, ...limits });
  return { stateDir, clock, u: make(), make };
}

test("weighting: cache reads count a tenth, numbers pass through", () => {
  assert.equal(weigh({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 100 }), 70);
  assert.equal(weigh(42), 42);
  assert.equal(weigh(undefined), 0);
});

test("percent and level follow the 5h window and the week", () => {
  const { u, clock } = setup();
  assert.equal(u.level(), "ok");
  u.record(500);
  assert.deepEqual(u.percent(), { fiveHour: 50, week: 5, worst: 50 });
  u.record({ output_tokens: 150 });
  assert.equal(u.level(), "queue");
  u.record(200);
  assert.equal(u.level(), "pause");
  clock.t += 5 * H; // the 5h window rolls off, the week remembers
  assert.deepEqual(u.percent(), { fiveHour: 0, week: 8.5, worst: 8.5 });
  assert.equal(u.level(), "ok");
});

test("the weekly limit alone can pause workers", () => {
  const { u, clock } = setup();
  for (let i = 0; i < 9; i++) { u.record(900); clock.t += 6 * H; }
  assert.equal(u.percent().fiveHour, 0);
  assert.equal(u.level(), "pause");
  clock.t += 7 * 24 * H;
  assert.equal(u.level(), "ok");
});

test("state is shared through the file (bot and workers see the same numbers)", () => {
  const { u, make } = setup();
  u.record(700);
  assert.equal(make().level(), "queue");
});

test("thresholds are announced once and re-armed after dropping below", () => {
  const { u, clock } = setup();
  assert.deepEqual(u.newlyCrossed(), []);
  u.record(650);
  assert.deepEqual(u.newlyCrossed(), [60]);
  assert.deepEqual(u.newlyCrossed(), []);
  u.record(200);
  assert.deepEqual(u.newlyCrossed(), [80]);
  assert.deepEqual(u.newlyCrossed(), []);
  clock.t += 5 * H;
  assert.deepEqual(u.newlyCrossed(), []);
  u.record(900); // straight past both: one notice
  assert.deepEqual(u.newlyCrossed(), [80]);
});

test("records older than a week are pruned", () => {
  const { u, clock, stateDir } = setup();
  u.record(100);
  clock.t += 8 * 24 * H;
  u.record(1);
  assert.equal(JSON.parse(readFileSync(join(stateDir, "usage.json"), "utf8")).records.length, 1);
});

test("corrupt usage.json is survivable", () => {
  const { stateDir, make } = setup();
  writeFileSync(join(stateDir, "usage.json"), "garbage");
  const u = make();
  assert.equal(u.level(), "ok");
  u.record(10);
  assert.equal(u.percent().fiveHour, 1);
});

test("report reads like a sentence", () => {
  const { u } = setup();
  u.record(850);
  const r = u.report();
  assert.match(r, /5 hours: 85%/);
  assert.match(r, /paused/);
  assert.match(r, /easing in about 300 min/);
});
