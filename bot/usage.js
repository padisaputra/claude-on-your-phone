// Usage guard. The CLI can't tell us how much of the Claude plan is left, so we estimate it:
// every claude run reports its token counts, we keep them with a timestamp, and compare the
// rolling 5 hour and 7 day totals against limits you set (USAGE_LIMIT_5H, USAGE_LIMIT_WEEK).
//
// The bot, the CLI and every worker supervisor share usage.json, so each call re-reads it.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson, withLock } from "./outbox.js";

const HOUR = 3_600_000;
const FIVE_H = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;
const THRESHOLDS = [60, 80];

// Cache reads are cheap on the plan, so they count for a tenth.
export function weigh(usage) {
  if (typeof usage === "number") return usage;
  if (!usage || typeof usage !== "object") return 0;
  const n = (k) => Number(usage[k]) || 0;
  return n("input_tokens") + n("output_tokens") + n("cache_creation_input_tokens") + 0.1 * n("cache_read_input_tokens");
}

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

export function createUsage({ stateDir, limit5h = 2_000_000, limitWeek = 20_000_000, now = () => Date.now() }) {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, "usage.json");
  limit5h = Number(limit5h) || 2_000_000;
  limitWeek = Number(limitWeek) || 20_000_000;

  const load = () => {
    const s = readJson(file, null);
    return { records: Array.isArray(s?.records) ? s.records : [], announced: Array.isArray(s?.announced) ? s.announced : [] };
  };

  function record(usage) {
    const tokens = weigh(usage);
    if (!(tokens > 0)) return;
    withLock(file, () => {
      const s = load();
      const t = now();
      s.records = s.records.filter(([at]) => t - at < WEEK);
      s.records.push([t, Math.round(tokens)]);
      writeJson(file, s);
    });
  }

  function totals() {
    const t = now();
    let fiveHour = 0, week = 0, oldestIn5h = null;
    for (const [at, n] of load().records) {
      if (t - at >= WEEK) continue;
      week += n;
      if (t - at < FIVE_H) { fiveHour += n; oldestIn5h = Math.min(oldestIn5h ?? at, at); }
    }
    return { fiveHour, week, oldestIn5h };
  }

  function percent() {
    const { fiveHour, week } = totals();
    const p = (v, limit) => Math.round((v / limit) * 1000) / 10;
    const r = { fiveHour: p(fiveHour, limit5h), week: p(week, limitWeek) };
    return { ...r, worst: Math.max(r.fiveHour, r.week) };
  }

  function level() {
    const w = percent().worst;
    return w >= 80 ? "pause" : w >= 60 ? "queue" : "ok";
  }

  // Thresholds crossed since the last call, each announced once until usage falls back below it.
  // Jumping straight past both reports only the higher one: one notice, not two at once.
  function newlyCrossed() {
    const w = percent().worst;
    return withLock(file, () => {
      const s = load();
      const fresh = THRESHOLDS.filter((th) => w >= th && !s.announced.includes(th));
      const announced = THRESHOLDS.filter((th) => w >= th);
      if (String(announced) !== String(s.announced)) { s.announced = announced; writeJson(file, s); }
      return fresh.length ? [fresh.at(-1)] : [];
    });
  }

  function report() {
    const { fiveHour, week, oldestIn5h } = totals();
    const p = percent();
    const lvl = level();
    const lines = [
      `Plan usage (estimated from token counts):`,
      `5 hours: ${p.fiveHour}% (${fmt(fiveHour)} of ${fmt(limit5h)})`,
      `Week: ${p.week}% (${fmt(week)} of ${fmt(limitWeek)})`,
      lvl === "ok" ? "Background jobs: running normally."
        : lvl === "queue" ? "Background jobs: new ones wait until usage drops (60%+)."
        : "Background jobs: paused, only chat runs (80%+).",
    ];
    if (lvl !== "ok" && p.fiveHour >= 60 && oldestIn5h !== null) {
      const mins = Math.max(1, Math.round((oldestIn5h + FIVE_H - now()) / 60_000));
      lines.push(`The 5 hour window starts easing in about ${mins} min.`);
    }
    return lines.join("\n");
  }

  return { record, level, percent, newlyCrossed, report };
}
