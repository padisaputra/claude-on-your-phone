// The agent core: take a message, emit replies. Knows nothing about Telegram,
// so any other front-end (another chat app, a phone app) can call handle() the same way.
//
// Memory:    <workdir>/memory/*.md is loaded into every fresh session.
// Session:   the Claude session id is saved to disk and resumed across restarts.
// Rotation:  before a session gets too full (or after a long quiet gap) the agent writes memory/handoff.md
//            and quietly starts a fresh session from memory plus the last few messages. The user never sees it,
//            so the chat never runs out of context and never needs /compact.
// Fast lane: a message that arrives while a turn is running gets a quick reply from a fork of the session,
//            and the main session hears about it on its next turn.
import { readFileSync, mkdirSync, readdirSync, existsSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic, logConvo } from "./lib.js";

const HANDOFF_PROMPT =
  "Housekeeping, not from the user: this session is about to be refreshed. Write memory/handoff.md now: what we were in the " +
  "middle of, open threads, decisions made, and anything you would need to carry on smoothly. Also save any new lasting facts " +
  "to the right note in memory/. Then reply with just: done.";
const FAST_NOTE =
  "Your main self is busy with a longer task. Answer briefly and naturally; do not start long work, say you will pick it up after if needed.";

export const COMMANDS_HELP = [
  ["/new", "start a fresh conversation (memory notes stay)"],
  ["/clear", "same as /new"],
  ["/compact", "tidy up now: save a handoff note and continue in a fresh, light session"],
  ["/status", "session, context use, model, memory, uptime"],
  ["/model", "show the model, or /model <name> to switch (opus, sonnet, haiku or a full id), /model default to reset"],
  ["/cost", "tokens and estimated cost of this session"],
];

// All memory notes joined into one block, handoff first. Capped so a big folder can't swamp the context.
export function loadMemory(workdir, maxChars = 30_000) {
  const dir = join(workdir, "memory");
  if (!existsSync(dir)) return "";
  const names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  names.sort((a, b) => (a === "handoff.md" ? -1 : b === "handoff.md" ? 1 : a.localeCompare(b)));
  let text = "";
  for (const name of names) {
    const body = readFileSync(join(dir, name), "utf8").trim();
    if (body) text += `\n\n--- memory/${name} ---\n${body}`;
  }
  if (!text) return "";
  const note = text.length > maxChars ? "\n\n(Memory was cut to fit. Read the files in memory/ for the rest.)" : "";
  return "Your saved memory, loaded at the start of this session:" + text.slice(0, maxChars) + note;
}

export function createAgent({
  workdir, stateDir, runClaude, maxTurns = 40, contextWindow = 200_000, rotateAt = 0.6,
  idleHours = 6, recentKeep = 6, now = () => Date.now(),
}) {
  mkdirSync(workdir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const ms = () => +now(); // now may return a Date or a number
  const startedAt = ms();
  const stateFile = join(stateDir, "sessions.json");
  const busy = new Set(); // keys with a main turn (or its handoff) in flight

  // key -> { sessionId, turns, contextTokens, tokens, costUsd, totalCostUsd, model, recent[], pending[], lastUserAt, lastTurnAt }
  let sessions = {};
  try {
    sessions = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    // first run, or an unreadable file: start with no saved sessions
  }
  const save = () => writeJsonAtomic(stateFile, sessions);
  const state = (key) => {
    const s = (sessions[key] ??= {});
    s.recent ??= [];
    s.pending ??= [];
    return s;
  };
  const dropSession = (s) => Object.assign(s, { sessionId: undefined, turns: 0, contextTokens: 0, tokens: 0, costUsd: 0, handoffFails: 0 });
  const remember = (s, role, text) => {
    s.recent.push({ role, text: String(text).slice(0, 2000) });
    s.recent.splice(0, Math.max(0, s.recent.length - recentKeep));
  };
  const log = (key, role, text) => logConvo(stateDir, { t: new Date(ms()).toISOString(), key, role, text });

  const handoffTime = () => {
    try {
      return statSync(join(workdir, "memory", "handoff.md")).mtimeMs;
    } catch {
      return 0;
    }
  };
  // After a fresh session has read the handoff, move it aside so it is not replayed forever.
  const archiveHandoff = () => {
    const file = join(workdir, "memory", "handoff.md");
    if (!existsSync(file)) return;
    const dir = join(workdir, "memory", "archive");
    mkdirSync(dir, { recursive: true });
    renameSync(file, join(dir, `handoff-${new Date(ms()).toISOString().replace(/[:.]/g, "-")}.md`));
  };
  const memoryCount = () => {
    try {
      return readdirSync(join(workdir, "memory")).filter((n) => n.endsWith(".md")).length;
    } catch {
      return 0;
    }
  };

  // What a brand new session starts with: memory (handoff first), then the last few messages word for word.
  const freshContext = (s, extra) => {
    const recent = s.recent.length
      ? "The most recent messages of our conversation, carried over so you can continue naturally " +
        "(do not mention any restart or session change):\n" +
        s.recent.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text}`).join("\n")
      : "";
    return [loadMemory(workdir), recent, extra].filter(Boolean).join("\n\n") || undefined;
  };
  const usageTokens = (u = {}) =>
    (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

  // One main turn: resume the saved session, or start fresh with memory and recent messages.
  async function mainTurn(s, text) {
    // Slash commands that go to claude must stay first in the prompt, so notes wait for a normal message.
    const notes = text.startsWith("/") ? [] : s.pending.splice(0);
    const prompt = notes.length ? `${notes.join("\n")}\n\n${text}` : text;
    const model = s.model || undefined;
    const fresh = () => runClaude({ prompt, appendSystemPrompt: freshContext(s), model });
    let res = s.sessionId ? await runClaude({ prompt, sessionId: s.sessionId, model }) : await fresh();
    if (res.failed && s.sessionId && /no conversation found/i.test(res.text)) {
      dropSession(s);
      res = await fresh();
    }
    if (res.failed || !res.sessionId) {
      s.pending.unshift(...notes); // not delivered, keep them for next time
      save();
      return res;
    }
    if (s.sessionId !== res.sessionId) {
      if (!s.sessionId) archiveHandoff();
      dropSession(s);
    }
    s.sessionId = res.sessionId;
    s.turns = (s.turns || 0) + 1;
    s.contextTokens = res.contextTokens ?? 0;
    s.tokens = (s.tokens || 0) + usageTokens(res.usage);
    s.costUsd = (s.costUsd || 0) + (res.costUsd || 0);
    s.totalCostUsd = (s.totalCostUsd || 0) + (res.costUsd || 0);
    s.lastTurnAt = ms();
    remember(s, "user", text);
    remember(s, "agent", res.text);
    save();
    return res;
  }

  // Ask the old session to write its handoff note. True only if the file really changed.
  async function writeHandoff(s) {
    if (!s.sessionId) return false;
    const before = handoffTime();
    const res = await runClaude({ prompt: HANDOFF_PROMPT, sessionId: s.sessionId, model: s.model || undefined });
    s.totalCostUsd = (s.totalCostUsd || 0) + (res.costUsd || 0);
    return !res.failed && handoffTime() > before;
  }

  const needsRotation = (s) => s.sessionId && (s.contextTokens >= contextWindow * rotateAt || s.turns >= maxTurns);

  // Quick side reply while the main turn runs. Never saves or rotates the main session.
  async function fastLane(s, text, say) {
    const model = s.model || undefined;
    const res = s.sessionId
      ? await runClaude({ prompt: text, sessionId: s.sessionId, fork: true, appendSystemPrompt: FAST_NOTE, model })
      : await runClaude({ prompt: text, appendSystemPrompt: freshContext(s, FAST_NOTE), model });
    if (res.failed) {
      s.pending.push(`[while you were busy, the user said "${text}" and got no reply yet: answer it now]`);
      save();
      return say("Still busy with the last thing. I noted this and will pick it up with your next message.");
    }
    s.pending.push(`[while you were busy, the user said "${text}" and a quick reply said "${res.text}": ` +
      "do not answer it again, just carry on, only act if it needs doing]");
    remember(s, "user", text);
    remember(s, "agent", res.text);
    save();
    return say(res.text);
  }

  function status(key) {
    const s = state(key);
    const k = (n) => `${Math.round(n / 1000)}k`;
    const mins = Math.round((ms() - startedAt) / 60_000);
    return [
      s.sessionId ? `Session: ${s.sessionId.slice(0, 8)}, turn ${s.turns} of ${maxTurns}` : "Session: none yet (the next message starts one)",
      `Context: about ${k(s.contextTokens ?? 0)} of ${k(contextWindow)} tokens, refreshes at ${k(contextWindow * rotateAt)}`,
      `Model: ${s.model || "default"}`,
      `Memory notes: ${memoryCount()}`,
      `Up for ${mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} h`}`,
    ].join("\n");
  }

  const commands = {
    "/start": () => "Hi! Just text me like a friend. I remember what matters between conversations.\n\n" +
      COMMANDS_HELP.map(([c, d]) => `${c} ${d}`).join("\n"),
    "/new": (s, arg, key) => {
      if (busy.has(key)) return "I'm in the middle of something. Send /new again when I'm done."; // else the running turn would save the old session back
      dropSession(s);
      s.recent = [];
      s.pending = [];
      return "Fresh start. I still remember what's in my notes. What's next?";
    },
    "/compact": async (s, arg, key) => {
      if (busy.has(key)) return "I'm in the middle of something. Send /compact again when I'm done.";
      if (!s.sessionId) return "Already fresh, nothing to tidy.";
      busy.add(key);
      try {
        const ok = await writeHandoff(s);
        dropSession(s);
        return ok ? "Done. Saved a handoff note; we carry on in a fresh, light session."
          : "Done. The handoff note did not save, but the last few messages carry over, so we carry on from here.";
      } finally {
        busy.delete(key);
      }
    },
    "/status": (s, arg, key) => status(key),
    "/model": (s, arg) => {
      if (!arg) return `Model: ${s.model || "default"}. Switch with /model opus, /model sonnet, /model haiku or a full model id.`;
      if (/^(default|reset|none)$/i.test(arg)) {
        delete s.model;
        return "Model reset to the default.";
      }
      if (!/^[\w.:@/[\]-]+$/.test(arg) || arg.startsWith("-")) return "That does not look like a model name.";
      s.model = arg;
      return `Model set to ${arg}. It applies from the next message.`;
    },
    "/cost": (s) => {
      const usd = (n) => (n ? `$${n.toFixed(4)}` : "n/a");
      return `This session: ${s.tokens ?? 0} tokens, estimated cost ${usd(s.costUsd)}.\n` +
        `Since the start: ${usd(s.totalCostUsd)}.\n` +
        "On a Pro or Max plan this is not billed; it is an estimate of what the same use would cost on the API.";
    },
  };
  commands["/clear"] = commands["/new"];

  async function handle(key, text, emit) {
    const out = [];
    const say = async (t) => {
      out.push(t);
      log(key, "agent", t);
      if (emit) await emit(t);
    };
    text = String(text ?? "").trim();
    if (!text) {
      await say("I only understand text for now.");
      return out;
    }
    const s = state(key);
    log(key, "user", text);
    s.lastUserAt = ms();
    save();

    const word = text.split(/\s/)[0];
    const cmd = commands[word.toLowerCase().replace(/@\w+$/, "")]; // Telegram may send /status@botname
    if (cmd) {
      const reply = await cmd(s, text.slice(word.length).trim(), key);
      save();
      await say(reply);
      return out;
    }
    if (busy.has(key)) {
      await fastLane(s, text, say);
      return out;
    }

    busy.add(key);
    try {
      // Long quiet gap: hand off the old session first so today starts light. Failure is fine, recent messages carry over.
      if (s.sessionId && s.lastTurnAt && ms() - s.lastTurnAt >= idleHours * 3_600_000) {
        await writeHandoff(s);
        dropSession(s);
        save();
      }
      const res = await mainTurn(s, text);
      await say(res.text); // the reply goes out first; housekeeping below is invisible
      if (!res.failed && needsRotation(s)) {
        // Rotate once the note is safely written. If it keeps failing, rotate anyway: recent messages still carry over.
        if ((await writeHandoff(s)) || (s.handoffFails = (s.handoffFails || 0) + 1) >= 2) dropSession(s);
        save();
      }
    } finally {
      busy.delete(key);
    }
    return out;
  }

  // A fresh, unsaved session with memory: for scheduled and background prompts.
  async function oneShot(prompt) {
    const res = await runClaude({ prompt, appendSystemPrompt: loadMemory(workdir) || undefined });
    if (res.failed) throw new Error(res.text);
    return res.text;
  }

  // A note for the main session, delivered at the start of its next turn.
  function addContext(key, text) {
    state(key).pending.push(`[note: ${text}]`);
    save();
  }

  return {
    handle, oneShot, addContext, status,
    lastUserAt: (key) => sessions[key]?.lastUserAt ?? 0,
    sessions: () => sessions,
  };
}
