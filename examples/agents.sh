#!/usr/bin/env bash
#
# agents.sh — spin up N isolated hotcell sandboxes on one repo, each ready to code
# with Autopilot. The LLM *and* GitHub both go through the hotcell egress gateway,
# so neither your provider key nor your GitHub token ever enters a sandbox.
#
# Turns the "5 folders + 5 terminals" ritual into two commands:
#   examples/agents.sh https://github.com/you/repo 5     # create 5 ready sandboxes
#   examples/agents.sh --rm                              # destroy all of them
#
# Prereqs (once): a running daemon (`hotcell start`), an LLM key
# (`hotcell keys add openrouter`), and `gh` logged in (`gh auth login`) — the
# GitHub token is sourced from `gh auth token`, never typed.
set -eo pipefail

HC="${HC:-hotcell}"                                   # override for a source checkout
IDS_FILE="${TMPDIR:-/tmp}/hotcell-agents.ids"

# ---- teardown --------------------------------------------------------------
if [ "${1:-}" = "--rm" ]; then
  [ -f "$IDS_FILE" ] || { echo "no agent sandboxes recorded."; exit 0; }
  while read -r id; do
    [ -n "$id" ] && $HC rm "$id" >/dev/null 2>&1 && echo "removed $id"
  done < "$IDS_FILE"
  rm -f "$IDS_FILE"
  exit 0
fi

REPO="${1:-}"; COUNT="${2:-3}"
[ -n "$REPO" ] || { echo "usage: agents.sh <github-repo-url> [count]   |   agents.sh --rm"; exit 2; }

# owner/repo slug + bare name from the URL (https or ssh form)
slug=$(printf '%s' "$REPO" | sed -E 's#(\.git)?/?$##; s#^https?://[^/]+/##; s#^git@[^:]+:##')
name=$(basename "$slug")
case "$slug" in */*) : ;; *) echo "not a github repo url: $REPO"; exit 2 ;; esac

# ---- keys: GitHub (from gh, never typed) + require an LLM key ---------------
if ! $HC keys ls 2>/dev/null | grep -qiw github; then
  if command -v gh >/dev/null 2>&1 && gh auth token >/dev/null 2>&1; then
    $HC keys add github --value "$(gh auth token)" >/dev/null
    echo "· registered your GitHub token on the host (via 'gh auth token') — stays out of every sandbox"
  else
    echo "need GitHub auth on the host:  gh auth login   (then re-run)"; exit 1
  fi
fi
$HC keys ls 2>/dev/null | grep -qiw openrouter \
  || { echo "add an OpenRouter key first:  hotcell keys add openrouter"; exit 1; }

# ---- build the per-sandbox scripts as FILES (quoted heredocs = no host-side
#      expansion or execution), placeholders sed-replaced, then base64'd --------
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

# 'pr' helper: push the current branch + open a PR, keyless (real token injected
# at the gateway; this sandbox only ever holds an egress token).
cat > "$work/pr" <<'PR'
#!/bin/sh
b=$(git rev-parse --abbrev-ref HEAD)
git push -u origin "$b" >&2 || { echo "push failed" >&2; exit 1; }
curl -s -X POST "$GITHUB_BASE_URL/repos/__SLUG__/pulls" \
  -H "Authorization: Bearer $GITHUB_API_KEY" \
  -d "{\"title\":\"$1\",\"head\":\"$b\",\"base\":\"${2:-main}\"}" \
  | grep -oE '"html_url": *"[^"]+"' | head -1 | sed 's/.*: *"//; s/"$//'
PR
sed -i.bak "s#__SLUG__#$slug#g" "$work/pr" && rm -f "$work/pr.bak"
prb64=$(base64 < "$work/pr" | tr -d '\n')

# per-sandbox setup: wire the git remote through the gateway and drop in the
# 'pr' helper. Autopilot is installed/configured by `hotcell create --autopilot`.
cat > "$work/setup" <<'SETUP'
set -e
gw=$(printf '%s' "$GITHUB_BASE_URL" | sed -E 's#https?://##; s#/github$##')
git -C /workspace/__NAME__ remote set-url origin "http://x-access-token:${GITHUB_API_KEY}@${gw}/github-git/__SLUG__.git"
git -C /workspace/__NAME__ config user.name  hotcell-agent
git -C /workspace/__NAME__ config user.email agent@hotcell.local
printf '%s' "__PRB64__" | base64 -d > /usr/local/bin/pr && chmod +x /usr/local/bin/pr
SETUP
sed -i.bak "s#__NAME__#$name#g; s#__SLUG__#$slug#g; s#__PRB64__#$prb64#g" "$work/setup" && rm -f "$work/setup.bak"
setupb64=$(base64 < "$work/setup" | tr -d '\n')

# ---- spin up N in parallel -------------------------------------------------
: > "$IDS_FILE"
echo "spinning up $COUNT sandbox(es) on $slug (repo + Autopilot + keyless GitHub) …"
for i in $(seq 1 "$COUNT"); do
  (
    id=$($HC create --autopilot --repo "$REPO" --name "agent-$i" --label agents=1 2>/dev/null | head -1)
    [ -n "$id" ] || { echo "  #$i  create failed"; exit 1; }
    if $HC exec "$id" "printf '%s' '$setupb64' | base64 -d | bash" >/dev/null 2>&1; then
      echo "$id" >> "$IDS_FILE"
      printf '  #%s  hotcell terminal %s   →  cd %s && autopilot\n' "$i" "$id" "$name"
    else
      echo "  #$i  setup failed (id $id) — inspect: hotcell terminal $id"
    fi
  ) &
done
wait

echo
echo "open a terminal per line above; inside each run 'autopilot', prompt a feature,"
echo "and when it's done: pr \"<title>\"  (pushes + opens a PR — no token in the sandbox)."
echo "tear everything down:  $0 --rm"
