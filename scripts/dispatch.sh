#!/usr/bin/env bash
#
# Start one `collect.yml` run, from your own box (systemd timer / cron).
# GitHub's own cron is deliberately not used — see README.
#
# Two things this does beyond a bare POST to /dispatches:
#
#   1. Skips the dispatch while a run is still open. GitHub reports a run held
#      by `concurrency: collect` as status **pending** (not "queued"), so a
#      guard that only looks for queued/in_progress lets runs pile up: each new
#      dispatch cancels the previous pending one, and a slow Actions day turns
#      into a wall of cancelled/failed runs. Anything that is not `completed`
#      counts as busy here.
#   2. Warns (once per cooldown) when the `data` branch stops being updated —
#      the failure mode GitHub e-mails do not cover, because a run that never
#      gets a runner never sends anything at all.
#
# Env:
#   GITHUB_TOKEN     required — fine-grained PAT on this repo, Actions: read+write
#   REPO             default mrkaktuz/outages-data
#   WORKFLOW         default collect.yml
#   REF              default main
#   STALE_MINUTES    warn when the newest `data` commit is older than this (default 30; 0 disables)
#   COOLDOWN_MINUTES minimum gap between staleness warnings (default 60)
#   STATE_DIR        where the cooldown stamp lives (default ${XDG_STATE_HOME:-~/.local/state}/outages-data)
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_THREAD_ID  optional — no creds, no warnings
#
# Needs: bash, curl, jq. Exit code is 0 for "nothing to do" so a timer stays green.

set -euo pipefail

REPO="${REPO:-mrkaktuz/outages-data}"
WORKFLOW="${WORKFLOW:-collect.yml}"
REF="${REF:-main}"
STALE_MINUTES="${STALE_MINUTES:-30}"
COOLDOWN_MINUTES="${COOLDOWN_MINUTES:-60}"
STATE_DIR="${STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/outages-data}"

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required (fine-grained PAT, Actions: read and write)}"

API="https://api.github.com/repos/${REPO}"

gh_api() {
  curl -fsS -m 30 \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

# Best-effort Telegram line; silent no-op without credentials.
notify() {
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || return 0
  jq -nc \
    --arg chat "$TELEGRAM_CHAT_ID" \
    --arg thread "${TELEGRAM_THREAD_ID:-}" \
    --arg text "$1" \
    '{chat_id: $chat, text: $text, disable_web_page_preview: true}
     + (if $thread == "" then {} else {message_thread_id: ($thread | tonumber)} end)' \
    | curl -sS -m 20 -o /dev/null -X POST -H 'content-type: application/json' -d @- \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" || true
}

# Warn when published data went stale, at most once per COOLDOWN_MINUTES.
check_freshness() {
  [ "$STALE_MINUTES" -gt 0 ] || return 0
  local last age now stamp
  last=$(gh_api "${API}/commits?sha=data&per_page=1" | jq -r '.[0].commit.committer.date // empty') || return 0
  [ -n "$last" ] || return 0
  now=$(date -u +%s)
  age=$(( (now - $(date -u -d "$last" +%s)) / 60 ))
  [ "$age" -ge "$STALE_MINUTES" ] || return 0

  stamp="${STATE_DIR}/stale-warned"
  mkdir -p "$STATE_DIR"
  if [ -f "$stamp" ] && [ $(( (now - $(date -u -r "$stamp" +%s)) / 60 )) -lt "$COOLDOWN_MINUTES" ]; then
    return 0
  fi
  : > "$stamp"
  echo "stale: data branch last updated ${age} min ago" >&2
  notify "⚠️ outages-data: гілку data не оновлювали ${age} хв (востаннє ${last}). Перевір https://www.githubstatus.com та https://github.com/${REPO}/actions"
}

check_freshness

open_runs=$(gh_api "${API}/actions/workflows/${WORKFLOW}/runs?per_page=20" \
  | jq '[.workflow_runs[] | select(.status != "completed")] | length')

if [ "${open_runs:-0}" -gt 0 ]; then
  echo "busy: ${open_runs} run(s) still open (pending/queued/in_progress); skipping dispatch"
  exit 0
fi

gh_api -X POST "${API}/actions/workflows/${WORKFLOW}/dispatches" -d "{\"ref\":\"${REF}\"}"
echo "dispatched ${WORKFLOW} @ ${REF}"
