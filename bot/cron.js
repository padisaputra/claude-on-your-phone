// A small five-field cron matcher ("m h dom mon dow"), local time. No dependencies.
// Supports *, lists (1,5), ranges (1-5), steps (*/15, 1-30/5, 10/20) and names (jan, mon).
// Day of week 0 and 7 are both Sunday. Like classic cron, when both day-of-month and
// day-of-week are restricted, a day matches if EITHER does.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS, offset: 0 },
];

function value(token, f) {
  const t = token.toLowerCase();
  if (f.names) {
    const i = f.names.indexOf(t);
    if (i >= 0) return i + f.offset;
  }
  if (!/^\d+$/.test(t)) throw new Error(`bad ${f.name} "${token}"`);
  const n = Number(t);
  if (n < f.min || n > f.max) throw new Error(`${f.name} ${n} is out of range ${f.min}-${f.max}`);
  return n;
}

function parseField(text, f) {
  const out = new Set();
  for (const part of text.split(",")) {
    if (!part) throw new Error(`empty item in ${f.name}`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`bad ${f.name} "${part}"`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in ${f.name} "${part}"`);
    let lo, hi;
    if (range === "*") [lo, hi] = [f.min, f.max];
    else if (range.includes("-")) {
      const [a, b] = range.split("-");
      [lo, hi] = [value(a, f), value(b, f)];
      if (lo > hi) throw new Error(`backwards range in ${f.name} "${part}"`);
    } else {
      lo = value(range, f);
      hi = stepText === undefined ? lo : f.max; // "10/20" means from 10 to the end, every 20
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

// Throws an Error with a readable message if the expression is invalid.
export function parseCron(expr) {
  const parts = String(expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5 || !parts[0]) throw new Error(`cron needs 5 fields, got "${expr}"`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) dow.add(0); // 7 is Sunday too
  return { minute, hour, dom, month, dow, domAny: parts[2].startsWith("*"), dowAny: parts[4].startsWith("*") };
}

export function isValidCron(expr) {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(c, d) {
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

// Does this cron fire in the minute that contains `date` (local time)?
export function cronMatches(expr, date) {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(date);
  return c.minute.has(d.getMinutes()) && c.hour.has(d.getHours()) && c.month.has(d.getMonth() + 1) && dayMatches(c, d);
}

// The first minute strictly after `from` that matches, or null if none within ~5 years
// (for example "0 0 31 2 *", which never happens).
export function nextRun(expr, from) {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = d.getTime() + 5 * 366 * 86_400_000;
  // Jump a month, day or hour at a time when that unit cannot match, so this stays fast.
  while (d.getTime() < limit) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
    } else if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
    } else {
      return d;
    }
  }
  return null;
}
