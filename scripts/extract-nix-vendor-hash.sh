#!/usr/bin/env bash
# Extracts the corrected vendorHash from a nix build log.
#
# Usage: scripts/extract-nix-vendor-hash.sh [LOGFILE]   (reads stdin when omitted)
#
# The classifier for "did this build fail because of the vendorHash?" behind
# dependabot-sync-nix-vendor-hash.yml, which embeds it so the caller's SHA
# pin covers it byte for byte; CI fails if the embedded copy drifts from this
# file (scripts/check-embedded-sync.sh), and extract-nix-vendor-hash.test.mjs
# holds the fixtures that are its contract. Derived from hey-cli's script of
# the same name.
#
# Three conditions must hold before a hash comes back. Each guard is
# load-bearing, because the caller writes the result into a tracked file:
#
# - Nix must have reported a fixed-output hash mismatch. Matching a bare
#   `got:` is far too loose: any failing build whose log happens to contain
#   one — a Go test assertion printing `got: 42`, say — would yield "42" and
#   misreport an unrelated failure as a hash problem.
# - That mismatch must belong to buildGoModule's vendor derivation
#   (`*-go-modules.drv`). A flake can carry other fixed-output derivations —
#   hey-cli's once fetched a Go source tarball while nixpkgs lagged go.mod —
#   and their hashes must never land in vendorHash. The `got:` is taken from
#   that one diagnostic, so a mismatch for another derivation cannot supply
#   the value however the two are ordered.
# - The value must be a complete SRI sha256: 43 base64 characters and one
#   `=`. A truncated or otherwise malformed value is not a hash to write.
#
# Exit codes:
#   0 — a go-modules fixed-output hash mismatch was reported; the SRI hash is
#       on stdout
#   1 — the log reports no such mismatch, or its value is malformed; nothing
#       on stdout

set -euo pipefail

LOG=$(cat -- "${1:--}")

# The mismatch diagnostic names the derivation on its own line; `specified:`
# and `got:` follow on the next lines. Take the first `got:` inside the
# go-modules block and stop there; a mismatch for any other derivation ends
# the block, so its `got:` can never be read as ours. (No interval regexes:
# Ubuntu's awk is mawk. The length check is grep's, below.)
HASH=$(awk '
  /hash mismatch in fixed-output derivation .*-go-modules\.drv/ { in_block = 1; next }
  /hash mismatch in fixed-output derivation/ { in_block = 0; next }
  in_block && /got:/ {
    if (match($0, /sha256-[A-Za-z0-9+\/]+=*/)) { print substr($0, RSTART, RLENGTH) }
    exit
  }
' <<<"$LOG")

if ! printf '%s' "$HASH" | grep -qE '^sha256-[A-Za-z0-9+/]{43}=$'; then
  exit 1
fi

printf '%s\n' "$HASH"
