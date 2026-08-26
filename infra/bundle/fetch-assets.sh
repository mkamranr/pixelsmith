#!/usr/bin/env bash
#
# Fetch the model weights and fonts that ship inside the offline bundle.
#
# Run this ONCE on a machine with internet access, before building images. The
# isolated server never downloads anything; it only receives what this produced.
#
#   ./infra/bundle/fetch-assets.sh          verify against pinned checksums
#   ./infra/bundle/fetch-assets.sh --pin    record checksums for the first time
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="$ROOT/infra/bundle/assets.manifest"
DEST="$ROOT/assets/vendor"
MODE="${1:-verify}"

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

fail=0
updated="$MANIFEST.new"
: > "$updated"

while IFS= read -r line; do
  # Preserve comments and blank lines when rewriting the manifest.
  if [[ -z "$line" || "$line" == \#* ]]; then echo "$line" >> "$updated"; continue; fi

  IFS='|' read -r path url license expected <<< "$line"
  target="$DEST/$path"
  mkdir -p "$(dirname "$target")"

  if [[ ! -f "$target" ]]; then
    echo "  fetching $path"
    if ! curl -fsSL --retry 3 --max-time 900 "$url" -o "$target.part"; then
      echo "  ERROR could not download $path from $url" >&2
      rm -f "$target.part"
      fail=1
      echo "$line" >> "$updated"
      continue
    fi
    mv "$target.part" "$target"
  fi

  actual="$(sha "$target")"
  size="$(wc -c < "$target" | tr -d ' ')"

  if [[ "$MODE" == "--pin" || "$expected" == "PENDING" ]]; then
    printf '  pinned   %-38s %s  %s bytes\n' "$path" "${actual:0:16}..." "$size"
    echo "$path|$url|$license|$actual" >> "$updated"
  elif [[ "$actual" != "$expected" ]]; then
    echo "  MISMATCH $path" >&2
    echo "    expected $expected" >&2
    echo "    actual   $actual" >&2
    echo "  Refusing to continue: a substituted model cannot be caught later." >&2
    fail=1
    echo "$line" >> "$updated"
  else
    printf '  verified %-38s %s bytes\n' "$path" "$size"
    echo "$line" >> "$updated"
  fi
done < "$MANIFEST"

mv "$updated" "$MANIFEST"
[[ "$fail" -eq 0 ]] || exit 1
echo "All assets present and verified."
