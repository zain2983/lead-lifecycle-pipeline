#!/usr/bin/env bash
# Bootstrap a fresh LOCAL Sim instance for this repo, without a browser:
#   1. sign up the synthetic user from infra/sim/.env (or sign in if it already exists),
#   2. create a workspace,
#   3. create a personal API key (a workspace key can't save workflow source),
# and write SIM_LOCAL_WORKSPACE_ID and SIM_LOCAL_API_KEY back into infra/sim/.env. Secrets are never printed.
#
# Only for http://localhost:3000. Uses Sim's own auth endpoints (Better Auth: /api/auth/sign-up/email and
# /api/auth/sign-in/email) and app routes (/api/workspaces, /api/users/me/api-keys) at v0.9.66.
#
# Usage: infra/sim/bootstrap.sh            (from the repo root, with Sim up)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="$here/.env"
base="http://localhost:3000"

[[ -f "$env_file" ]] || { echo "missing $env_file (copy .env.example and fill it)" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; source "$env_file"; set +a
: "${SIM_LOCAL_USER_EMAIL:?set in infra/sim/.env}"
: "${SIM_LOCAL_USER_PASSWORD:?set in infra/sim/.env (openssl rand -base64 24)}"
case "$SIM_LOCAL_USER_EMAIL" in
  *@example.com | *@*.test) ;;
  *) echo "SIM_LOCAL_USER_EMAIL must use a reserved domain (example.com or *.test)" >&2; exit 1 ;;
esac

jar="$(mktemp -d)"
trap 'rm -rf "$jar"' EXIT
cookies="$jar/cookies.txt"

# post <path> <json> -> prints "<status>\n<body>"
post() {
  curl -sS -o "$jar/body" -w '%{http_code}' -b "$cookies" -c "$cookies" \
    -H 'Content-Type: application/json' -H "Origin: $base" -X POST "$base$1" --data-binary @- <<<"$2"
  printf '\n'; cat "$jar/body"
}
get() {
  curl -sS -o "$jar/body" -w '%{http_code}' -b "$cookies" -c "$cookies" -H "Origin: $base" "$base$1"
  printf '\n'; cat "$jar/body"
}
json() { python3 -I -c "import json,sys; print(json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2]))))" "$@"; }
field() { python3 -I -c "import json,sys; d=json.load(sys.stdin); [d:=d[k] for k in sys.argv[1:]]; print(d)" "$@"; }
save() { # save KEY VALUE into infra/sim/.env
  python3 -I - "$env_file" "$1" "$2" <<'PY'
import re, sys
path, key, value = sys.argv[1:]
text = open(path).read()
line = f"{key}={value}"
text, n = re.subn(rf"^{re.escape(key)}=.*$", lambda _: line, text, flags=re.M)
if n == 0:
    text += ("" if text.endswith("\n") else "\n") + line + "\n"
open(path, "w").write(text)
PY
}

echo "== sign up $SIM_LOCAL_USER_EMAIL"
out="$(post /api/auth/sign-up/email "$(json email "$SIM_LOCAL_USER_EMAIL" password "$SIM_LOCAL_USER_PASSWORD" name Builder)")"
status="${out%%$'\n'*}"
echo "   HTTP $status"
if [[ "$status" != 200 ]]; then
  echo "   ${out#*$'\n'}" | head -c 400; echo
  echo "== sign in instead"
  out="$(post /api/auth/sign-in/email "$(json email "$SIM_LOCAL_USER_EMAIL" password "$SIM_LOCAL_USER_PASSWORD")")"
  status="${out%%$'\n'*}"
  echo "   HTTP $status"
  [[ "$status" == 200 ]] || { echo "   ${out#*$'\n'}" | head -c 400; echo; exit 1; }
fi

if [[ -z "${SIM_LOCAL_WORKSPACE_ID:-}" ]]; then
  echo "== create workspace"
  out="$(post /api/workspaces "$(json name 'Local dev')")"
  status="${out%%$'\n'*}"; body="${out#*$'\n'}"
  echo "   HTTP $status"
  [[ "$status" == 200 || "$status" == 201 ]] || { echo "   $body" | head -c 400; echo; exit 1; }
  SIM_LOCAL_WORKSPACE_ID="$(field workspace id <<<"$body")"
  save SIM_LOCAL_WORKSPACE_ID "$SIM_LOCAL_WORKSPACE_ID"
fi
echo "   workspace $SIM_LOCAL_WORKSPACE_ID"

if [[ -z "${SIM_LOCAL_API_KEY:-}" ]]; then
  echo "== create personal API key"
  out="$(post /api/users/me/api-keys "$(json name local-cli access write)")"
  status="${out%%$'\n'*}"; body="${out#*$'\n'}"
  echo "   HTTP $status"
  [[ "$status" == 200 ]] || { echo "   $body" | head -c 400; echo; exit 1; }
  key="$(field key key <<<"$body")"
  save SIM_LOCAL_API_KEY "$key"
  echo "   saved to infra/sim/.env (${key:0:6}…, $(( ${#key} )) chars)"
else
  echo "   API key already in infra/sim/.env"
fi
