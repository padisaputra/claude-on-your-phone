// Everything that happens on a clock: user schedules, the nightly self-learning pass,
// the morning proposals message and the heartbeat. All of it is driven by tick(), which
// the bot calls every 30s. Each kind of run remembers which minute (or day) it last
// fired for, and marks that BEFORE awaiting anything, so overlapping ticks never double-fire.
// Runs missed while the bot was down are skipped, except one nightly catch-up per morning.
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseCron, cronMatches, nextRun } from "./cron.js";

const DAY_MS = 86_400_000;
const NIGHTLY_CONVO_CAP = 60_000; // chars of conversation log handed to the nightly run
const HEARTBEAT_LOG_KEEP = 200;
const QUIET_AFTER_USER_MIN = 20; // no heartbeat if the user wrote this recently

export const NO_CODE_RULE =
  "NEVER change code, config, scripts, cron, packages or installed software yourself, and never edit files outside memory/. " +
  "Any bigger idea (a code or config change, installing something, a new automation) goes into memory/proposals.md " +
  "as a numbered proposal (one short paragraph each: what, why, risk) for the user to approve.";

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${file}.tmp`, file); // atomic, so a crash can't leave half a file
}

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const minuteStart = (d) => Math.floor(d.getTime() / 60_000) * 60_000;
const minuteOfDay = (d) => d.getHours() * 60 + d.getMinutes();
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const human = (d) => `${WEEKDAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${hhmm(d)}`;

// "03:00" -> 180. Bad input falls back to the default.
export function parseClock(text, fallback) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : parseClock(fallback, "00:00");
}

// "09:00-22:00" -> {start: 540, end: 1320}. end may be before start (window over midnight).
export function parseHours(text, fallback = "09:00-22:00") {
  const [a, b] = String(text ?? "").split("-");
  const [fa, fb] = fallback.split("-");
  return { start: parseClock(a, fa), end: parseClock(b, fb) };
}

function inWindow(min, { start, end }) {
  return start <= end ? min >= start && min < end : min >= start || min < end;
}

// Timestamps from other modules may be ms numbers or ISO strings.
const toMs = (v) => (typeof v === "number" ? v : v ? Date.parse(v) || 0 : 0);

// A reply starting with "PASS" (any case) means stay quiet.
export function isPass(reply) {
  return /^pass\b/i.test(String(reply ?? "").trim()) || !String(reply ?? "").trim();
}

// Pull the JSON object out of a model reply that may have code fences or chatter around it.
export function parseScheduleReply(reply) {
  let text = String(reply ?? "").replace(/```(?:json)?/gi, "");
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try {
    const obj = JSON.parse(text.slice(a, b + 1));
    if (!obj || typeof obj.cron !== "string" || typeof obj.prompt !== "string" || !obj.prompt.trim()) return null;
    parseCron(obj.cron); // throws on a bad expression
    return {
      cron: obj.cron.trim().split(/\s+/).join(" "),
      prompt: obj.prompt.trim(),
      summary: String(obj.summary || obj.prompt).trim().slice(0, 200),
      once: obj.once === true,
    };
  } catch {
    return null;
  }
}

export function createScheduler({ stateDir, workdir, oneShot, notify, addContext, jobs, usage, lastUserAt, now = () => new Date(), config = {} }) {
  const cfg = {
    nightlyAt: "03:00",
    nightlyOn: true,
    heartbeatOn: true,
    heartbeatEveryMin: 30,
    heartbeatHours: "09:00-22:00",
    heartbeatMaxPerDay: 3,
    morningAt: "08:30",
    chatKey: "",
    ...config,
  };
  const clock = () => new Date(now());
  mkdirSync(stateDir, { recursive: true });
  const files = {
    schedules: join(stateDir, "schedules.json"),
    nightly: join(stateDir, "nightly.json"),
    heartbeat: join(stateDir, "heartbeat.json"),
  };
  const memDir = join(workdir, "memory");
  const busy = { nightly: false, heartbeat: false };

  const loadSchedules = () => readJson(files.schedules, { nextId: 1, schedules: [] });
  const say = async (text) => {
    try {
      await notify(text);
    } catch (e) {
      console.error("scheduler notify failed:", e.message);
    }
  };
  const tellAgent = (text) => {
    try {
      addContext(cfg.chatKey, text);
    } catch (e) {
      console.error("scheduler addContext failed:", e.message);
    }
  };

  // ---------- schedules ----------

  async function add(text) {
    const request = String(text ?? "").trim();
    if (!request) throw new Error('Tell me what to schedule, for example: /schedule every weekday 8:00 brief me on the news');
    const t = clock();
    const prompt = [
      "Turn this scheduling request into a cron job. Reply with ONLY a JSON object, no other text:",
      '{"cron":"m h dom mon dow","prompt":"...","summary":"...","once":false}',
      "Rules:",
      "- cron is a standard five-field cron expression in the server's local time.",
      `- The current local time is ${WEEKDAYS[t.getDay()]} ${dayKey(t)} ${hhmm(t)}.`,
      "- prompt is the instruction a fresh agent will run at that time. It must be self-contained: it will not see this conversation.",
      "- summary is a short human description, like \"Weekdays 08:00: news briefing\".",
      '- For a one-time reminder, use the specific minute, hour, day and month, and set "once":true.',
      "",
      `Request: ${request}`,
    ].join("\n");
    const parsed = parseScheduleReply(await oneShot(prompt));
    if (!parsed) {
      throw new Error("Sorry, I could not turn that into a schedule. Try saying when and what, like: every weekday 8:00 brief me on the news.");
    }
    const data = loadSchedules();
    const item = { id: `s${data.nextId}`, ...parsed, lastRun: 0 };
    data.nextId += 1;
    data.schedules.push(item);
    writeJson(files.schedules, data);
    return { id: item.id, summary: item.summary };
  }

  const list = () => loadSchedules().schedules;

  function remove(id) {
    const data = loadSchedules();
    const before = data.schedules.length;
    data.schedules = data.schedules.filter((s) => s.id !== String(id).trim());
    if (data.schedules.length === before) return false;
    writeJson(files.schedules, data);
    return true;
  }

  function format() {
    const items = list();
    if (!items.length) return 'No schedules yet. Add one with /schedule, for example: /schedule every weekday 8:00 brief me on the news';
    const t = clock();
    return items
      .map((s) => {
        const next = nextRun(s.cron, t);
        return `${s.id}: ${s.summary}${s.once ? " (once)" : ""}\n   next: ${next ? human(next) : "never"}`;
      })
      .join("\n");
  }

  async function runSchedule(s) {
    try {
      const out = String(await oneShot(s.prompt)).trim() || "(the scheduled job finished with no output)";
      await say(out);
      tellAgent(`[scheduled job ${s.id} ran and told the user: ${out.slice(0, 1500)}]`);
    } catch (e) {
      await say(`Scheduled job ${s.id} (${s.summary}) failed: ${e.message}`);
    }
  }

  // Mark every due schedule for this minute, save, then run them. Marking first is what
  // makes a second tick in the same minute (or an overlapping one) a no-op.
  function claimDueSchedules(t) {
    const data = loadSchedules();
    const minute = minuteStart(t);
    const due = [];
    for (const s of data.schedules) {
      let matches = false;
      try {
        matches = cronMatches(s.cron, t);
      } catch {
        continue; // a hand-edited bad line should not stop the others
      }
      if (matches && (s.lastRun ?? 0) < minute) {
        s.lastRun = minute;
        due.push({ ...s });
      }
    }
    if (!due.length) return [];
    data.schedules = data.schedules.filter((s) => !(s.once && due.some((d) => d.id === s.id)));
    writeJson(files.schedules, data);
    return due;
  }

  // ---------- nightly self-learning ----------

  function conversationSince(sinceMs, untilMs) {
    const dir = join(stateDir, "convo");
    if (!existsSync(dir)) return "";
    const fromDay = dayKey(new Date(sinceMs - DAY_MS)); // a day of slack for UTC vs local file names
    const lines = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
      if (name.slice(0, 10) < fromDay) continue;
      for (const raw of readFileSync(join(dir, name), "utf8").split("\n")) {
        if (!raw.trim()) continue;
        try {
          const turn = JSON.parse(raw);
          const at = toMs(turn.t);
          if (at <= sinceMs || at > untilMs) continue;
          lines.push({ at, line: `[${dayKey(new Date(at))} ${hhmm(new Date(at))}] ${turn.role === "user" ? "user" : "you"}: ${turn.text}` });
        } catch {
          // skip a broken line
        }
      }
    }
    lines.sort((a, b) => a.at - b.at);
    let text = lines.map((l) => l.line).join("\n");
    if (text.length > NIGHTLY_CONVO_CAP) {
      text = "(older part cut to fit)\n" + text.slice(text.length - NIGHTLY_CONVO_CAP); // keep the most recent
    }
    return text;
  }

  function nightlyPrompt(t, convo) {
    return [
      `It is ${WEEKDAYS[t.getDay()]} ${dayKey(t)} ${hhmm(t)}. This is your nightly review. Nobody is waiting for a reply.`,
      "You have file tools (Read, Edit, Write, Glob, Grep). Your working directory has memory/ with your notes.",
      "Below is the conversation log since the last nightly review. Do these, in order:",
      "1. Update the notes in memory/ with new lasting facts, preferences and corrections from the log.",
      `2. Append a short dated entry (## ${dayKey(t)}) to memory/journal.md: what happened, what you learned.`,
      "3. Add or update memory/lessons.md for every mistake the user corrected, phrased as a rule for next time.",
      "4. Merge duplicate memories and prune ones that are stale or wrong. Keep notes short.",
      `5. ${NO_CODE_RULE}`,
      "Do not message the user. When done, reply with one line saying what you changed.",
      "",
      "--- conversation log ---",
      convo,
    ].join("\n");
  }

  // Due exactly at nightlyAt. If the bot was down then, one catch-up run is allowed later the
  // same morning (until 12:00) as long as the last run was over 24h ago.
  function nightlyDue(t, state) {
    const at = parseClock(cfg.nightlyAt, "03:00");
    const today = new Date(t);
    today.setHours(Math.floor(at / 60), at % 60, 0, 0);
    const last = state.lastRun ?? 0;
    if (last >= today.getTime()) return false;
    const m = minuteOfDay(t);
    if (m === at) return true;
    const windowEnd = at < 12 * 60 ? 12 * 60 : 24 * 60;
    return m > at && m < windowEnd && t.getTime() - last >= DAY_MS;
  }

  async function runNightly(t, state) {
    const since = state.lastRun || t.getTime() - DAY_MS;
    const convo = conversationSince(since, t.getTime());
    const record = { lastRun: t.getTime(), lastMorning: state.lastMorning, runs: (state.runs ?? []).slice(-29) };
    writeJson(files.nightly, record); // claim the run before the long model call
    let result;
    if (!convo) result = { at: t.getTime(), skipped: "no conversation since the last review" };
    else {
      try {
        const out = await oneShot(nightlyPrompt(t, convo));
        result = { at: t.getTime(), ok: true, chars: convo.length, reply: String(out).slice(0, 500) };
      } catch (e) {
        result = { at: t.getTime(), ok: false, error: e.message };
      }
    }
    const latest = readJson(files.nightly, record);
    latest.runs = [...(latest.runs ?? []), result].slice(-30);
    writeJson(files.nightly, latest);
  }

  function proposalsText() {
    try {
      const text = readFileSync(join(memDir, "proposals.md"), "utf8").trim();
      // only headings and blank lines means there is nothing to ask about
      return text.split("\n").some((l) => l.trim() && !/^#/.test(l.trim())) ? text : "";
    } catch {
      return "";
    }
  }

  async function runMorning() {
    const text = proposalsText();
    if (!text) return;
    const shown = text.length > 3000 ? text.slice(0, 3000) + "\n(more in memory/proposals.md)" : text;
    await say(`Good morning. Overnight I wrote down some ideas I will only act on with your ok:\n\n${shown}\n\nReply ok or no for each number, like "1 ok, 2 no".`);
    tellAgent(
      "[The nightly review just sent the user the proposals in memory/proposals.md, asking ok or no for each number. " +
        "When the user answers, apply the approved ones, and delete every answered proposal (approved or not) from memory/proposals.md. " +
        "Leave unanswered ones in place. Do not apply anything the user did not approve.]"
    );
  }

  // ---------- heartbeat ----------

  function heartbeatSlot(t) {
    const every = Math.max(1, Number(cfg.heartbeatEveryMin) || 30);
    const hours = parseHours(cfg.heartbeatHours);
    const m = minuteOfDay(t);
    if (!inWindow(m, hours)) return null; // quiet hours
    const sinceStart = (m - hours.start + 1440) % 1440;
    return sinceStart % every === 0 ? minuteStart(t) : null;
  }

  function heartbeatPrompt(t, hb) {
    const end = new Date(t);
    end.setHours(23, 59, 59, 999);
    const upcoming = list()
      .map((s) => ({ s, next: nextRun(s.cron, t) }))
      .filter((x) => x.next && x.next <= end)
      .map((x) => `- ${hhmm(x.next)} ${x.s.summary}`);
    const since = hb.lastAt ?? t.getTime() - DAY_MS; // first heartbeat: look back one day
    let jobLines = [];
    try {
      jobLines = (jobs?.list() ?? [])
        .filter((j) => j.status === "running" || j.status === "queued" || j.status === "paused" || toMs(j.finishedAt) > since)
        .map((j) => `- ${j.id} "${j.title}": ${j.status}`);
    } catch {
      // jobs are optional context
    }
    const sent = hb.sent?.[dayKey(t)] ?? 0;
    const lastUser = toMs(lastUserAt?.(cfg.chatKey));
    const quietFor = lastUser ? `${((t.getTime() - lastUser) / 3_600_000).toFixed(1)} hours` : "unknown";
    return [
      "Decide whether to text the user right now. Reply exactly PASS if nothing is worth it, otherwise reply with only the message.",
      "PASS is the default. Prefer PASS. Only write a message if it is clearly useful or welcome right now. Keep any message to one or two short sentences.",
      "Good reasons look like: a scheduled item coming up soon that needs preparation, a background job that just finished, or a brief check-in after a long quiet stretch.",
      "",
      `Local time: ${WEEKDAYS[t.getDay()]} ${dayKey(t)} ${hhmm(t)}`,
      `Schedules still to run today:\n${upcoming.length ? upcoming.join("\n") : "- none"}`,
      `Background jobs (running, or finished since the last check):\n${jobLines.length ? jobLines.join("\n") : "- none"}`,
      `Proactive messages already sent today: ${sent} of ${cfg.heartbeatMaxPerDay}`,
      `Time since the user's last message: ${quietFor}`,
    ].join("\n");
  }

  async function runHeartbeat(t, slot) {
    const hb = readJson(files.heartbeat, { lastSlot: 0, sent: {}, log: [] });
    if ((hb.lastSlot ?? 0) >= slot) return;
    hb.lastSlot = slot;
    const today = dayKey(t);
    const sent = hb.sent?.[today] ?? 0;
    const log = (entry) => {
      hb.log = [...(hb.log ?? []), { t: t.toISOString(), ...entry }].slice(-HEARTBEAT_LOG_KEEP);
      writeJson(files.heartbeat, hb);
    };

    let skip = null;
    const level = usage?.level?.() ?? "ok";
    const lastUser = toMs(lastUserAt?.(cfg.chatKey));
    if (level !== "ok") skip = `usage level ${level}`;
    else if (sent >= cfg.heartbeatMaxPerDay) skip = `daily cap ${cfg.heartbeatMaxPerDay} reached`;
    else if (lastUser && t.getTime() - lastUser < QUIET_AFTER_USER_MIN * 60_000) skip = "user wrote in the last 20 minutes";
    if (skip) return log({ decision: "skipped", reason: skip });

    writeJson(files.heartbeat, hb); // claim the slot before the model call
    const prompt = heartbeatPrompt(t, hb);
    let reply;
    try {
      reply = String(await oneShot(prompt)).trim();
    } catch (e) {
      return log({ decision: "skipped", reason: `model error: ${e.message}` });
    }
    hb.lastAt = t.getTime();
    // keep only recent days in the counter
    hb.sent = Object.fromEntries(Object.entries(hb.sent ?? {}).filter(([d]) => d >= dayKey(new Date(t.getTime() - 7 * DAY_MS))));
    if (isPass(reply)) return log({ decision: "PASS" });
    hb.sent[today] = sent + 1;
    log({ decision: "message", text: reply.slice(0, 500) });
    await say(reply);
    tellAgent(`[you texted the user on your own: ${reply.slice(0, 1500)}]`);
  }

  // ---------- tick ----------

  async function tick() {
    const t = clock();
    const work = claimDueSchedules(t).map(runSchedule);

    if (cfg.nightlyOn && !busy.nightly) {
      const state = readJson(files.nightly, {});
      if (nightlyDue(t, state)) {
        busy.nightly = true;
        work.push(runNightly(t, state).finally(() => (busy.nightly = false)));
      }
    }

    const morningAt = parseClock(cfg.morningAt, "08:30");
    if (minuteOfDay(t) === morningAt) {
      const state = readJson(files.nightly, {});
      if (state.lastMorning !== dayKey(t)) {
        writeJson(files.nightly, { ...state, lastMorning: dayKey(t) });
        work.push(runMorning());
      }
    }

    if (cfg.heartbeatOn && !busy.heartbeat) {
      const slot = heartbeatSlot(t);
      if (slot !== null) {
        busy.heartbeat = true;
        work.push(runHeartbeat(t, slot).finally(() => (busy.heartbeat = false)));
      }
    }

    const results = await Promise.allSettled(work);
    for (const r of results) if (r.status === "rejected") console.error("scheduler:", r.reason);
  }

  return { add, list, remove, format, tick };
}
