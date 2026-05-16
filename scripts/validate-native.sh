#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_home="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_home"
}
trap cleanup EXIT

export HOME="$tmp_home"
export CODEX_HOME="$tmp_home/.codex"
export CLAUDE_CONFIG_DIR="$tmp_home/.claude"
mkdir -p "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"

if command -v claude >/dev/null 2>&1; then
  claude plugin validate "$repo_root"
else
  echo "claude CLI not found; skipping native Claude validation." >&2
fi

if command -v codex >/dev/null 2>&1; then
  codex plugin marketplace add "$repo_root"
  codex plugin marketplace remove slop-market || true
else
  echo "codex CLI not found; skipping native Codex marketplace smoke test." >&2
fi
