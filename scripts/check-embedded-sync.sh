#!/usr/bin/env bash
# The reusable dependabot-sync-actions-comments workflow embeds the updater
# script in a heredoc so the caller's SHA pin covers it byte for byte.
# scripts/sync-action-pin-comments.mjs is the tested source of truth; this
# check fails CI if the embedded copy drifts from it.
set -euo pipefail

wf=.github/workflows/dependabot-sync-actions-comments.yml
src=scripts/sync-action-pin-comments.mjs

# The heredoc body is the workflow-file text between the SYNC_MJS markers,
# de-indented by the run block's 10 spaces (blank lines carry no indent).
embedded="$(sed -n "/<<'SYNC_MJS'\$/,/^ *SYNC_MJS\$/p" "$wf" | sed -e '1d' -e '$d' -e 's/^          //')"

if ! diff -u "$src" <(printf '%s\n' "$embedded"); then
  echo "error: embedded updater script in $wf drifted from $src" >&2
  echo "regenerate the heredoc from the script file (or vice versa) so they match" >&2
  exit 1
fi
echo "embedded updater script matches $src"
