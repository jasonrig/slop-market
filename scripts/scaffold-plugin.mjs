#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * Scaffold a new plugin that can be installed by both supported providers.
 *
 * The script writes one shared plugin implementation under plugins/<name>/,
 * then surrounds it with provider-specific metadata:
 * - .codex-plugin/plugin.json for Codex
 * - .claude-plugin/plugin.json for Claude Code
 * - optional marketplace entries in both root catalogs
 *
 * Keep this file dependency-free so a fresh checkout can run the scaffolder
 * before npm dependencies are installed.
 */
const repoRoot = process.cwd();

// Plugin and skill names are normalized into the same kebab-case form that the
// JSON schemas and validator enforce for marketplace entries and skill folders.
const pluginNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const maxPluginNameLength = 64;

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.positionals.length !== 1) {
  fail('Expected exactly one plugin name. Run `npm run scaffold -- <plugin-name>`.');
}

const pluginName = normalizeName(args.positionals[0]);
if (!pluginName) {
  fail(`Plugin name "${args.positionals[0]}" does not contain letters or digits after normalization.`);
}
if (pluginName.length > maxPluginNameLength) {
  fail(`Plugin name "${pluginName}" is ${pluginName.length} characters; keep names at ${maxPluginNameLength} or fewer.`);
}
if (!pluginNamePattern.test(pluginName)) {
  fail(`Plugin name "${pluginName}" must be lowercase kebab-case.`);
}

const skillName = normalizeName(args.skillName ?? 'getting-started');
if (!skillName || !pluginNamePattern.test(skillName)) {
  fail(`Skill name "${args.skillName}" must normalize to lowercase kebab-case.`);
}

const displayName = args.displayName ?? titleize(pluginName);
const category = args.category ?? 'Productivity';
const description = args.description ?? `[TODO: Describe what ${displayName} does.]`;
const shortDescription = makeShortDescription(displayName, args.description);
const defaultPrompt = makeDefaultPrompt(pluginName, displayName);
const pluginRoot = path.join(repoRoot, 'plugins', pluginName);
const codexMarketplacePath = path.join(repoRoot, '.agents', 'plugins', 'marketplace.json');
const claudeMarketplacePath = path.join(repoRoot, '.claude-plugin', 'marketplace.json');

// Without --force, avoid silently replacing an existing plugin directory. With
// --force, writes below are intentionally limited to the scaffolded files and
// matching marketplace entries for this plugin name.
if (fs.existsSync(pluginRoot) && !args.force) {
  fail(`Plugin directory already exists: ${displayPath(pluginRoot)}. Pass --force to overwrite scaffold files.`);
}

const codexMarketplace = args.marketplace
  ? readMarketplace(codexMarketplacePath, createCodexMarketplace())
  : null;
const claudeMarketplace = args.marketplace
  ? readMarketplace(claudeMarketplacePath, createClaudeMarketplace())
  : null;

if (args.marketplace) {
  upsertMarketplaceEntry({
    marketplace: codexMarketplace,
    marketplacePath: codexMarketplacePath,
    pluginName,
    force: args.force,
    makeEntry: () => ({
      name: pluginName,
      source: {
        source: 'local',
        path: `./plugins/${pluginName}`
      },
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL'
      },
      category
    })
  });

  upsertMarketplaceEntry({
    marketplace: claudeMarketplace,
    marketplacePath: claudeMarketplacePath,
    pluginName,
    force: args.force,
    makeEntry: () => ({
      name: pluginName,
      source: `./plugins/${pluginName}`,
      description
    })
  });
}

writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), createCodexManifest());
writeJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), createClaudeManifest());
writeText(path.join(pluginRoot, 'skills', skillName, 'SKILL.md'), createSkill());
writeText(path.join(pluginRoot, 'README.md'), createReadme());

if (args.marketplace) {
  writeJson(codexMarketplacePath, codexMarketplace);
  writeJson(claudeMarketplacePath, claudeMarketplace);
}

console.log(`Scaffolded ${pluginName} in ${displayPath(pluginRoot)}.`);
if (args.marketplace) {
  console.log('Updated .agents/plugins/marketplace.json and .claude-plugin/marketplace.json.');
}
console.log('Run `npm run validate` to verify the marketplace.');

/**
 * Parse a small hand-rolled CLI surface.
 *
 * Options support both "--key value" and "--key=value" forms. Boolean flags
 * reject inline values so accidental input like "--force=false" fails loudly
 * instead of being treated as truthy.
 */
function parseArgs(argv) {
  const parsed = {
    category: undefined,
    description: undefined,
    displayName: undefined,
    force: false,
    help: false,
    marketplace: true,
    positionals: [],
    skillName: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') {
      parsed.positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!arg.startsWith('--')) {
      parsed.positionals.push(arg);
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const key = arg.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);

    switch (key) {
      case 'category':
        parsed.category = readOptionValue(argv, key, inlineValue, () => {
          index += 1;
          return argv[index];
        });
        break;
      case 'description':
        parsed.description = readOptionValue(argv, key, inlineValue, () => {
          index += 1;
          return argv[index];
        });
        break;
      case 'display-name':
        parsed.displayName = readOptionValue(argv, key, inlineValue, () => {
          index += 1;
          return argv[index];
        });
        break;
      case 'force':
        rejectInlineValue(key, inlineValue);
        parsed.force = true;
        break;
      case 'help':
        rejectInlineValue(key, inlineValue);
        parsed.help = true;
        break;
      case 'no-marketplace':
        rejectInlineValue(key, inlineValue);
        parsed.marketplace = false;
        break;
      case 'skill-name':
        parsed.skillName = readOptionValue(argv, key, inlineValue, () => {
          index += 1;
          return argv[index];
        });
        break;
      default:
        fail(`Unknown option --${key}. Run with --help for usage.`);
    }
  }

  return parsed;
}

// Read a value for a string option after parseArgs has determined whether the
// value was inline or should come from the next argv entry.
function readOptionValue(argv, key, inlineValue, readNext) {
  if (inlineValue !== undefined) {
    if (inlineValue.trim() === '') {
      fail(`--${key} requires a non-empty value.`);
    }
    return inlineValue;
  }

  const nextValue = readNext();
  if (nextValue === undefined || nextValue.startsWith('--')) {
    fail(`--${key} requires a value.`);
  }
  return nextValue;
}

// Keep flag handling strict so every accepted option has one obvious meaning.
function rejectInlineValue(key, inlineValue) {
  if (inlineValue !== undefined) {
    fail(`--${key} does not take a value.`);
  }
}

/**
 * Convert user-facing names into canonical ids.
 *
 * This is intentionally a forgiving transform for input convenience; the
 * result is still checked against pluginNamePattern so empty or malformed names
 * do not become persisted marketplace data.
 */
function normalizeName(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function titleize(name) {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// Codex interface metadata has a compact shortDescription field. Preserve an
// explicit description when it already fits, otherwise trim it predictably.
function makeShortDescription(name, explicitDescription) {
  if (explicitDescription) {
    return explicitDescription.length <= 80 ? explicitDescription : `${explicitDescription.slice(0, 77)}...`;
  }
  return `Starter workflow for ${name}.`;
}

// Codex default prompts are validated at 128 characters after whitespace
// normalization, so fall back to the canonical id if the display name is long.
function makeDefaultPrompt(name, display) {
  const prompt = `Use ${display} when you need its starter workflow.`;
  if ([...prompt.split(/\s+/).filter(Boolean).join(' ')].length <= 128) {
    return prompt;
  }
  return `Use ${name} when you need its starter workflow.`;
}

/**
 * Load an existing marketplace catalog or synthesize the minimum valid shell.
 *
 * This performs only the structural checks needed for safe mutation here. Full
 * schema and filesystem validation is delegated to scripts/validate-marketplace.mjs.
 */
function readMarketplace(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`${displayPath(filePath)} must contain a JSON object.`);
    }
    if (!Array.isArray(parsed.plugins)) {
      fail(`${displayPath(filePath)} must include a plugins array.`);
    }
    return parsed;
  } catch (error) {
    fail(`Could not read ${displayPath(filePath)}: ${error.message}`);
  }
}

// Marketplace factory for a repo that does not yet have a Codex catalog.
function createCodexMarketplace() {
  return {
    $schema: '../../schemas/codex-marketplace.schema.json',
    name: normalizeName(path.basename(repoRoot)) || 'slop-market',
    interface: {
      displayName: titleize(normalizeName(path.basename(repoRoot)) || 'slop-market')
    },
    plugins: []
  };
}

// Marketplace factory for a repo that does not yet have a Claude Code catalog.
function createClaudeMarketplace() {
  return {
    $schema: '../schemas/claude-marketplace.schema.json',
    name: normalizeName(path.basename(repoRoot)) || 'slop-market',
    description: '[TODO: Describe this plugin marketplace.]',
    version: '0.1.0',
    owner: {
      name: '[TODO: Owner Name]'
    },
    plugins: []
  };
}

/**
 * Add or replace exactly one marketplace entry.
 *
 * The provider-specific entry shapes differ, so callers pass makeEntry while
 * this shared helper owns duplicate detection and --force replacement behavior.
 */
function upsertMarketplaceEntry({ marketplace, marketplacePath, pluginName, force, makeEntry }) {
  const existingIndex = marketplace.plugins.findIndex((entry) => entry?.name === pluginName);
  if (existingIndex !== -1 && !force) {
    fail(`${displayPath(marketplacePath)} already contains ${pluginName}. Pass --force to replace that entry.`);
  }

  const entry = makeEntry();
  if (existingIndex === -1) {
    marketplace.plugins.push(entry);
  } else {
    marketplace.plugins[existingIndex] = entry;
  }
}

// Codex manifest metadata mirrors the local schema and includes the interface
// fields surfaced by the Codex plugin marketplace UI.
function createCodexManifest() {
  return {
    $schema: '../../../schemas/codex-plugin.schema.json',
    name: pluginName,
    version: '0.1.0',
    description,
    license: 'MIT',
    keywords: [
      pluginName,
      'codex',
      'claude-code'
    ],
    skills: './skills/',
    interface: {
      displayName,
      shortDescription,
      longDescription: description,
      developerName: '[TODO: Developer Name]',
      category,
      capabilities: [
        'Read'
      ],
      defaultPrompt: [
        defaultPrompt
      ],
      brandColor: '#10A37F'
    }
  };
}

// Claude Code needs its own manifest, but points at the same shared skills
// directory so provider-specific metadata does not duplicate implementation.
function createClaudeManifest() {
  return {
    $schema: '../../../schemas/claude-plugin.schema.json',
    name: pluginName,
    description,
    version: '0.1.0',
    license: 'MIT',
    skills: './skills/'
  };
}

// Starter skill content is intentionally valid but minimal: new plugin authors
// should replace the behavior after scaffold generation.
function createSkill() {
  return `---
name: ${skillName}
description: Starter skill for the ${displayName} plugin scaffold.
---

# ${titleize(skillName)}

Use this skill as the first editable capability for \`${pluginName}\`.

When invoked, confirm that ${displayName} is installed and ready to customize. Keep the response brief.
`;
}

// Keep the generated README focused on the immediate edits needed to make the
// scaffold production-ready.
function createReadme() {
  return `# ${displayName}

Boilerplate Slop Market plugin scaffold.

## Next Steps

- Replace TODO values in both plugin manifests.
- Edit \`skills/${skillName}/SKILL.md\` with the plugin's real behavior.
- Run \`npm run validate\` from the repository root.
`;
}

// All generated JSON is pretty-printed with a trailing newline to keep diffs
// stable and readable.
function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// Create parent directories lazily so each write call owns its full path.
function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

// Report repository-relative paths in CLI output so messages are stable across
// machines and CI workspaces.
function displayPath(filePath) {
  return path.relative(repoRoot, filePath) || '.';
}

function printHelp() {
  console.log(`Usage: npm run scaffold -- <plugin-name> [options]

Create a validation-ready Slop Market plugin under plugins/<plugin-name>.

Options:
  --display-name <name>     Human-readable display name. Defaults to title-case plugin name.
  --description <text>      Manifest and Claude marketplace description.
  --category <name>         Codex marketplace category. Defaults to Productivity.
  --skill-name <name>       Starter skill directory/frontmatter name. Defaults to getting-started.
  --no-marketplace          Create plugin files without adding marketplace entries.
  --force                   Overwrite scaffold files and replace existing marketplace entries.
  --help                    Show this help text.
`);
}

// The scaffolder fails fast because partial writes are only expected after all
// argument and marketplace preflight checks have passed.
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
