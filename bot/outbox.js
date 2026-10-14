// The outbox: how anything that is not the bot (workers, the agent via send.js) messages the user.
// Claude children never get the Telegram token, so they drop a small JSON file here and the bot sends it.
//
// Also home to the tiny state-file helpers (atomic JSON write, cross-process lock) that usage.js and
// jobs.js share, because the bot, the CLI and every worker supervisor write the same files.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultStateDir() {
  return process.env.CLAUDE_PHONE_STATE || join(homedir(), ".claude-phone");
}

const rand = () => Math.random().toString(36).slice(2, 8);

// Write to a temp file, then rename: a reader never sees half a file.
export function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${rand()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1));
  renameSync(tmp, file);
}

// Missing file -> fallback. Corrupt file -> moved aside (kept for a human to look at) and fallback.
export function readJson(file, fallback) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
    return fallback;
  }
}

// A cross-process lock around a read-modify-write, so the bot and a worker can't lose each other's update.
// mkdir is atomic on every filesystem. The critical sections are a few sync fs calls, so a short spin is fine.
const sleeper = new Int32Array(new SharedArrayBuffer(4));
export function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  let owned = false;
  while (!owned) {
    try {
      mkdirSync(lock);
      owned = true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        // A process that died holding the lock must not block everyone forever.
        if (Date.now() - statSync(lock).mtimeMs > 10_000) { rmSync(lock, { recursive: true, force: true }); continue; }
      } catch {}
      if (Date.now() > deadline) break; // never freeze the bot; worst case is one racy write
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    if (owned) rmSync(lock, { recursive: true, force: true });
  }
}

let seq = 0;
export function enqueue(stateDir, text) {
  const dir = join(stateDir, "outbox");
  mkdirSync(dir, { recursive: true });
  // Zero-padded time plus a per-process counter, so sorting by name is sending order.
  const name = `${String(Date.now()).padStart(15, "0")}-${String(seq++ % 1e6).padStart(6, "0")}-${process.pid}-${rand()}.json`;
  writeJson(join(dir, name), { text: String(text) });
  return name;
}

// Send everything waiting, oldest first. A file is deleted only after it was sent, so a Telegram outage
// just means the messages go out later. Stops at the first failure to keep the order.
const draining = new Set();
export async function drain(stateDir, sendFn) {
  const dir = join(stateDir, "outbox");
  if (draining.has(dir)) return 0; // the bot calls this on a timer; a slow send must not double-send
  draining.add(dir);
  let sent = 0;
  try {
    let names = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { return 0; }
    for (const name of names) {
      const file = join(dir, name);
      const msg = readJson(file, null);
      if (!msg || typeof msg.text !== "string" || !msg.text.trim()) { rmSync(file, { force: true }); continue; }
      try {
        await sendFn(msg.text);
      } catch (e) {
        console.error(`outbox: send failed, will retry: ${e.message}`);
        break;
      }
      rmSync(file, { force: true });
      sent++;
    }
  } finally {
    draining.delete(dir);
  }
  return sent;
}
