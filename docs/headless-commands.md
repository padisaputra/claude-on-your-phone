# Slash commands in headless mode

The bot runs Claude Code as `claude -p` (headless). Not every slash command works there. This table records what was
tested on Claude Code 2.1.299 (October 2026) with `claude -p --output-format json --resume <id> --fork-session`, plus
the official docs. A message starting with `/` that the bot does not own is passed to claude unchanged.

| Command | In `claude -p` | What the bot does |
|---|---|---|
| `/your-skill`, `.claude/commands/*.md`, `~/.claude/commands`, `~/.claude/skills` | Works. Expanded before the run, `$ARGUMENTS` filled in (tested: a project command returned its templated reply). | Passed through. |
| Built-in skills such as `/review`, `/init` | Work, run as a normal turn. | Passed through. |
| `/context` | Works, prints the context usage table without a model call. | Passed through. The bot also tracks context itself (`/status`). |
| `/cost`, `/usage` | Work; on a subscription they print plan usage, not dollars. | `/cost` is the bot's own (session tokens and estimated `total_cost_usd`). `/usage` is routed by the bot to its plan usage tracker. |
| `/model` | `/model` alone prints the current model; `/model <name>` takes the value as an argument. Does not stick across separate `-p` runs. | Bot-native: `/model <name>` is saved per chat and passed as `--model` on every run. |
| `/compact` | Runs ("Not enough messages to compact" on a short session). | Bot-native: writes `memory/handoff.md` and continues in a fresh session, which the bot also does automatically. |
| `/clear` | Accepted, returns nothing useful (each `-p` run is already its own process). | Bot-native: `/clear` = `/new`, drops the session and the recent messages. |
| `/status`, `/memory`, `/help`, `/login` | Not available: "isn't available in this environment". | `/status` and `/help` are bot-native; memory is the `memory/` folder. |
| Unknown command | Replies "Unknown command: /x" (no model call). | Passed through, so the user sees that reply. |

Also verified: `--resume <id> --fork-session` works with `-p` (the fork remembered the earlier conversation and got a new
session id, leaving the original untouched). That is what the fast lane uses. On this version `total_cost_usd` on a
resumed run covered that run only, so the bot adds it up per session.

Sources:
- Tested locally, `claude -p` 2.1.299, `claude --help` (`--fork-session`: "When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)").
- https://code.claude.com/docs/en/headless : "User-invoked skills and custom commands work. Include `/skill-name` in the prompt string and Claude Code expands it before running." and "Built-in commands that only run in the terminal interface, such as `/login`, aren't available." and "`/model`, `/effort`, `/fast`, `/color`, and `/rename` accept the value as an argument".
- https://code.claude.com/docs/en/cli-reference : `--resume`, `--fork-session`, `--model`, `--append-system-prompt`.
