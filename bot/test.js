import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitMessage, parseAllowlist, isAllowed, parseCheckinTime, writeJsonAtomic, dayStamp, logConvo } from "./lib.js";

test("short text stays in one piece", () => {
  assert.deepEqual(splitMessage("hello"), ["hello"]);
});

test("empty text still sends something", () => {
  assert.deepEqual(splitMessage("   "), ["(empty reply)"]);
});

test("long text splits under the limit and loses nothing", () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i} with some words`).join("\n");
  const parts = splitMessage(text, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1000);
  assert.equal(parts.join("\n").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
});

test("text with no spaces is hard cut", () => {
  const parts = splitMessage("x".repeat(2500), 1000);
  assert.deepEqual(parts.map((p) => p.length), [1000, 1000, 500]);
});

test("prefers paragraph breaks", () => {
  const text = "a".repeat(600) + "\n\n" + "b".repeat(600);
  assert.deepEqual(splitMessage(text, 1000), ["a".repeat(600), "b".repeat(600)]);
});

test("allowlist parsing", () => {
  assert.deepEqual([...parseAllowlist("123, 456 789")], [123, 456, 789]);
  assert.equal(parseAllowlist("abc,").size, 0);
  assert.equal(parseAllowlist(undefined).size, 0);
});

test("only allowlisted users in private chats get through", () => {
  const allow = parseAllowlist("42");
  const msg = (id, type = "private") => ({ from: { id }, chat: { type } });
  assert.equal(isAllowed(msg(42), allow), true);
  assert.equal(isAllowed(msg(43), allow), false);
  assert.equal(isAllowed(msg(42, "group"), allow), false);
  assert.equal(isAllowed(undefined, allow), false);
  assert.equal(isAllowed({ chat: { type: "private" } }, allow), false);
});

test("check-in time parsing", () => {
  assert.equal(parseCheckinTime(""), null);
  assert.equal(parseCheckinTime(undefined), null);
  assert.equal(parseCheckinTime("08:30"), 510);
  assert.equal(parseCheckinTime("8:05"), 485);
  assert.equal(parseCheckinTime("25:00"), undefined);
  assert.equal(parseCheckinTime("noon"), undefined);
});

test("atomic JSON write creates folders and leaves no temp file", () => {
  const dir = mkdtempSync(join(tmpdir(), "lib-"));
  const file = join(dir, "a", "b.json");
  writeJsonAtomic(file, { x: 1 });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { x: 1 });
  assert.deepEqual(readdirSync(join(dir, "a")), ["b.json"]);
});

test("day stamp is the local calendar day", () => {
  assert.equal(dayStamp(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});

test("conversation log appends lines and never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "lib-"));
  const t = new Date(2026, 0, 5, 12).toISOString();
  logConvo(dir, { t, key: "1", role: "user", text: "hi" });
  logConvo(dir, { t, key: "1", role: "agent", text: "hello" });
  const lines = readFileSync(join(dir, "convo", "2026-01-05.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.role), ["user", "agent"]);
  const blocked = mkdtempSync(join(tmpdir(), "lib-"));
  writeFileSync(join(blocked, "convo"), "a file where the folder should be");
  assert.doesNotThrow(() => logConvo(blocked, { t, key: "1", role: "user", text: "hi" }));
});
