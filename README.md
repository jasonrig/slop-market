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
npm ci
npm run validate
```

Validation uses AJV with the JSON Schema files in `schemas/`, then adds filesystem checks for local plugin paths, shared catalog coverage, and skill frontmatter.

If you have both CLIs installed, you can also run a native smoke test in an isolated temporary home directory:

```sh
npm run validate:native
```

GitHub Actions runs `npm run validate` on pushes and pull requests. The workflow also includes a best-effort native CLI smoke job so CLI behavior changes are visible without making local schema drift the only signal.

## Add A Plugin

Use the scaffold command to create the plugin directory, both provider manifests, a starter skill, and both marketplace entries:

```sh
npm run scaffold -- my-plugin
```

Then replace the generated TODO values, edit the starter skill, and run:

```sh
npm run validate
```

For local plugin entries, keep source paths relative to the marketplace root, start paths with `./`, and keep each plugin self-contained inside its own directory.
