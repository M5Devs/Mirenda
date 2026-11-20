#!/usr/bin/env bash
#
# Run the two-role split locally behind Quick Tunnels.
#
# A phone cannot reach 127.0.0.1, and the split-role design only proves itself
# across two *registrable* origins — so each Worker gets its own tunnel. The
# tunnel URLs are then fed back into both Workers as APP_ORIGIN / SANDBOX_ORIGIN
# so CORS and the proxy-token audience match what the browser actually sees.
#
# Requires: cloudflared on PATH or at $CLOUDFLARED.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CLOUDFLARED="${CLOUDFLARED:-$(command -v cloudflared || echo /tmp/cloudflared)}"
if [ ! -x "$CLOUDFLARED" ]; then
  echo "cloudflared not found. Install it or set CLOUDFLARED=/path/to/cloudflared." >&2
  exit 1
fi

APP_PORT="${APP_PORT:-8787}"
SANDBOX_PORT="${SANDBOX_PORT:-8788}"
LOG_DIR="${LOG_DIR:-/tmp/mirenda}"
PROXY_TOKEN_SECRET="${PROXY_TOKEN_SECRET:-dev-only-proxy-token-secret-change-me-32chars}"

mkdir -p "$LOG_DIR"
pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null; done
}
trap cleanup EXIT INT TERM

wait_for_url() {
  local url="$1" name="$2" tries="${3:-90}"
  for _ in $(seq "$tries"); do
    # Any HTTP status counts as ready: `/proxy` without params answers 4xx by
    # design, so only a connection failure means the Worker is not listening.
    if curl -s -o /dev/null --max-time 2 "$url" 2>/dev/null; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for $name at $url" >&2
  return 1
}

# Quick Tunnels print their public hostname to stderr; wait for it to appear.
tunnel_url() {
  local log="$1"
  for _ in $(seq 60); do
    local url
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" 2>/dev/null | head -1)"
    if [ -n "$url" ]; then echo "$url"; return 0; fi
    sleep 1
  done
  return 1
}

echo "==> building (web UI + extension bundles + sandbox assets)"
npm run build >"$LOG_DIR/build.log" 2>&1 || { tail -20 "$LOG_DIR/build.log"; exit 1; }

echo "==> starting app tunnel"
"$CLOUDFLARED" tunnel --url "http://127.0.0.1:$APP_PORT" --no-autoupdate \
  >"$LOG_DIR/tunnel-app.log" 2>&1 &
pids+=($!)
APP_URL="$(tunnel_url "$LOG_DIR/tunnel-app.log")" || { echo "app tunnel failed" >&2; exit 1; }

echo "==> starting sandbox tunnel"
"$CLOUDFLARED" tunnel --url "http://127.0.0.1:$SANDBOX_PORT" --no-autoupdate \
  >"$LOG_DIR/tunnel-sandbox.log" 2>&1 &
pids+=($!)
SANDBOX_URL="$(tunnel_url "$LOG_DIR/tunnel-sandbox.log")" || { echo "sandbox tunnel failed" >&2; exit 1; }

# The Workers must know their own public origins, so start them only now.
# `wrangler.toml` lives in `apps/worker` and its asset paths are relative to
# that directory, so the dev servers must run from there.
echo "==> starting workers with the tunnel origins"
cd "$ROOT/apps/worker"

npx wrangler dev --env app --port "$APP_PORT" --local --inspector-port "${APP_INSPECTOR_PORT:-9230}" \
  --var PROXY_TOKEN_SECRET:"$PROXY_TOKEN_SECRET" \
  --var APP_ORIGIN:"$APP_URL" \
  --var SANDBOX_ORIGIN:"$SANDBOX_URL" \
  --var ALLOWED_ORIGINS:"$SANDBOX_URL" \
  >"$LOG_DIR/w-app.log" 2>&1 &
pids+=($!)

npx wrangler dev --env sandbox --port "$SANDBOX_PORT" --local --inspector-port "${SANDBOX_INSPECTOR_PORT:-9231}" \
  --var PROXY_TOKEN_SECRET:"$PROXY_TOKEN_SECRET" \
  --var APP_ORIGIN:"$APP_URL" \
  --var SANDBOX_ORIGIN:"$SANDBOX_URL" \
  --var ALLOWED_ORIGINS:"$APP_URL" \
  >"$LOG_DIR/w-sandbox.log" 2>&1 &
pids+=($!)

wait_for_url "http://127.0.0.1:$APP_PORT/" "app worker" || exit 1
wait_for_url "http://127.0.0.1:$SANDBOX_PORT/proxy" "sandbox worker" || exit 1

cat <<EOF

  Mirenda is up.

    app      $APP_URL
    sandbox  $SANDBOX_URL

  Open the app URL on your phone. Logs: $LOG_DIR

EOF

wait
