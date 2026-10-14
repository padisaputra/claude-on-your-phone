// Small helpers, kept separate so they are easy to test.
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Split text into chunks that fit in one Telegram message (the hard limit is 4096).
// Prefers to cut at a blank line, then a newline, then a space.
export function splitMessage(text, limit = 4000) {
  const chunks = [];
  let rest = String(text).trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (cut < limit / 2) cut = limit; // no good break point, hard cut
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.length ? chunks : ["(empty reply)"];
}

// "123, 456" -> Set { 123, 456 }. Anything that is not a number is ignored.
export function parseAllowlist(value) {
  const ids = String(value ?? "")
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  return new Set(ids);
}

// Only the allowlisted person, talking to the bot in a private chat.
export function isAllowed(message, allowlist) {
  return Boolean(
    message?.from && message.chat?.type === "private" && allowlist.has(message.from.id)
  );
}

// "08:30" -> minutes since midnight. Empty -> null (off). Anything else -> undefined (invalid).
export function parseCheckinTime(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

// Write JSON so a crash can never leave half a file: write a temp file, then rename over the real one.
export function writeJsonAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

// Local calendar day as YYYY-MM-DD (follows TZ), used to name the daily conversation log.
export function dayStamp(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Append one line to stateDir/convo/YYYY-MM-DD.jsonl. Logging must never break a reply, so errors are swallowed.
export function logConvo(stateDir, entry) {
  try {
    const dir = join(stateDir, "convo");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${dayStamp(entry.t)}.jsonl`), JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error(`conversation log: ${e.message}`);
  }
}
