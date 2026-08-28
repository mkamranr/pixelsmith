#!/usr/bin/env bash
#
# Prove the processing tier has no route off this host.
#
# Two mistakes this deliberately avoids, both of which an earlier version made.
#
# It pulls nothing. The machine this matters on cannot pull anything, so a check
# that needs an image is a check that cannot be run where it counts. The probes
# run inside the images already here, using the runtimes those images ship with.
#
# It does not use wget or curl inside a container. Neither is installed in these
# images, so `wget ... || echo "no egress"` reports success because the binary is
# missing — a pass that proves nothing.
#
# And it measures the host first. A timeout inside a container means nothing if
# the target is simply dead: that is a measurement of the target, not of the gap.
#
#   ./infra/bundle/egress-check.sh [target]
#
set -uo pipefail

TARGET="${1:-1.1.1.1}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
FAILED=0
WIDENED=

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

# Node is what the API and runner images have; this runs on the host, which has
# it too when checking from a checkout. If it does not, the control is skipped
# and said to be skipped rather than quietly assumed.
say "Control: can this host reach ${TARGET}:443 at all?"
if command -v node >/dev/null 2>&1; then
  node -e "
    const s = require('net').connect({ host: '${TARGET}', port: 443, timeout: 6000 })
    s.on('connect', () => { console.log('  the host can reach it, so the checks below mean something'); s.destroy(); process.exit(0) })
    s.on('timeout', () => { console.log('  the host CANNOT reach it either — the checks below prove nothing'); process.exit(0) })
    s.on('error', () => { console.log('  the host CANNOT reach it either — the checks below prove nothing'); process.exit(0) })
  "
else
  note "no node on this host, so the control was skipped — treat the results with care"
fi

probe_runner() {
  docker compose -f "$COMPOSE_FILE" exec -T runner node -e "
    const s = require('net').connect({ host: '${TARGET}', port: 443, timeout: 6000 })
    s.on('connect', () => { console.log('CONNECTED'); s.destroy(); process.exit(1) })
    s.on('timeout', () => { console.log('blocked: timeout'); process.exit(0) })
    s.on('error', (e) => { console.log('blocked: ' + e.code); process.exit(0) })
  "
}

probe_inference() {
  docker compose -f "$COMPOSE_FILE" exec -T inference python3 - <<PY
import socket, sys
s = socket.socket()
s.settimeout(6)
try:
    s.connect(("${TARGET}", 443))
    print("CONNECTED")
    sys.exit(1)
except Exception as error:
    print("blocked: " + type(error).__name__)
PY
}

# Which networks a container is actually attached to.
networks_of() {
  local id
  id="$(docker compose -f "$COMPOSE_FILE" ps -q "$1" 2>/dev/null | head -1)"
  [[ -n "$id" ]] || return 1
  docker inspect "$id" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null
}

say "The internal network itself"
# Attached to nothing but `internal`, using an image already here. This is the
# structural claim — it holds whatever any one deployment has been configured to
# do, which is why it is checked separately from the tiers below.
INTERNAL_NET="$(docker network ls --format '{{.Name}}' | grep -E '_internal$' | head -1)"
if [[ -n "$INTERNAL_NET" ]] && docker image inspect "pixelsmith/runner:${VERSION:-0.1.0}" >/dev/null 2>&1; then
  sealed="$(docker run --rm --network "$INTERNAL_NET" "pixelsmith/runner:${VERSION:-0.1.0}" node -e "
    const s = require('net').connect({ host: '${TARGET}', port: 443, timeout: 6000 })
    s.on('connect', () => { console.log('CONNECTED'); process.exit(1) })
    s.on('timeout', () => { console.log('blocked: timeout'); process.exit(0) })
    s.on('error', (e) => { console.log('blocked: ' + e.code); process.exit(0) })
  " 2>&1 | tail -1)"
  if [[ "$sealed" == *CONNECTED* ]]; then
    note "$sealed — the internal network has a route out, which it should not"
    FAILED=1
  else
    note "$sealed — sealed, as declared"
  fi
else
  note "skipped: no internal network up, or the runner image is not present here"
fi

for tier in runner inference; do
  say "The ${tier} tier, as this deployment actually runs it"
  if [[ "$tier" == runner ]]; then output="$(probe_runner 2>&1)"; else output="$(probe_inference 2>&1)"; fi
  status=$?

  if [[ "$output" == *CONNECTED* ]]; then
    note "$output"
    attached="$(networks_of "$tier" || echo '')"
    if [[ "$attached" == *_edge* ]]; then
      # Almost always this, and it is a choice rather than a fault: the override
      # exists so the workers can reach a language model you run elsewhere.
      note "that tier is attached to: ${attached}"
      note "it is on the edge network, so this is docker-compose.model-access.yml doing"
      note "exactly what it says. Drop that override to close it again."
      WIDENED="${WIDENED}${tier} "
    else
      note "EGRESS EXISTS from ${tier} and it is not on the edge network. That is a fault."
      FAILED=1
    fi
  elif [[ $status -ne 0 ]]; then
    note "$output"
    note "the probe itself failed to run, so nothing was proved about ${tier}"
    FAILED=1
  else
    note "$output — correct"
  fi
done

say "Result"
if [[ $FAILED -ne 0 ]]; then
  note "at least one check did not pass — see above"
  exit 1
fi

if [[ -n "$WIDENED" ]]; then
  # Reported rather than glossed over: this deployment is not the sealed one the
  # documentation describes, and saying otherwise here would be the whole point
  # of the check thrown away.
  note "the internal network is sealed, but ${WIDENED}has been given a route out on purpose"
  note "nothing is wrong — but this deployment is not air-gapped on that tier"
  exit 0
fi

note "the processing and model tiers have no route off this host"
exit 0
