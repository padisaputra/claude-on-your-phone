import test from "node:test";
import assert from "node:assert/strict";
import { parseCron, cronMatches, nextRun, isValidCron } from "./cron.js";

// Local-time dates, so the tests hold in any TZ.
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

test("star matches every minute", () => {
  assert.equal(cronMatches("* * * * *", at(2026, 10, 14, 13, 37)), true);
});

test("exact minute and hour", () => {
  assert.equal(cronMatches("30 8 * * *", at(2026, 10, 14, 8, 30)), true);
  assert.equal(cronMatches("30 8 * * *", at(2026, 10, 14, 8, 31)), false);
  assert.equal(cronMatches("30 8 * * *", at(2026, 10, 14, 9, 30)), false);
});

test("steps, ranges, lists", () => {
  for (const m of [0, 15, 30, 45]) assert.equal(cronMatches("*/15 * * * *", at(2026, 1, 1, 0, m)), true);
  assert.equal(cronMatches("*/15 * * * *", at(2026, 1, 1, 0, 20)), false);
  assert.equal(cronMatches("0 9-17/4 * * *", at(2026, 1, 1, 13)), true);
  assert.equal(cronMatches("0 9-17/4 * * *", at(2026, 1, 1, 15)), false);
  assert.equal(cronMatches("5,10,50 * * * *", at(2026, 1, 1, 3, 10)), true);
  assert.equal(cronMatches("10/20 * * * *", at(2026, 1, 1, 3, 50)), true);
  assert.equal(cronMatches("10/20 * * * *", at(2026, 1, 1, 3, 0)), false);
});

test("day of week 0 and 7 are both Sunday, ranges and names work", () => {
  const sunday = at(2026, 10, 18, 8); // 18 Oct 2026 is a Sunday
  assert.equal(sunday.getDay(), 0);
  assert.equal(cronMatches("0 8 * * 0", sunday), true);
  assert.equal(cronMatches("0 8 * * 7", sunday), true);
  assert.equal(cronMatches("0 8 * * 5-7", sunday), true);
  assert.equal(cronMatches("0 8 * * 1-5", sunday), false);
  assert.equal(cronMatches("0 8 * * mon-fri", at(2026, 10, 14, 8)), true);
  assert.equal(cronMatches("0 8 * * SAT,sun", sunday), true);
  assert.equal(cronMatches("0 8 1 jan *", at(2026, 1, 1, 8)), true);
});

test("dom and dow both set: either one matches", () => {
  assert.equal(cronMatches("0 8 1 * 1", at(2026, 10, 1, 8)), true); // Thursday the 1st
  assert.equal(cronMatches("0 8 1 * 1", at(2026, 10, 12, 8)), true); // a Monday
  assert.equal(cronMatches("0 8 1 * 1", at(2026, 10, 13, 8)), false);
  assert.equal(cronMatches("0 8 */2 * *", at(2026, 10, 13, 8)), true);
});

test("invalid expressions throw readable errors", () => {
  for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "5-1 * * * *", "a b c d e", "1,,2 * * * *"]) {
    assert.equal(isValidCron(bad), false, bad);
  }
  assert.throws(() => parseCron("61 * * * *"), /out of range/);
});

test("nextRun finds the next match", () => {
  assert.deepEqual(nextRun("0 8 * * 1-5", at(2026, 10, 14, 8, 0)), at(2026, 10, 15, 8, 0));
  assert.deepEqual(nextRun("0 8 * * 1-5", at(2026, 10, 16, 9, 0)), at(2026, 10, 19, 8, 0)); // Fri -> Mon
  assert.deepEqual(nextRun("*/15 * * * *", at(2026, 10, 14, 8, 7)), at(2026, 10, 14, 8, 15));
  assert.deepEqual(nextRun("0 0 29 2 *", at(2026, 3, 1)), at(2028, 2, 29));
  assert.equal(nextRun("0 0 31 2 *", at(2026, 1, 1)), null);
});
