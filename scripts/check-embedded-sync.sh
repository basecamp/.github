#!/usr/bin/env bash
# The reusable workflows embed their scripts in heredocs so the caller's SHA
# pin covers them byte for byte. scripts/ holds each one's tested source of
# truth; this check fails CI if an embedded copy drifts from its source.
set -euo pipefail

# The heredoc body is the workflow-file text between the marker lines,
# de-indented by the run block's 10 spaces (blank lines carry no indent).
check() {
  local wf="$1" marker="$2" src="$3"
  local embedded
  embedded="$(sed -n "/<<'${marker}'\$/,/^ *${marker}\$/p" "$wf" | sed -e '1d' -e '$d' -e 's/^          //')"

  if [ -z "$embedded" ]; then
    echo "error: no ${marker} heredoc found in $wf" >&2
    exit 1
  fi
  if ! diff -u "$src" <(printf '%s\n' "$embedded"); then
    echo "error: embedded script in $wf drifted from $src" >&2
    echo "regenerate the heredoc from the script file (or vice versa) so they match" >&2
    exit 1
  fi
  echo "embedded script in $wf matches $src"
}

check .github/workflows/dependabot-sync-actions-comments.yml SYNC_MJS scripts/sync-action-pin-comments.mjs
check .github/workflows/dependabot-sync-nix-vendor-hash.yml EXTRACT_SH scripts/extract-nix-vendor-hash.sh
