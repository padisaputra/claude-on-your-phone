#!/usr/bin/env bash
# Installs the always-on Claude Code agent (Telegram front-end) on Ubuntu or Debian. Safe to run again.
# Usage: sudo ./install.sh
# Automation: NONINTERACTIVE=1 TELEGRAM_BOT_TOKEN=... USER_NAME=... [ALLOWED_USER_IDS=...] [SKIP_CLAUDE_LOGIN=1]
set -euo pipefail

BOT_USER="${BOT_USER:-claude}"
APP_DIR="${APP_DIR:-/opt/claude-phone}"
API_BASE="${TELEGRAM_API_BASE:-https://api.telegram.org}"
REPO_URL="${REPO_URL:-https://github.com/padisaputra/claude-on-your-phone.git}"
NONINTERACTIVE="${NONINTERACTIVE:-0}"
HOME_DIR="/home/$BOT_USER"
WS="$HOME_DIR/workspace"
CLAUDE_BIN="$HOME_DIR/.local/bin/claude"
ENV_FILE="$APP_DIR/.env"
NAME="${USER_NAME:-}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"

say()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# Prompts read from the terminal, not stdin, so this also works when the script itself is piped in.
interactive() { [ "$NONINTERACTIVE" != 1 ] && { : </dev/tty; } 2>/dev/null; }
ask() { # ask VAR "question" [secret]
  interactive || die "Need $1 but running non-interactively. Set it as an environment variable."
  local reply
  if [ -n "${3:-}" ]; then read -rsp "    $2 " reply </dev/tty; echo; else read -rp "    $2 " reply </dev/tty; fi
  printf -v "$1" '%s' "$reply"
}

# --- small helpers -----------------------------------------------------------------------------
tg() { # tg METHOD [curl args...] -> prints the JSON reply (empty if Telegram can't be reached)
  local m="$1"; shift
  curl -sS --max-time 40 "$API_BASE/bot$TOKEN/$m" "$@" 2>/dev/null || true
}
tg_send() { tg sendMessage -d "chat_id=$1" --data-urlencode "text=$2" >/dev/null; }
json() { # json 'expression using j' <<< "$json"   (node is installed before this is used)
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let j;try{j=JSON.parse(d)}catch{return}
    const v=new Function("j","try{return "+process.argv[1]+"}catch{}")(j);if(v!=null&&v!==""&&v!==false)console.log(v)})' "$1"
}
env_get() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1 || true; }
env_set() { # sets KEY=VALUE in .env, uncommenting it if needed (values here never contain '|')
  local v="${2//[$'\r\n ']/}" # keys never contain whitespace
  if grep -qE "^#? *$1=" "$ENV_FILE"; then
    v="${v//\\/\\\\}"; v="${v//&/\\&}"; v="${v//|/\\|}"
    sed -i -E "s|^#? *$1=.*|$1=$v|" "$ENV_FILE"
  else echo "$1=$v" >>"$ENV_FILE"; fi
}
valid_token() { [[ "$1" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; }
as_bot() { sudo -u "$BOT_USER" -H "$@"; }
logged_in() { # true if the claude user can already talk to Claude
  [ -n "$(env_get ANTHROPIC_API_KEY)$(env_get CLAUDE_CODE_OAUTH_TOKEN)" ] && return 0
  local s; s="$(cd / && as_bot "$CLAUDE_BIN" auth status 2>/dev/null || true)"
  if [ -n "$s" ]; then [ "$(json 'j.loggedIn' <<<"$s")" = true ]; return; fi
  # Older Claude Code without `auth status`: a tiny real request is the only reliable check.
  (cd / && timeout 90 sudo -u "$BOT_USER" -H "$CLAUDE_BIN" -p "say ok" </dev/null >/dev/null 2>&1)
}

# --- steps ---------------------------------------------------------------------------------------
preflight() {
  [ "$(id -u)" -eq 0 ] || die "Run this with sudo: sudo ./install.sh"
  command -v apt-get >/dev/null || die "This script needs Ubuntu or Debian (apt)."
  if [ ! -f "$SRC/bot/bot.js" ]; then # piped in: no checkout next to us, so fetch one
    command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git >/dev/null; }
    SRC="$(mktemp -d)"; git clone -q --depth 1 "$REPO_URL" "$SRC" || die "Could not clone $REPO_URL. Clone it yourself and run sudo ./install.sh inside it."
  fi
  cd /   # the claude user runs commands below and may not be able to read the folder you started in
}

install_packages() {
  say "Installing basic packages and Node.js"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates git tmux sudo ufw >/dev/null
  if [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi
  info "Node $(node -v)"
}

install_claude() {
  say "Creating the '$BOT_USER' user and installing Claude Code for it"
  id "$BOT_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$BOT_USER" >/dev/null
  [ -x "$CLAUDE_BIN" ] || as_bot bash -c 'curl -fsSL https://claude.ai/install.sh | bash' >/dev/null \
    || die "Claude Code install failed. Check the network and run this again."
  info "Claude Code $(as_bot "$CLAUDE_BIN" --version)"
}

copy_app() {
  say "Copying the bot to $APP_DIR"
  # Root-owned on purpose: Claude runs as $BOT_USER and must not edit the bot or read .env.
  install -d -o root -g root -m 755 "$APP_DIR"
  local f
  for f in "$SRC"/bot/*.js "$SRC/bot/package.json"; do
    case "$f" in *.test.js|*/test.js) continue ;; esac
    install -o root -g root -m 644 "$f" "$APP_DIR/"
  done
}

ask_token() {
  TOKEN="$(env_get TELEGRAM_BOT_TOKEN)"
  valid_token "$TOKEN" || TOKEN="${TELEGRAM_BOT_TOKEN:-}"
  [ -n "$TOKEN" ] || { say "Telegram bot token"; info "In Telegram, message @BotFather, send /newbot, and copy the token it gives you."; }
  while :; do
    [ -n "$TOKEN" ] || ask TOKEN "Paste the bot token:"
    TOKEN="${TOKEN//[[:space:]]/}"
    BOT_NAME="$(tg getMe | json 'j.ok && j.result.username')"
    [ -n "$BOT_NAME" ] && { info "Token works: this is @$BOT_NAME"; return; }
    if ! valid_token "$TOKEN"; then info "That doesn't look like a bot token (it should look like 123456:ABC-xyz...)."
    elif curl -sS --max-time 15 -o /dev/null "$API_BASE" 2>/dev/null; then info "Telegram says that token is wrong. Copy it again from @BotFather."
    else info "Can't reach Telegram from this server right now. Check the network."; fi
    interactive || die "TELEGRAM_BOT_TOKEN did not work."
    TOKEN=""
  done
}

ask_name() {
  while [ -z "$NAME" ]; do ask NAME "What's your first name? (the agent will call you this)"; done
}

detect_user_id() {
  USER_ID="$(env_get ALLOWED_USER_IDS)"; USER_ID="${USER_ID:-${ALLOWED_USER_IDS:-}}"
  [ -n "$USER_ID" ] && return
  interactive || die "ALLOWED_USER_IDS is not set and can't detect it non-interactively."
  say "Linking your Telegram account"
  [ -d /run/systemd/system ] && systemctl stop claude-phone 2>/dev/null || true # it would grab the message first
  tg deleteWebhook >/dev/null   # getUpdates refuses to work while a webhook is set
  # Skip anything sent to the bot before now, so only your fresh /start counts.
  local offset last reply deadline=$((SECONDS + 300)) dots=""
  last="$(tg getUpdates -d timeout=0 | json 'j.result.at(-1).update_id')"
  offset=$(( ${last:-0} + 1 ))
  info "Open Telegram, find @$BOT_NAME, and send it: /start"
  while [ $SECONDS -lt $deadline ]; do
    reply="$(tg getUpdates -d "offset=$offset" -d timeout=10)"
    [ "$(json 'j.ok' <<<"$reply")" = true ] || { sleep 3; reply="{}"; }   # network blip or Telegram hiccup: try again
    read -r last USER_ID FROM_NAME < <(json '(m=>m?(m.update_id+" "+m.message.from.id+" "+(m.message.from.first_name||"").replace(/\s+/g,"_")):(j.result.at(-1)?.update_id??""))(j.result.find(u=>u.message?.chat?.type==="private"&&u.message.from&&/^\/start\b/.test(u.message.text||"")))' <<<"$reply") || true
    [ -n "${last:-}" ] && offset=$((last + 1))
    if [ -n "${USER_ID:-}" ] && ! confirm_sender "${FROM_NAME//_/ }"; then USER_ID=""; fi # anyone who finds the bot could send /start
    if [ -n "${USER_ID:-}" ]; then
      tg getUpdates -d "offset=$offset" -d timeout=0 >/dev/null   # mark it read so the bot doesn't answer /start later
      printf '\n'; info "Got you (Telegram id $USER_ID)."
      tg_send "$USER_ID" "Hi $NAME, got you. Finishing setup..."
      return
    fi
    dots="$dots."; [ ${#dots} -le 30 ] || dots="."
    printf '\r    waiting for your /start %-30s %3ds left ' "$dots" $((deadline - SECONDS))
  done
  printf '\n'; die "No message arrived in 5 minutes. Run sudo ./install.sh again and send /start to @$BOT_NAME."
}

confirm_sender() { # anyone who knows the bot's name could /start it, so ask before trusting the sender
  local ans
  printf '\n'; read -r -p "    /start arrived from \"$1\". Is that you? [Y/n] " ans
  [[ ! "$ans" =~ ^[Nn] ]]
}

claude_login() {
  [ "${SKIP_CLAUDE_LOGIN:-0}" = 1 ] && { info "Skipping Claude login (SKIP_CLAUDE_LOGIN=1)."; return; }
  say "Logging Claude in"
  logged_in && { info "Already logged in."; return; }
  interactive || die "Claude is not logged in. Run: sudo -iu $BOT_USER claude auth login"
  local choice key
  while ! logged_in; do
    info "1) Log in with your Claude Pro/Max plan (recommended)"
    info "2) Use an API key from platform.claude.com (pay per use)"
    ask choice "Pick 1 or 2:"
    if [ "$choice" = 2 ]; then
      ask key "Paste the API key (hidden):" secret
      [ -n "$key" ] && env_set ANTHROPIC_API_KEY "$key"
      continue
    fi
    info "Claude will print a link. Open it on your phone or laptop and sign in."
    info "The page then shows a code. Paste it back here and press Enter."
    info "The server has no browser, that's normal."
    # runuser, not sudo: sudo's own terminal relay can swallow the pasted code.
    if as_bot "$CLAUDE_BIN" auth login --help >/dev/null 2>&1; then
      runuser -l "$BOT_USER" -c "$CLAUDE_BIN auth login" </dev/tty || true
    else # older Claude Code: the full app logs in on first start, then type /exit
      runuser -l "$BOT_USER" -c "$CLAUDE_BIN" </dev/tty || true
    fi
    logged_in || info "Still not logged in. Let's try again."
  done
  info "Claude is logged in."
}

write_env() {
  if [ ! -f "$ENV_FILE" ]; then
    install -o root -g root -m 600 "$SRC/.env.example" "$ENV_FILE"
    env_set WORKDIR "$WS"
  fi
  # Only fills these two in; every other line of an existing .env is left alone.
  [ "$(env_get TELEGRAM_BOT_TOKEN)" = "$TOKEN" ] || env_set TELEGRAM_BOT_TOKEN "$TOKEN"
  [ -n "$(env_get ALLOWED_USER_IDS)" ] || env_set ALLOWED_USER_IDS "$USER_ID"
  chown root:root "$ENV_FILE"; chmod 600 "$ENV_FILE"
}

seed_file() { # seed_file SRC DEST: copy once, filling in the name. Existing files are never touched.
  [ -f "$2" ] && return
  local text; text="$(cat "$1")"
  printf '%s\n' "${text//__USER_NAME__/"$NAME"}" >"$2"
  chown "$BOT_USER:$BOT_USER" "$2"; chmod 644 "$2"
}

setup_workspace() {
  say "Setting up the agent's workspace (identity and memory)"
  install -d -o "$BOT_USER" -g "$BOT_USER" "$WS" "$WS/memory" "$WS/jobs-briefs"
  seed_file "$SRC/workspace/CLAUDE.md" "$WS/CLAUDE.md"
  local f
  for f in "$SRC"/workspace/memory/*.md; do seed_file "$f" "$WS/memory/$(basename "$f")"; done
}

start_service() {
  say "Starting the background service"
  sed -e "s|__NODE__|$(command -v node)|g" -e "s|__BOT_USER__|$BOT_USER|g" -e "s|__APP_DIR__|$APP_DIR|g" \
    "$SRC/deploy/claude-phone.service" >/etc/systemd/system/claude-phone.service
  if [ ! -d /run/systemd/system ]; then
    info "systemd is not running here (probably a container): the service was written but not started."
    return 1
  fi
  systemctl daemon-reload
  systemctl enable claude-phone >/dev/null 2>&1
  systemctl restart claude-phone
  local i
  for i in $(seq 1 20); do
    sleep 1
    # Active for a few seconds in a row, so a crash right after start is caught too.
    if [ "$i" -ge 5 ] && systemctl is-active --quiet claude-phone; then info "Service is running."; return 0; fi
  done
  journalctl -u claude-phone -n 20 --no-pager || true
  die "The service did not stay up. The log is above. Fix it, then run sudo ./install.sh again."
}

main() {
  preflight
  local configured=0
  valid_token "$(env_get TELEGRAM_BOT_TOKEN)" && [ -n "$(env_get ALLOWED_USER_IDS)" ] && configured=1
  install_packages
  install_claude
  copy_app
  ask_token
  if [ "$configured" = 0 ] || [ ! -f "$WS/CLAUDE.md" ] || [ ! -f "$WS/memory/about-me.md" ]; then ask_name; fi
  detect_user_id
  write_env
  claude_login
  setup_workspace
  if start_service; then
    [ "$configured" = 1 ] || tg_send "${USER_ID%%,*}" "done, I'm alive, text me"
    say "done, text your bot (@$BOT_NAME)"
  else
    say "Installed. Start it on a machine with systemd: sudo systemctl enable --now claude-phone"
  fi
  info "Personality: sudo -u $BOT_USER nano $WS/CLAUDE.md    Logs: journalctl -u claude-phone -f"
}

main "$@"
