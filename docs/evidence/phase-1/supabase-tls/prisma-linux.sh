# Runs inside the container (see README.md). $DIRECT_URL comes from the environment and is never printed.
cd /w/packages/db
. /etc/os-release
echo "$PRETTY_NAME, $(uname -m), node $(node --version), $(openssl version)"
npx --no-install prisma --version 2>/dev/null | grep -E "^(prisma|Schema Engine)" | sed -E 's# \(at .*\)##'
# Prisma's default connect timeout is 5 s. From a distant laptop that is sometimes too short and reports
# P1001, which would hide the TLS result, so every URL here gets 30 s. Pass or fail is the same run's exit code.
slow() { case "$1" in *\?*) printf '%s&connect_timeout=30' "$1" ;; *) printf '%s?connect_timeout=30' "$1" ;; esac; }
CONFIGURED="$DIRECT_URL"
run() { # label url
  echo "--- prisma migrate status | $1"
  output="$(DIRECT_URL="$(slow "$2")" npx --no-install prisma migrate status 2>&1)"
  status=$?
  printf '%s\n' "$output" | grep -v "^npm notice" | DIRECT_URL="$2" node /w/tools/redact.cjs
  echo "exit $status"
}
for attempt in 1 2 3; do run "as configured, attempt $attempt" "$CONFIGURED"; done
run "no sslmode" "$(node /w/tools/url-variant.cjs DIRECT_URL no-sslmode)"
for attempt in 1 2 3; do
  run "unrelated CA, attempt $attempt" "$(node /w/tools/url-variant.cjs DIRECT_URL wrong-ca /w/tools/wrong-ca.crt)"
done
run "right CA, wrong host name (IP address)" \
  "$(node /w/tools/url-variant.cjs DIRECT_URL wrong-host /w/packages/db/certs/supabase-root.crt)"
