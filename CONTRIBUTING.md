# Contributing

Thanks for helping grow Slop Market. This repo favors small, self-contained plugins that can be installed by both Codex and Claude Code.

Before opening a pull request:

- Start new plugins with `npm run scaffold -- <plugin-name>` when possible.
- Keep plugin and skill names in kebab-case.
- Keep plugin files inside `plugins/<plugin-name>/`.
- Add or update both provider manifests.
- Add or update both marketplace entries.
- Do not put `skills/`, `hooks/`, assets, `.mcp.json`, or `.app.json` inside manifest directories.
- Run `npm run validate`.

When changing a released plugin version, update the version in both manifests. Avoid also setting a conflicting version in the Claude marketplace entry.
