#!/usr/bin/env node
import Ajv from 'ajv';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Validate Slop Market's dual-provider plugin catalog.
 *
 * Validation runs in layers:
 * 1. Load and register the local JSON Schemas.
 * 2. Validate each marketplace catalog against its provider schema.
 * 3. For local marketplace entries, resolve the plugin root and validate the
 *    matching provider manifest.
 * 4. Check referenced files, skills, hooks, and provider-specific components.
 * 5. Verify local Codex and Claude Code entries describe the same plugin set.
 *
 * The script accumulates errors where possible so contributors get a useful
 * repair list from one run instead of fixing one failure at a time.
 */
const repoRoot = process.cwd();
const schemaRoot = path.join(repoRoot, 'schemas');
const errors = [];
const warnings = [];

// Tracks local catalog entries by provider. Cross-provider validation later
// uses these maps to prove that shared plugin roots are represented in both
// Codex and Claude Code catalogs under the same name.
const localEntries = {
  codex: new Map(),
  claude: new Map()
};

// The same skills directory can be referenced by both manifests. Remembering
// visited directories prevents duplicate warnings and duplicate frontmatter
// errors for a shared implementation.
const validatedSkillDirs = new Set();

// Sentinel value that distinguishes "could not read JSON" from a valid JSON
// value such as null. This lets callers keep accumulating unrelated errors.
const readJsonFailed = Symbol('readJsonFailed');

const schemaFiles = {
  shared: 'shared.schema.json',
  codexMarketplace: 'codex-marketplace.schema.json',
  codexPlugin: 'codex-plugin.schema.json',
  claudeMarketplace: 'claude-marketplace.schema.json',
  claudePlugin: 'claude-plugin.schema.json'
};

// Load schemas before creating validators so broken schema files fail
// immediately with a stack trace. Contributor-authored marketplace data is
// reported through the collected errors array below.
const schemas = Object.fromEntries(
  Object.entries(schemaFiles).map(([name, file]) => {
    const value = readJsonStrict(path.join(schemaRoot, file));
    if (typeof value.$id !== 'string' || value.$id.trim() === '') {
      throw new Error(`${file} must include a non-empty $id`);
    }
    return [name, { file, id: value.$id, value }];
  })
);

// AJV strict mode is disabled because the schemas intentionally mirror provider
// formats that may use shared $defs and compatibility keywords across tools.
const ajv = new Ajv({
  allErrors: true,
  strict: false
});

for (const schema of Object.values(schemas)) {
  ajv.addSchema(schema.value);
}

const kebabNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Validator checks prefer collecting failures over throwing. The final block is
// the single place that decides whether the process exits non-zero.
function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

// Keep paths repository-relative in diagnostics so local and CI output match.
function displayPath(filePath) {
  return path.relative(repoRoot, filePath) || '.';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJsonStrict(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Read contributor-authored JSON without throwing so one malformed file does
// not hide validation problems in unrelated catalog entries.
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

// Run an already-registered schema and translate AJV's machine-oriented errors
// into messages that point at the file and JSON Pointer location.
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

// Handle the common schema keywords used in this repository with clearer text,
// while still falling back to AJV's message for less common failures.
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

/**
 * Resolve a marketplace or manifest path relative to its owning root.
 *
 * Schemas require local paths to start with "./"; this resolver strips that
 * prefix, resolves the path, and rejects traversal outside the expected root so
 * component checks cannot accidentally inspect arbitrary files on the machine.
 */
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

// Confirm that a referenced path exists and, when requested, is the expected
// filesystem kind. expectedKind="any" accepts either a file or directory.
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

// Record local marketplace entries for the later Codex/Claude parity check.
function rememberLocalEntry(provider, name, relativePluginRoot, label) {
  const entries = localEntries[provider];
  if (entries.has(name)) {
    fail(`${label} duplicates local plugin name ${name}`);
    return;
  }

  entries.set(name, relativePluginRoot);
}

// Codex marketplace entries wrap local sources in an object, while Claude Code
// uses a string. Return only local paths; remote/provider sources are skipped.
function resolveLocalSourcePath(source) {
  if (typeof source === 'string') {
    return source;
  }

  if (source?.source === 'local') {
    return source.path;
  }

  return null;
}

// Manifest fields that reference files may be either a single path or an array
// of paths. Normalize both shapes so the validation loop stays shared.
function pathValues(value) {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === 'string');
  }
  return [];
}

// Resolve and check a path-valued manifest field, returning only the paths that
// were valid enough for downstream validation.
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

// Skills and plugins use the same canonical naming rule.
function validateName(value, label) {
  if (!kebabNamePattern.test(value)) {
    fail(`${label} must be kebab-case with lowercase letters, digits, and hyphens`);
  }
}

/**
 * Parse the small YAML frontmatter subset required from SKILL.md files.
 *
 * This is intentionally not a general YAML parser. The validator only needs
 * simple "key: value" metadata for the fields enforced below, and avoiding an
 * extra dependency keeps the validation install small.
 */
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

/**
 * Validate a plugin's skill implementation directory.
 *
 * The validator checks the Slop Market conventions around skill folders rather
 * than every possible runtime behavior: each skill directory must be
 * kebab-case, contain SKILL.md, and include frontmatter with a description.
 */
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

// Read and schema-validate a JSON file before later checks assume object shape.
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

/**
 * Validate one provider manifest for a local plugin entry.
 *
 * The marketplace entry name is the source of truth, so the manifest must use
 * that same name. Provider-specific component checks run after schema
 * validation because schemas determine which fields are legal.
 */
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

// A missing skills field means "use ./skills" by convention. When a manifest
// explicitly lists skills paths, each referenced directory is validated.
function validateSkillsForManifest(pluginRoot, manifest, provider, entryName) {
  if (manifest.skills === undefined) {
    validateSkills(path.join(pluginRoot, 'skills'), `${provider} plugin ${entryName}`);
    return;
  }

  for (const skillsDir of validateExistingPaths(pluginRoot, manifest.skills, `${provider} plugin ${entryName} skills`, 'directory')) {
    validateSkills(skillsDir, `${provider} plugin ${entryName}`);
  }
}

// Dispatch through a shared wrapper so provider names stay explicit at the call
// site while each provider can enforce its own component fields.
function validateComponentFiles(pluginRoot, manifest, manifestDisplayPath, provider) {
  if (provider === 'Codex') {
    validateCodexComponentFiles(pluginRoot, manifest, manifestDisplayPath);
    return;
  }

  validateClaudeComponentFiles(pluginRoot, manifest, manifestDisplayPath);
}

// Codex component fields are file-backed JSON/assets. Validate existence here;
// the schema owns field shape and provider enum constraints.
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

// Claude Code component references can point at files or directories depending
// on the component type, so these checks require existence but allow either kind.
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
    // Claude Code also recognizes hooks/hooks.json by convention; parse it when
    // present even if it is not explicitly referenced from the manifest.
    readJson(defaultHooksPath);
  }
}

// Hooks use the same string-or-array path shape as other manifest components.
function validateHooks(pluginRoot, hooks, label) {
  for (const hookPath of pathValues(hooks)) {
    validateExistingPaths(pluginRoot, hookPath, label, 'file');
  }
}

// Keep Codex default prompts installable by enforcing the runtime's compact
// prompt limit after applying the same whitespace normalization.
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

/**
 * Validate the Codex marketplace catalog and all local Codex manifests it
 * references.
 *
 * Remote/non-local sources are left to the provider tooling; this repository's
 * validation owns only local plugin paths that can be inspected in the checkout.
 */
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

/**
 * Validate the Claude Code marketplace catalog and all local Claude manifests it
 * references. This mirrors the Codex flow while preserving Claude's marketplace
 * and manifest shapes.
 */
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

// Because plugins are shared implementations with two provider manifests, local
// catalog entries must stay paired. A plugin present for only one provider, or
// pointing to different roots, is treated as a repository consistency error.
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

// Execute broad-to-specific validation before printing diagnostics. The order
// matters: marketplace passes populate localEntries for the cross-provider pass.
validateCodexMarketplace();
validateClaudeMarketplace();
validateCrossProviderCatalogs();

// Warnings never fail CI; they call out empty or missing optional implementation
// areas that may be acceptable while a plugin is being developed.
for (const warning of warnings) {
  console.warn(`warning: ${warning}`);
}

// Print all accumulated errors together so contributors can fix related catalog,
// manifest, and filesystem problems in one edit cycle.
if (errors.length > 0) {
  console.error('Marketplace validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Marketplace validation passed for Codex and Claude Code schemas.');
console.log(`Validated ${localEntries.codex.size} shared local plugin(s).`);
