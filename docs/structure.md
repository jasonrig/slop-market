# Marketplace Structure

This repository keeps Codex and Claude Code metadata side by side while sharing plugin implementation files.

```text
.
|-- .agents/plugins/marketplace.json       # Codex marketplace catalog
|-- .claude-plugin/marketplace.json        # Claude Code marketplace catalog
|-- plugins/
|   `-- marketplace-starter/
|       |-- .codex-plugin/plugin.json      # Codex plugin manifest
|       |-- .claude-plugin/plugin.json     # Claude Code plugin manifest
|       `-- skills/install-check/SKILL.md  # Shared skill implementation
|-- scripts/validate-marketplace.mjs       # Required CI conformance checks
`-- .github/workflows/validate.yml         # GitHub Actions
```

Codex-specific requirements enforced here:

- The repo catalog lives at `.agents/plugins/marketplace.json`.
- Each local plugin entry includes `policy.installation`, `policy.authentication`, and `category`.
- Local plugin sources use `source.path` values beginning with `./` and staying inside the repository.
- Each plugin has `.codex-plugin/plugin.json`.

Claude Code-specific requirements enforced here:

- The marketplace catalog lives at `.claude-plugin/marketplace.json`.
- The marketplace includes `name`, `owner.name`, and `plugins`.
- Each local plugin entry includes `name` and `source`.
- Each plugin has `.claude-plugin/plugin.json`.

Shared requirements enforced here:

- Local plugin names and paths match across both catalogs.
- Plugin manifests use the same kebab-case plugin name as their catalog entry.
- Skill folders contain `SKILL.md` files with YAML frontmatter and a description.
