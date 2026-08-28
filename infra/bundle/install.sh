#!/usr/bin/env bash
#
# Install Pixelsmith on an isolated server.
#
# Everything needed is in this directory. Nothing is downloaded. Safe to re-run:
# it will not overwrite an existing .env or regenerate your secret.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '\n\033[31mERROR\033[0m %s\n' "$*" >&2; exit 1; }

say "Pixelsmith $(cat VERSION 2>/dev/null || echo '?') — offline install"

# ---- 1. preflight ----
command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is required (v2)"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon — is it running, and are you in the docker group?"
command -v curl >/dev/null 2>&1 || die "curl is needed to check the server came up"

# ---- 2. integrity ----
if [[ -f SHA256SUMS ]]; then
  say "Verifying the bundle"
  if command -v sha256sum >/dev/null 2>&1; then
    # SHA256SUMS lists itself; skip that line.
    grep -v ' SHA256SUMS$' SHA256SUMS | sha256sum --check --quiet \
      || die "checksum mismatch — this bundle is corrupt or was modified in transit. Do not proceed."
  else
    grep -v ' SHA256SUMS$' SHA256SUMS | shasum -a 256 --check --status \
      || die "checksum mismatch — this bundle is corrupt or was modified in transit. Do not proceed."
  fi
  note "all files match their recorded checksums"
else
  note "no SHA256SUMS present, skipping integrity check"
fi

# ---- 3. load images ----
say "Loading container images"
[[ -f images.tar.gz ]] || die "images.tar.gz is missing from this bundle"
gunzip -c images.tar.gz | docker load
note "loaded"

# ---- 4. configuration ----
if [[ -f .env ]]; then
  say "Keeping the existing .env"
  note "delete it and re-run if you want a fresh configuration"
else
  say "Writing .env"
  cp env.example .env
  # A generated secret beats asking a human to invent one, and beats a default.
  if command -v openssl >/dev/null 2>&1; then
    SECRET="$(openssl rand -hex 32)"
  else
    SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  # Portable in-place edit: BSD and GNU sed disagree about -i.
  sed "s|^COOKIE_SECRET=.*|COOKIE_SECRET=${SECRET}|" .env > .env.tmp && mv .env.tmp .env
  chmod 600 .env
  note "generated COOKIE_SECRET and set permissions to 600"
fi

# ---- 5. start ----
say "Starting the stack"
docker compose --env-file .env -f docker-compose.yml up -d

say "Waiting for the API to report healthy"
PORT="$(grep -E '^PUBLISH_PORT=' .env | cut -d= -f2 || true)"; PORT="${PORT:-8080}"
ADDR="$(grep -E '^PUBLISH_ADDR=' .env | cut -d= -f2 || true)"; ADDR="${ADDR:-127.0.0.1}"

for _ in $(seq 60); do
  if curl -fsS "http://${ADDR}:${PORT}/healthz" >/dev/null 2>&1; then
    note "healthy"
    break
  fi
  sleep 2
done

if ! curl -fsS "http://${ADDR}:${PORT}/healthz" >/dev/null 2>&1; then
  printf '\n'
  note "the API did not come up. Recent logs:"
  docker compose -f docker-compose.yml logs --tail 40 api || true
  die "install did not complete"
fi

say "Pixelsmith is running"
# 0.0.0.0 is an address to listen on, not one to visit.
VISIT="${ADDR}"; [[ "$VISIT" == "0.0.0.0" ]] && VISIT="localhost"
note "URL:  http://${VISIT}:${PORT}"
printf '\n'

MODE="$(grep -E '^AUTH_MODE=' .env | cut -d= -f2 || true)"; MODE="${MODE:-open}"
if [[ "$MODE" == "accounts" ]]; then
  note "This deployment requires sign-in. The first administrator's password was"
  note "printed once to the API log. Retrieve it with:"
  printf '\n    docker compose -f docker-compose.yml logs api | grep -i "generated password"\n\n'
  note "Sign in and change it immediately."
else
  note "Anyone who can reach that address can use it: there are no accounts, which"
  note "is the default. Reaching the page is the access control, so put it on a"
  note "network where that is what you want."
  printf '\n'
  note "To require sign-in instead, set AUTH_MODE=accounts in .env and re-run this"
  note "script. An administrator is created and its password printed once."
fi
printf '\n'
note "See RUNBOOK.md for day-to-day operation."
