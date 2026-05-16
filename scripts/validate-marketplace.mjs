#!/usr/bin/env node
import Ajv from 'ajv';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const schemaRoot = path.join(repoRoot, 'schemas');
const errors = [];
const warnings = [];
const localEntries = {
  codex: new Map(),
  claude: new Map()
};
const validatedSkillDirs = new Set();
const readJsonFailed = Symbol('readJsonFailed');

const schemaFiles = {
  shared: 'shared.schema.json',
  codexMarketplace: 'codex-marketplace.schema.json',
  codexPlugin: 'codex-plugin.schema.json',
  claudeMarketplace: 'claude-marketplace.schema.json',
  claudePlugin: 'claude-plugin.schema.json'
};

const schemas = Object.fromEntries(
  Object.entries(schemaFiles).map(([name, file]) => {
    const value = readJsonStrict(path.join(schemaRoot, file));
    if (typeof value.$id !== 'string' || value.$id.trim() === '') {
      throw new Error(`${file} must include a non-empty $id`);
    }
    return [name, { file, id: value.$id, value }];
  })
);

const ajv = new Ajv({
  allErrors: true,
  strict: false
});

for (const schema of Object.values(schemas)) {
  ajv.addSchema(schema.value);
}

const kebabNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function readJsonStrict(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`Missing required JSON file: ${displayPath(filePath)}`);
    return readJsonFailed;
  }

  try {
    return readJsonStrict(filePath);
  } catch (error) {
    fail(`Invalid JSON in ${displayPath(filePath)}: ${error.message}`);
    return readJsonFailed;
  }
}

function validateWithSchema(schema, value, filePath) {
  const validate = ajv.getSchema(schema.id);
  if (!validate) {
    throw new Error(`Schema was not registered: ${schema.id}`);
  }

  if (validate(value)) {
    return true;
  }

  for (const error of validate.errors ?? []) {
    const location = error.instancePath || '/';
    const detail = formatSchemaError(error);
    fail(`${displayPath(filePath)}${location}: ${detail}`);
  }
  return false;
}

function formatSchemaError(error) {
  if (error.keyword === 'additionalProperties') {
    return `must not include unknown property ${error.params.additionalProperty}`;
  }
  if (error.keyword === 'enum') {
    return `must be one of ${error.params.allowedValues.join(', ')}`;
  }
  if (error.keyword === 'const') {
    return `must be ${JSON.stringify(error.params.allowedValue)}`;
  }
  if (error.keyword === 'required') {
    return `must include required property ${error.params.missingProperty}`;
  }
  if (error.keyword === 'pattern') {
    return `must match pattern ${error.params.pattern}`;
  }
  return error.message ?? `failed schema keyword ${error.keyword}`;
}

function resolveRelativePath(root, relativePath, label) {
  const relativePart = relativePath.slice(2);
  const absolute = path.resolve(root, ...relativePart.split('/').filter(Boolean));
  const rootAbsolute = path.resolve(root);

  if (absolute !== rootAbsolute && !absolute.startsWith(`${rootAbsolute}${path.sep}`)) {
    fail(`${label} resolves outside ${displayPath(rootAbsolute)}`);
    return null;
  }

  return absolute;
}

function requireExistingPath(filePath, label, expectedKind) {
  if (!filePath) {
    return false;
  }

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      fail(`${label} does not exist: ${displayPath(filePath)}`);
    } else {
      fail(`${label} could not be inspected: ${error.message}`);
    }
    return false;
  }

  if (expectedKind === 'directory' && !stats.isDirectory()) {
    fail(`${label} is not a directory: ${displayPath(filePath)}`);
    return false;
  }

  if (expectedKind === 'file' && !stats.isFile()) {
    fail(`${label} is not a file: ${displayPath(filePath)}`);
    return false;
  }

  return true;
}

function requireExistingDirectory(dirPath, label) {
  return requireExistingPath(dirPath, label, 'directory');
}

function requireExistingFile(filePath, label) {
  return requireExistingPath(filePath, label, 'file');
}

function rememberLocalEntry(provider, name, relativePluginRoot, label) {
  const entries = localEntries[provider];
  if (entries.has(name)) {
    fail(`${label} duplicates local plugin name ${name}`);
    return;
  }

  entries.set(name, relativePluginRoot);
}

function resolveLocalSourcePath(source) {
  if (typeof source === 'string') {
    return source;
  }

  if (source?.source === 'local') {
    return source.path;
  }

  return null;
}

function pathValues(value) {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === 'string');
  }
  return [];
}

function validateExistingPaths(pluginRoot, value, label, expectedKind) {
  const resolvedPaths = [];
  for (const relativePath of pathValues(value)) {
    const resolvedPath = resolveRelativePath(pluginRoot, relativePath, label);
    if (requireExistingPath(resolvedPath, label, expectedKind)) {
      resolvedPaths.push(resolvedPath);
    }
  }
  return resolvedPaths;
}

function validateName(value, label) {
  if (!kebabNamePattern.test(value)) {
    fail(`${label} must be kebab-case with lowercase letters, digits, and hyphens`);
  }
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
    if (typeof frontmatter.description !== 'string' || frontmatter.description.trim() === '') {
      fail(`${displayPath(skillPath)} frontmatter must include description`);
    }
    if (frontmatter.name !== undefined) {
      validateName(frontmatter.name, `${displayPath(skillPath)} frontmatter name`);
      if (frontmatter.name !== skillDir.name) {
        fail(`${displayPath(skillPath)} frontmatter name must match its directory`);
      }
    }
  }
}

function readAndValidateJson(filePath, schema) {
  const value = readJson(filePath);
  if (value === readJsonFailed) {
    return null;
  }

  if (!validateWithSchema(schema, value, filePath) || !isObject(value)) {
    return null;
  }

  return value;
}

function validatePluginManifest(pluginRoot, manifestDir, schema, entryName, provider) {
  const manifestPath = path.join(pluginRoot, manifestDir, 'plugin.json');
  const manifest = readAndValidateJson(manifestPath, schema);
  if (!manifest) {
    return null;
  }

  if (manifest.name !== entryName) {
    fail(`${displayPath(manifestPath)} name must match marketplace entry ${entryName}`);
  }

  validateSkillsForManifest(pluginRoot, manifest, provider, entryName);
  validateComponentFiles(pluginRoot, manifest, displayPath(manifestPath), provider);

  return manifest;
}

function validateSkillsForManifest(pluginRoot, manifest, provider, entryName) {
  if (manifest.skills === undefined) {
    validateSkills(path.join(pluginRoot, 'skills'), `${provider} plugin ${entryName}`);
    return;
  }

  for (const skillsDir of validateExistingPaths(pluginRoot, manifest.skills, `${provider} plugin ${entryName} skills`, 'directory')) {
    validateSkills(skillsDir, `${provider} plugin ${entryName}`);
  }
}

function validateComponentFiles(pluginRoot, manifest, manifestDisplayPath, provider) {
  if (provider === 'Codex') {
    validateCodexComponentFiles(pluginRoot, manifest, manifestDisplayPath);
    return;
  }

  validateClaudeComponentFiles(pluginRoot, manifest, manifestDisplayPath);
}

function validateCodexComponentFiles(pluginRoot, manifest, manifestDisplayPath) {
  for (const field of ['mcpServers', 'apps']) {
    if (manifest[field] !== undefined) {
      validateExistingPaths(pluginRoot, manifest[field], `${manifestDisplayPath} ${field}`, 'file');
    }
  }

  validateHooks(pluginRoot, manifest.hooks, `${manifestDisplayPath} hooks`);

  for (const field of ['composerIcon', 'logo']) {
    const value = manifest.interface?.[field];
    if (value !== undefined) {
      validateExistingPaths(pluginRoot, value, `${manifestDisplayPath} interface.${field}`, 'file');
    }
  }

  if (manifest.interface?.screenshots !== undefined) {
    validateExistingPaths(pluginRoot, manifest.interface.screenshots, `${manifestDisplayPath} interface.screenshots`, 'file');
  }

  if (manifest.interface?.defaultPrompt !== undefined) {
    validateCodexDefaultPrompt(manifest.interface.defaultPrompt, `${manifestDisplayPath} interface.defaultPrompt`);
  }
}

function validateClaudeComponentFiles(pluginRoot, manifest, manifestDisplayPath) {
  for (const field of ['commands', 'agents', 'mcpServers', 'outputStyles', 'lspServers']) {
    if (manifest[field] !== undefined) {
      validateExistingPaths(pluginRoot, manifest[field], `${manifestDisplayPath} ${field}`, 'any');
    }
  }

  validateHooks(pluginRoot, manifest.hooks, `${manifestDisplayPath} hooks`);

  for (const field of ['themes', 'monitors']) {
    const value = manifest.experimental?.[field];
    if (value !== undefined) {
      validateExistingPaths(pluginRoot, value, `${manifestDisplayPath} experimental.${field}`, 'any');
    }
  }

  const defaultHooksPath = path.join(pluginRoot, 'hooks', 'hooks.json');
  if (fs.existsSync(defaultHooksPath)) {
    readJson(defaultHooksPath);
  }
}

function validateHooks(pluginRoot, hooks, label) {
  for (const hookPath of pathValues(hooks)) {
    validateExistingPaths(pluginRoot, hookPath, label, 'file');
  }
}

function validateCodexDefaultPrompt(value, label) {
  const prompts = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(prompts)) {
    return;
  }

  for (const [index, prompt] of prompts.entries()) {
    const promptLabel = typeof value === 'string' ? label : `${label}[${index}]`;
    const normalized = prompt.split(/\s+/).filter(Boolean).join(' ');
    if (normalized.length === 0) {
      fail(`${promptLabel} must not be empty after whitespace normalization`);
    }
    if ([...normalized].length > 128) {
      fail(`${promptLabel} must be at most 128 characters after whitespace normalization`);
    }
  }
}

function validateCodexMarketplace() {
  const marketplacePath = path.join(repoRoot, '.agents', 'plugins', 'marketplace.json');
  const marketplace = readAndValidateJson(marketplacePath, schemas.codexMarketplace);
  if (!marketplace) {
    return;
  }

  for (const [index, entry] of marketplace.plugins.entries()) {
    const label = `Codex marketplace plugins[${index}]`;
    const localPath = resolveLocalSourcePath(entry.source);
    if (!localPath) {
      continue;
    }

    const pluginRoot = resolveRelativePath(repoRoot, localPath, `${label}.source`);
    if (!requireExistingDirectory(pluginRoot, `${label}.source`)) {
      continue;
    }

    rememberLocalEntry('codex', entry.name, displayPath(pluginRoot), label);
    validatePluginManifest(pluginRoot, '.codex-plugin', schemas.codexPlugin, entry.name, 'Codex');
  }
}

function validateClaudeMarketplace() {
  const marketplacePath = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
  const marketplace = readAndValidateJson(marketplacePath, schemas.claudeMarketplace);
  if (!marketplace) {
    return;
  }

  for (const [index, entry] of marketplace.plugins.entries()) {
    const label = `Claude marketplace plugins[${index}]`;
    const localPath = resolveLocalSourcePath(entry.source);
    if (!localPath) {
      continue;
    }

    const pluginRoot = resolveRelativePath(repoRoot, localPath, `${label}.source`);
    if (!requireExistingDirectory(pluginRoot, `${label}.source`)) {
      continue;
    }

    rememberLocalEntry('claude', entry.name, displayPath(pluginRoot), label);
    validatePluginManifest(pluginRoot, '.claude-plugin', schemas.claudePlugin, entry.name, 'Claude');
  }
}

function validateCrossProviderCatalogs() {
  const codexNames = [...localEntries.codex.keys()].sort();
  const claudeNames = [...localEntries.claude.keys()].sort();

  for (const name of codexNames) {
    if (!localEntries.claude.has(name)) {
      fail(`Local Codex plugin ${name} is missing from the Claude marketplace`);
    }
  }

  for (const name of claudeNames) {
    if (!localEntries.codex.has(name)) {
      fail(`Local Claude plugin ${name} is missing from the Codex marketplace`);
    }
  }

  for (const name of codexNames) {
    if (!localEntries.claude.has(name)) {
      continue;
    }

    if (localEntries.codex.get(name) !== localEntries.claude.get(name)) {
      fail(
        `Plugin ${name} points to different paths: Codex=${localEntries.codex.get(name)} Claude=${localEntries.claude.get(name)}`
      );
    }
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

console.log('Marketplace validation passed for Codex and Claude Code schemas.');
console.log(`Validated ${localEntries.codex.size} shared local plugin(s).`);
