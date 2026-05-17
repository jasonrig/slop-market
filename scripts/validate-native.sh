#!/usr/bin/env bash
set -euo pipefail

# Smoke-test the marketplace with installed provider CLIs when they are
# available. This complements the schema validator by exercising real CLI entry
# points, but remains best-effort so contributors without both CLIs can still run
# local validation.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Use an isolated home/config directory so marketplace additions made during the
# smoke test never mutate the developer's real Codex or Claude configuration.
tmp_home="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_home"
}
trap cleanup EXIT

export HOME="$tmp_home"
export CODEX_HOME="$tmp_home/.codex"
export CLAUDE_CONFIG_DIR="$tmp_home/.claude"
mkdir -p "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"

# Each CLI check is optional because CI and local machines may have only one
# provider installed. Missing CLIs are reported as skips rather than failures.
if command -v claude >/dev/null 2>&1; then
  (cd "$repo_root" && node scripts/validate-claude-installs.mjs)
else
  echo "claude CLI not found; skipping native Claude install smoke test." >&2
fi

if command -v codex >/dev/null 2>&1; then
  codex plugin marketplace add "$repo_root"
  codex plugin marketplace remove slop-market || true
else
  echo "codex CLI not found; skipping native Codex marketplace smoke test." >&2
fi
