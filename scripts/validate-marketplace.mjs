#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const errors = [];
const warnings = [];
const codexLocalEntries = new Map();
const claudeLocalEntries = new Map();
const validatedSkillDirs = new Set();
const readJsonFailed = Symbol('readJsonFailed');

const codexInstallationValues = new Set([
  'AVAILABLE',
  'INSTALLED_BY_DEFAULT',
  'NOT_AVAILABLE'
]);
const codexAuthenticationValues = new Set(['ON_INSTALL', 'ON_USE']);
const claudeReservedNames = new Set([
  'claude-code-marketplace',
  'claude-code-plugins',
  'claude-plugins-official',
  'anthropic-marketplace',
  'anthropic-plugins',
  'agent-skills',
  'knowledge-work-plugins',
  'life-sciences'
]);

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function displayPath(filePath) {
  return path.relative(repoRoot, filePath) || '.';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isKebabName(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`Missing required JSON file: ${displayPath(filePath)}`);
    return readJsonFailed;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Invalid JSON in ${displayPath(filePath)}: ${error.message}`);
    return readJsonFailed;
  }
}

function resolveInside(root, relativePath, label) {
  if (!isNonEmptyString(relativePath)) {
    fail(`${label} must be a non-empty string`);
    return null;
  }

  if (!relativePath.startsWith('./')) {
    fail(`${label} must start with ./`);
  }

  if (relativePath.includes('\\')) {
    fail(`${label} must use forward slashes`);
  }

  if (path.isAbsolute(relativePath)) {
    fail(`${label} must be relative, not absolute`);
    return null;
  }

  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    fail(`${label} must stay inside the marketplace root`);
    return null;
  }

  const absolute = path.resolve(root, relativePath);
  const rootAbsolute = path.resolve(root);
  if (absolute !== rootAbsolute && !absolute.startsWith(`${rootAbsolute}${path.sep}`)) {
    fail(`${label} resolves outside ${displayPath(rootAbsolute)}`);
    return null;
  }

  return absolute;
}

function requireExistingDirectory(dirPath, label) {
  if (!dirPath) {
    return false;
  }

  if (!fs.existsSync(dirPath)) {
    fail(`${label} does not exist: ${displayPath(dirPath)}`);
    return false;
  }

  if (!fs.statSync(dirPath).isDirectory()) {
    fail(`${label} is not a directory: ${displayPath(dirPath)}`);
    return false;
  }

  return true;
}

function requireExistingFile(filePath, label) {
  if (!filePath) {
    return false;
  }

  if (!fs.existsSync(filePath)) {
    fail(`${label} does not exist: ${displayPath(filePath)}`);
    return false;
  }

  if (!fs.statSync(filePath).isFile()) {
    fail(`${label} is not a file: ${displayPath(filePath)}`);
    return false;
  }

  return true;
}

function validateName(value, label) {
  assert(isKebabName(value), `${label} must be kebab-case with lowercase letters, digits, and hyphens`);
}

function validateOptionalVersion(value, label) {
  if (value === undefined) {
    return;
  }

  assert(
    isNonEmptyString(value) && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value),
    `${label} should be a SemVer-like string such as 0.1.0`
  );
}

function validateLicense(value, label) {
  if (value === undefined) {
    warn(`${label} omits license; this marketplace is MIT licensed, so plugin manifests should usually say MIT`);
    return;
  }

  assert(value === 'MIT', `${label} must be MIT for this repository`);
}

function rememberLocalEntry(entries, name, relativePluginRoot, label) {
  if (entries.has(name)) {
    fail(`${label} duplicates local plugin name ${name}`);
    return;
  }

  entries.set(name, relativePluginRoot);
}

function parseFrontmatter(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.startsWith('---\n')) {
    fail(`${displayPath(filePath)} must start with YAML frontmatter`);
    return {};
  }

  const end = text.indexOf('\n---', 4);
  if (end === -1) {
    fail(`${displayPath(filePath)} is missing closing YAML frontmatter marker`);
    return {};
  }

  const frontmatter = {};
  const lines = text.slice(4, end).split('\n');
  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      fail(`${displayPath(filePath)} has unsupported frontmatter line: ${line}`);
      continue;
    }

    frontmatter[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }

  return frontmatter;
}

function validateSkills(skillsDir, label) {
  const skillsDirKey = path.resolve(skillsDir);
  if (validatedSkillDirs.has(skillsDirKey)) {
    return;
  }
  validatedSkillDirs.add(skillsDirKey);

  if (!fs.existsSync(skillsDir)) {
    warn(`${label} has no skills directory`);
    return;
  }

  if (!requireExistingDirectory(skillsDir, `${label} skills directory`)) {
    return;
  }

  const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (skillDirs.length === 0) {
    warn(`${label} skills directory is empty`);
    return;
  }

  for (const skillDir of skillDirs) {
    validateName(skillDir.name, `${label} skill directory ${skillDir.name}`);
    const skillPath = path.join(skillsDir, skillDir.name, 'SKILL.md');
    if (!requireExistingFile(skillPath, `${label} skill ${skillDir.name}`)) {
      continue;
    }

    const frontmatter = parseFrontmatter(skillPath);
    assert(isNonEmptyString(frontmatter.description), `${displayPath(skillPath)} frontmatter must include description`);
    if (frontmatter.name !== undefined) {
      validateName(frontmatter.name, `${displayPath(skillPath)} frontmatter name`);
      assert(frontmatter.name === skillDir.name, `${displayPath(skillPath)} frontmatter name must match its directory`);
    }
  }
}

function validateManifestPath(pluginRoot, value, label, expectedKind = 'any') {
  const resolvedPaths = [];
  const paths = Array.isArray(value) ? value : [value];
  for (const relativePath of paths) {
    if (isObject(relativePath)) {
      continue;
    }

    const resolvedPath = resolveInside(pluginRoot, relativePath, label);
    if (expectedKind === 'directory') {
      if (requireExistingDirectory(resolvedPath, label)) {
        resolvedPaths.push(resolvedPath);
      }
    } else if (expectedKind === 'file') {
      if (requireExistingFile(resolvedPath, label)) {
        resolvedPaths.push(resolvedPath);
      }
    } else if (resolvedPath && !fs.existsSync(resolvedPath)) {
      fail(`${label} does not exist: ${displayPath(resolvedPath)}`);
    } else if (resolvedPath) {
      resolvedPaths.push(resolvedPath);
    }
  }

  return resolvedPaths;
}

function readPluginManifest(pluginRoot, manifestDir, entryName, providerLabel) {
  const manifestPath = path.join(pluginRoot, manifestDir, 'plugin.json');
  const manifest = readJson(manifestPath);
  if (manifest === readJsonFailed) {
    return null;
  }

  assert(isObject(manifest), `${displayPath(manifestPath)} must contain an object`);
  if (!isObject(manifest)) {
    return null;
  }

  validateName(manifest.name, `${displayPath(manifestPath)} name`);
  assert(manifest.name === entryName, `${displayPath(manifestPath)} name must match marketplace entry ${entryName}`);
  assert(isNonEmptyString(manifest.description), `${displayPath(manifestPath)} description is required`);
  validateOptionalVersion(manifest.version, `${displayPath(manifestPath)} version`);
  validateLicense(manifest.license, `${displayPath(manifestPath)} license`);

  return { manifest, manifestPath, providerLabel };
}

function validateCodexPlugin(pluginRoot, entryName) {
  const result = readPluginManifest(pluginRoot, '.codex-plugin', entryName, 'Codex');
  if (!result) {
    return;
  }

  const { manifest, manifestPath, providerLabel } = result;

  if (manifest.skills !== undefined) {
    const skillDirs = validateManifestPath(pluginRoot, manifest.skills, `${displayPath(manifestPath)} skills`, 'directory');
    for (const skillsDir of skillDirs) {
      validateSkills(skillsDir, `${providerLabel} plugin ${entryName}`);
    }
  } else {
    validateSkills(path.join(pluginRoot, 'skills'), `${providerLabel} plugin ${entryName}`);
  }

  if (manifest.mcpServers !== undefined) {
    validateManifestPath(pluginRoot, manifest.mcpServers, `${displayPath(manifestPath)} mcpServers`, 'file');
  }
  if (manifest.apps !== undefined) {
    validateManifestPath(pluginRoot, manifest.apps, `${displayPath(manifestPath)} apps`, 'file');
  }
  if (manifest.hooks !== undefined) {
    validateManifestPath(pluginRoot, manifest.hooks, `${displayPath(manifestPath)} hooks`, 'file');
  }

  if (manifest.interface !== undefined) {
    assert(isObject(manifest.interface), `${displayPath(manifestPath)} interface must be an object`);
    if (manifest.interface.composerIcon !== undefined) {
      validateManifestPath(pluginRoot, manifest.interface.composerIcon, `${displayPath(manifestPath)} interface.composerIcon`, 'file');
    }
    if (manifest.interface.logo !== undefined) {
      validateManifestPath(pluginRoot, manifest.interface.logo, `${displayPath(manifestPath)} interface.logo`, 'file');
    }
    if (manifest.interface.screenshots !== undefined) {
      validateManifestPath(pluginRoot, manifest.interface.screenshots, `${displayPath(manifestPath)} interface.screenshots`, 'file');
    }
  }
}

function validateClaudePlugin(pluginRoot, entryName) {
  const result = readPluginManifest(pluginRoot, '.claude-plugin', entryName, 'Claude');
  if (!result) {
    return;
  }

  validateSkills(path.join(pluginRoot, 'skills'), `${result.providerLabel} plugin ${entryName}`);

  const hooksPath = path.join(pluginRoot, 'hooks', 'hooks.json');
  if (fs.existsSync(hooksPath)) {
    readJson(hooksPath);
  }
}

function codexLocalSourcePath(entry, label) {
  const source = entry.source;
  if (typeof source === 'string') {
    return source;
  }

  if (!isObject(source)) {
    fail(`${label} source must be a string or object`);
    return null;
  }

  if (source.source === 'local') {
    return source.path;
  }

  if (source.source === 'git-subdir') {
    assert(isNonEmptyString(source.url), `${label} git-subdir source requires url`);
    assert(isNonEmptyString(source.path), `${label} git-subdir source requires path`);
    return null;
  }

  if (source.source === 'url') {
    assert(isNonEmptyString(source.url), `${label} url source requires url`);
    return null;
  }

  fail(`${label} has unsupported Codex source type: ${source.source}`);
  return null;
}

function claudeLocalSourcePath(entry, label) {
  const source = entry.source;
  if (typeof source === 'string') {
    return source;
  }

  if (!isObject(source)) {
    fail(`${label} source must be a string or object`);
    return null;
  }

  if (source.source === 'github') {
    assert(isNonEmptyString(source.repo), `${label} github source requires repo`);
    return null;
  }

  if (source.source === 'url') {
    assert(isNonEmptyString(source.url), `${label} url source requires url`);
    return null;
  }

  if (source.source === 'git-subdir') {
    assert(isNonEmptyString(source.url), `${label} git-subdir source requires url`);
    assert(isNonEmptyString(source.path), `${label} git-subdir source requires path`);
    return null;
  }

  if (source.source === 'npm') {
    assert(isNonEmptyString(source.package), `${label} npm source requires package`);
    return null;
  }

  fail(`${label} has unsupported Claude source type: ${source.source}`);
  return null;
}

function validateCodexMarketplace() {
  const marketplacePath = path.join(repoRoot, '.agents', 'plugins', 'marketplace.json');
  const marketplace = readJson(marketplacePath);
  if (marketplace === readJsonFailed) {
    return;
  }

  assert(isObject(marketplace), `${displayPath(marketplacePath)} must contain an object`);
  if (!isObject(marketplace)) {
    return;
  }

  validateName(marketplace.name, 'Codex marketplace name');
  assert(isObject(marketplace.interface), 'Codex marketplace interface is required');
  assert(isNonEmptyString(marketplace.interface?.displayName), 'Codex marketplace interface.displayName is required');
  assert(Array.isArray(marketplace.plugins), 'Codex marketplace plugins must be an array');
  if (!Array.isArray(marketplace.plugins)) {
    return;
  }

  for (const [index, entry] of marketplace.plugins.entries()) {
    const label = `Codex marketplace plugins[${index}]`;
    assert(isObject(entry), `${label} must be an object`);
    if (!isObject(entry)) {
      continue;
    }

    validateName(entry.name, `${label}.name`);
    assert(isObject(entry.policy), `${label}.policy is required`);
    assert(codexInstallationValues.has(entry.policy?.installation), `${label}.policy.installation is invalid`);
    assert(codexAuthenticationValues.has(entry.policy?.authentication), `${label}.policy.authentication is invalid`);
    assert(isNonEmptyString(entry.category), `${label}.category is required`);

    const localPath = codexLocalSourcePath(entry, label);
    if (localPath) {
      const pluginRoot = resolveInside(repoRoot, localPath, `${label}.source.path`);
      requireExistingDirectory(pluginRoot, `${label}.source.path`);
      if (pluginRoot) {
        const relativePluginRoot = displayPath(pluginRoot);
        rememberLocalEntry(codexLocalEntries, entry.name, relativePluginRoot, label);
        validateCodexPlugin(pluginRoot, entry.name);
      }
    }
  }
}

function validateClaudeMarketplace() {
  const marketplacePath = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
  const marketplace = readJson(marketplacePath);
  if (marketplace === readJsonFailed) {
    return;
  }

  assert(isObject(marketplace), `${displayPath(marketplacePath)} must contain an object`);
  if (!isObject(marketplace)) {
    return;
  }

  validateName(marketplace.name, 'Claude marketplace name');
  assert(!claudeReservedNames.has(marketplace.name), `Claude marketplace name is reserved: ${marketplace.name}`);
  assert(isObject(marketplace.owner), 'Claude marketplace owner is required');
  assert(isNonEmptyString(marketplace.owner?.name), 'Claude marketplace owner.name is required');
  assert(Array.isArray(marketplace.plugins), 'Claude marketplace plugins must be an array');
  validateOptionalVersion(marketplace.version, 'Claude marketplace version');
  if (!Array.isArray(marketplace.plugins)) {
    return;
  }

  for (const [index, entry] of marketplace.plugins.entries()) {
    const label = `Claude marketplace plugins[${index}]`;
    assert(isObject(entry), `${label} must be an object`);
    if (!isObject(entry)) {
      continue;
    }

    validateName(entry.name, `${label}.name`);
    assert(isNonEmptyString(entry.description), `${label}.description is recommended and required in this repo`);

    const localPath = claudeLocalSourcePath(entry, label);
    if (localPath) {
      const pluginRoot = resolveInside(repoRoot, localPath, `${label}.source`);
      requireExistingDirectory(pluginRoot, `${label}.source`);
      if (pluginRoot) {
        const relativePluginRoot = displayPath(pluginRoot);
        rememberLocalEntry(claudeLocalEntries, entry.name, relativePluginRoot, label);
        validateClaudePlugin(pluginRoot, entry.name);
      }
    }
  }
}

function validateCrossProviderCatalogs() {
  const codexNames = [...codexLocalEntries.keys()].sort();
  const claudeNames = [...claudeLocalEntries.keys()].sort();

  for (const name of codexNames) {
    assert(claudeLocalEntries.has(name), `Local Codex plugin ${name} is missing from the Claude marketplace`);
  }

  for (const name of claudeNames) {
    assert(codexLocalEntries.has(name), `Local Claude plugin ${name} is missing from the Codex marketplace`);
  }

  for (const name of codexNames) {
    if (!claudeLocalEntries.has(name)) {
      continue;
    }

    assert(
      codexLocalEntries.get(name) === claudeLocalEntries.get(name),
      `Plugin ${name} points to different paths: Codex=${codexLocalEntries.get(name)} Claude=${claudeLocalEntries.get(name)}`
    );
  }
}

validateCodexMarketplace();
validateClaudeMarketplace();
validateCrossProviderCatalogs();

for (const warning of warnings) {
  console.warn(`warning: ${warning}`);
}

if (errors.length > 0) {
  console.error('Marketplace validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Marketplace validation passed for Codex and Claude Code.');
console.log(`Validated ${codexLocalEntries.size} shared local plugin(s).`);
