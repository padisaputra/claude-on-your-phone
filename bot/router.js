// Sends each message to the right place. Commands that belong to the workers, schedules and usage guard
// are handled here; everything else (chat, /new, /status, /model, skills...) goes to the agent core.
import { COMMANDS_HELP } from "./agent.js";

const OWN_COMMANDS = [
  ["/jobs", "list background workers"],
  ["/stop <id>", "stop a background worker"],
  ["/schedule <text>", "schedule something, in plain words"],
  ["/schedules", "list scheduled jobs"],
  ["/unschedule <id>", "remove a scheduled job"],
  ["/usage", "how much of your plan is used"],
];

export const helpText = () =>
  "Just talk to me. Commands:\n" + [...COMMANDS_HELP, ...OWN_COMMANDS].map(([c, d]) => `${c}  ${d}`).join("\n");

export function createRouter({ agent, jobs, scheduler, usage }) {
  return async function route(key, text, emit) {
    const [cmd, ...rest] = text.trim().split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd.toLowerCase().replace(/@\w+$/, "")) { // Telegram may add @botname in groups
      case "/help":
        return emit(helpText());
      case "/jobs":
        return emit(jobs.format());
      case "/stop":
        return emit(!arg ? "Which one? Try /stop j1 (see /jobs)." : jobs.stop(arg) ? `Stopping ${arg}.` : `No running job called ${arg}.`);
      case "/usage":
        return emit(usage.report());
      case "/schedules":
        return emit(scheduler.format());
      case "/unschedule":
        return emit(!arg ? "Which one? Try /unschedule s1 (see /schedules)." : scheduler.remove(arg) ? `Removed ${arg}.` : `No schedule called ${arg}.`);
      case "/schedule":
        if (!arg) return emit('Tell me what and when, for example: /schedule every weekday 8:00 brief me on my calendar');
        try {
          const s = await scheduler.add(arg);
          return emit(`Scheduled ${s.id}: ${s.summary}`);
        } catch (e) {
          return emit(e.message);
        }
      default:
        return agent.handle(key, text, emit);
    }
  };
}
