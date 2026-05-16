# Slop Market

Slop Market is a Codex-first plugin marketplace scaffold with a Claude Code compatible catalog alongside it.

The repository intentionally carries both marketplace formats:

- Codex reads `.agents/plugins/marketplace.json`.
- Claude Code reads `.claude-plugin/marketplace.json`.
- Shared plugins live under `plugins/<plugin-name>/` and include both `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json` manifests.

## Install

Codex:

```sh
codex plugin marketplace add jasonrig/slop-market
```

Claude Code:

```sh
claude plugin marketplace add jasonrig/slop-market
```

Local development:

```sh
codex plugin marketplace add ./
claude plugin marketplace add ./
```

## Validate

Run the docs-derived conformance checks before pushing:

```sh
npm run validate
```

If you have both CLIs installed, you can also run a native smoke test in an isolated temporary home directory:

```sh
npm run validate:native
```

GitHub Actions runs `npm run validate` on pushes and pull requests. The workflow also includes a best-effort native CLI smoke job so CLI behavior changes are visible without making local schema drift the only signal.

## Add A Plugin

1. Create `plugins/<plugin-name>/` using kebab-case.
2. Add `plugins/<plugin-name>/.codex-plugin/plugin.json` for Codex.
3. Add `plugins/<plugin-name>/.claude-plugin/plugin.json` for Claude Code.
4. Put skills under `plugins/<plugin-name>/skills/<skill-name>/SKILL.md`.
5. Add the plugin to both marketplace files.
6. Run `npm run validate`.

For local plugin entries, keep source paths relative to the marketplace root, start paths with `./`, and keep each plugin self-contained inside its own directory.
