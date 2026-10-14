// Runs one Claude Code turn as a child process. This is the only file that knows the claude CLI.
import { spawn } from "node:child_process";

// Chat turns still running. On shutdown they are killed, so a restart can never leave an old turn
// writing to the session the new process is about to resume. (Workers are detached and keep going.)
const children = new Set();
export const stopAllClaude = () => children.forEach((c) => c.kill("SIGTERM"));

export function makeClaudeRunner({ workdir, permissionMode, allowedTools, timeoutMs }) {
  // Returns { text, sessionId, usage, contextTokens, costUsd, failed }. The prompt goes in on stdin so it can never be read as a flag.
  // fork: resume a copy of the session (--fork-session), so a quick side reply never touches the main conversation.
  return function runClaude({ prompt, sessionId, appendSystemPrompt, model, fork }) {
    return new Promise((resolve) => {
      const args = ["-p", "--output-format", "json", "--permission-mode", permissionMode, "--allowedTools", allowedTools];
      if (sessionId) args.push("--resume", sessionId);
      if (sessionId && fork) args.push("--fork-session");
      if (model) args.push("--model", model);
      if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);

      // Claude does not need the Telegram token, so it never sees it.
      const env = { ...process.env };
      delete env.TELEGRAM_BOT_TOKEN;

      const child = spawn("claude", args, { cwd: workdir, env, stdio: ["pipe", "pipe", "pipe"] });
      children.add(child);
      let out = "";
      let err = "";
      let timedOut = false;
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.stdin.on("error", () => {}); // claude missing or crashed early: handled below
      child.on("error", (e) =>
        resolve({ text: `Could not start claude (is it installed for this user?): ${e.message}`, failed: true }));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGINT");
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      }, timeoutMs);

      child.on("close", () => {
        children.delete(child);
        clearTimeout(timer);
        if (timedOut) return resolve({ text: `Stopped: that took longer than ${timeoutMs / 60_000} minutes.`, failed: true });
        try {
          const json = JSON.parse(out);
          if (json.is_error) return resolve({ text: json.result || `Claude hit an error (${json.subtype}).`, failed: true });
          const usage = json.usage ?? {};
          const u = usage.iterations?.at(-1) ?? usage; // last API call, not the sum over a tool-heavy turn
          resolve({
            text: json.result || "(Claude returned no text)",
            sessionId: json.session_id,
            usage,
            contextTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
            costUsd: Number(json.total_cost_usd) || 0,
          });
        } catch {
          // Not JSON: login problems, a vanished session and bad flags land here.
          resolve({ text: (out + err).trim() || "Claude exited without output.", failed: true });
        }
      });
      child.stdin.end(prompt);
    });
  };
}
