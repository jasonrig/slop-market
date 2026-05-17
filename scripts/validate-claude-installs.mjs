#!/usr/bin/env node
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Smoke-test Slop Market's Claude Code catalog through Claude's native install
 * path.
 *
 * Validation runs in layers:
 * 1. Start with isolated HOME and CLAUDE_CONFIG_DIR directories.
 * 2. Ask the Claude CLI to validate and add this repository as a marketplace.
 * 3. Compare marketplace/list and plugin/list metadata with the marketplace
 *    catalog and, for local sources, the plugin manifest.
 * 4. Install each marketplace plugin and verify Claude settings, installed
 *    registry state, cached manifest contents, and enabled plugin/list state.
 *
 * Set CLAUDE_INSTALL_SMOKE_TIMEOUT_MS to adjust each Claude CLI command
 * timeout, and KEEP_CLAUDE_INSTALL_SMOKE_HOME=1 to inspect the temporary Claude
 * config directory.
 */
const repoRoot = process.cwd();
const marketplacePath = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
const marketplace = readJson(marketplacePath);

// Use throwaway homes so marketplace additions and plugin installs never touch
// the real developer or CI runner Claude configuration.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-market-claude-'));
const claudeConfigDir = path.join(tmpHome, '.claude');
const commandTimeoutMs = readPositiveIntegerEnv('CLAUDE_INSTALL_SMOKE_TIMEOUT_MS', 30_000);

fs.mkdirSync(claudeConfigDir, { recursive: true });

try {
  run();
} finally {
  if (process.env.KEEP_CLAUDE_INSTALL_SMOKE_HOME === '1') {
    console.error(`Keeping Claude smoke home at ${tmpHome}`);
  } else {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

function run() {
  runClaude(['plugin', 'validate', repoRoot], 'claude plugin validate');
  runClaude(['plugin', 'marketplace', 'add', repoRoot], 'claude plugin marketplace add');

  const marketplaces = runClaudeJson(
    ['plugin', 'marketplace', 'list', '--json'],
    'claude plugin marketplace list'
  );
  const listedMarketplace = findListedMarketplace(marketplaces);
  assertEqual(listedMarketplace.source, 'directory', `${marketplace.name} marketplace source`);
  assertSameRealPath(listedMarketplace.path, repoRoot, `${marketplace.name} marketplace path`);
  assertSameRealPath(
    listedMarketplace.installLocation,
    repoRoot,
    `${marketplace.name} marketplace installLocation`
  );
  validateKnownMarketplace();

  const initialList = listPlugins();
  assert(Array.isArray(initialList.installed), 'plugin/list installed must be an array');
  assert(Array.isArray(initialList.available), 'plugin/list available must be an array');
  assertNoMarketplaceInstalls(initialList);

  if (marketplace.plugins.length === 0) {
    console.log(`No Claude Code plugins found in marketplace ${marketplace.name}.`);
    return;
  }

  const installedPlugins = [];
  for (const marketplacePlugin of marketplace.plugins) {
    const installedPlugin = installPlugin(initialList, marketplacePlugin);
    installedPlugins.push({ marketplacePlugin, installedPlugin });
  }

  const finalList = listPlugins();
  for (const { marketplacePlugin, installedPlugin } of installedPlugins) {
    validatePluginListAfterInstall(finalList, marketplacePlugin, installedPlugin);
  }

  console.log(
    `Claude install smoke passed for ${installedPlugins.length} plugin(s): ` +
      installedPlugins.map(({ marketplacePlugin }) => pluginId(marketplacePlugin.name)).join(', ')
  );
}

function installPlugin(initialList, marketplacePlugin) {
  const id = pluginId(marketplacePlugin.name);
  const manifestInfo = readLocalPluginManifest(marketplacePlugin);
  const availablePlugin = findAvailablePlugin(initialList, marketplacePlugin.name);

  validateAvailablePlugin(availablePlugin, marketplacePlugin, manifestInfo, 'plugin/list before install');

  runClaude(['plugin', 'install', id], `claude plugin install ${id}`);

  validateSettingsEntry(id);
  const installedPlugin = validateInstalledRegistryEntry(marketplacePlugin, manifestInfo);
  validateCachedManifest(installedPlugin, manifestInfo);

  return installedPlugin;
}

function validatePluginListAfterInstall(listAfterInstall, marketplacePlugin, registryPlugin) {
  const id = pluginId(marketplacePlugin.name);
  const installedPlugin = findInstalledPlugin(listAfterInstall, id);
  validateInstalledPlugin(
    installedPlugin,
    marketplacePlugin,
    registryPlugin,
    'plugin/list after install'
  );
  assert(
    !listAfterInstall.available.some((candidate) => candidate.pluginId === id),
    `${id} remained available after install`
  );
}

function validateAvailablePlugin(availablePlugin, marketplacePlugin, manifestInfo, context) {
  const id = pluginId(marketplacePlugin.name);
  assertEqual(availablePlugin.pluginId, id, `${context} ${id} pluginId`);
  assertEqual(availablePlugin.name, marketplacePlugin.name, `${context} ${id} name`);
  assertEqual(
    availablePlugin.description,
    marketplacePlugin.description,
    `${context} ${id} description`
  );
  assertEqual(
    availablePlugin.marketplaceName,
    marketplace.name,
    `${context} ${id} marketplaceName`
  );

  if (typeof marketplacePlugin.source === 'string') {
    assertEqual(availablePlugin.source, marketplacePlugin.source, `${context} ${id} source`);
  }

  validateMarketplaceManifestParity(marketplacePlugin, manifestInfo, context);
}

function validateInstalledPlugin(installedPlugin, marketplacePlugin, registryPlugin, context) {
  const id = pluginId(marketplacePlugin.name);
  assertEqual(installedPlugin.id, id, `${context} ${id} id`);
  assertEqual(installedPlugin.scope, 'user', `${context} ${id} scope`);
  assertEqual(installedPlugin.enabled, true, `${context} ${id} enabled`);
  assertEqual(installedPlugin.version, registryPlugin.version, `${context} ${id} version`);

  assertPathInside(
    installedPlugin.installPath,
    path.join(claudeConfigDir, 'plugins', 'cache'),
    `${context} ${id} installPath`
  );
  assertSameRealPath(
    installedPlugin.installPath,
    registryPlugin.installPath,
    `${context} ${id} registry installPath`
  );
}

function validateMarketplaceManifestParity(marketplacePlugin, manifestInfo, context) {
  if (!manifestInfo) {
    return;
  }

  const id = pluginId(marketplacePlugin.name);
  assertEqual(manifestInfo.manifest.name, marketplacePlugin.name, `${context} ${id} manifest name`);
  assertEqual(
    manifestInfo.manifest.description,
    marketplacePlugin.description,
    `${context} ${id} manifest description`
  );

  if (marketplacePlugin.version && manifestInfo.manifest.version) {
    assertEqual(
      manifestInfo.manifest.version,
      marketplacePlugin.version,
      `${context} ${id} manifest version`
    );
  }
}

function validateCachedManifest(installedPlugin, manifestInfo) {
  if (!manifestInfo) {
    return;
  }

  const cachedManifestPath = path.join(installedPlugin.installPath, '.claude-plugin', 'plugin.json');
  const cachedManifest = readJson(cachedManifestPath);
  assertDeepEqual(
    cachedManifest,
    manifestInfo.manifest,
    `${manifestInfo.pluginName}@${marketplace.name} cached manifest`
  );
}

function validateKnownMarketplace() {
  const knownMarketplacesPath = path.join(claudeConfigDir, 'plugins', 'known_marketplaces.json');
  const knownMarketplaces = readJson(knownMarketplacesPath);
  const entry = knownMarketplaces[marketplace.name];
  assert(entry, `${marketplace.name} missing known marketplace entry`);
  assertEqual(entry.source?.source, 'directory', `${marketplace.name} known marketplace source`);
  assertSameRealPath(entry.source?.path, repoRoot, `${marketplace.name} known marketplace path`);
  assertSameRealPath(
    entry.installLocation,
    repoRoot,
    `${marketplace.name} known marketplace installLocation`
  );
}

function validateSettingsEntry(id) {
  const settingsPath = path.join(claudeConfigDir, 'settings.json');
  const settings = readJson(settingsPath);
  assertEqual(settings.enabledPlugins?.[id], true, `${id} enabledPlugins setting`);
}

function validateInstalledRegistryEntry(marketplacePlugin, manifestInfo) {
  const id = pluginId(marketplacePlugin.name);
  const installedPluginsPath = path.join(claudeConfigDir, 'plugins', 'installed_plugins.json');
  const installedPlugins = readJson(installedPluginsPath);
  const entries = installedPlugins.plugins?.[id];
  assert(Array.isArray(entries), `${id} missing installed registry entries`);

  const entry = entries.find((candidate) => candidate.scope === 'user');
  assert(entry, `${id} missing user-scope installed registry entry`);
  assertPathInside(
    entry.installPath,
    path.join(claudeConfigDir, 'plugins', 'cache'),
    `${id} registry installPath`
  );

  if (manifestInfo?.manifest.version) {
    assertEqual(entry.version, manifestInfo.manifest.version, `${id} registry manifest version`);
  } else if (marketplacePlugin.version) {
    assertEqual(entry.version, marketplacePlugin.version, `${id} registry marketplace version`);
  } else {
    assert(entry.version, `${id} registry missing version`);
  }

  return entry;
}

function listPlugins() {
  return runClaudeJson(
    ['plugin', 'list', '--available', '--json'],
    'claude plugin list --available'
  );
}

function findListedMarketplace(marketplaces) {
  assert(Array.isArray(marketplaces), 'marketplace/list response must be an array');
  const listedMarketplace = marketplaces.find((candidate) => candidate.name === marketplace.name);
  assert(listedMarketplace, `marketplace/list did not include marketplace ${marketplace.name}`);
  return listedMarketplace;
}

function findAvailablePlugin(listResponse, pluginName) {
  const id = pluginId(pluginName);
  const availablePlugin = listResponse.available?.find((candidate) => candidate.pluginId === id);
  assert(availablePlugin, `plugin/list did not include available plugin ${id}`);
  return availablePlugin;
}

function findInstalledPlugin(listResponse, id) {
  const installedPlugin = listResponse.installed?.find((candidate) => candidate.id === id);
  assert(installedPlugin, `plugin/list did not include installed plugin ${id}`);
  return installedPlugin;
}

function assertNoMarketplaceInstalls(listResponse) {
  const marketplacePluginIds = new Set(marketplace.plugins.map((plugin) => pluginId(plugin.name)));
  const leakedInstalls = listResponse.installed.filter((candidate) =>
    marketplacePluginIds.has(candidate.id)
  );
  assertEqual(
    leakedInstalls.length,
    0,
    `isolated Claude config installed ${marketplace.name} plugin count`
  );
}

function readLocalPluginManifest(marketplacePlugin) {
  const sourcePath = resolveLocalSourcePath(marketplacePlugin.source);
  if (!sourcePath) {
    return null;
  }

  const pluginRoot = resolveRelativePath(repoRoot, sourcePath, `${marketplacePlugin.name}.source`);
  const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  const manifest = readJson(manifestPath);
  return {
    pluginName: marketplacePlugin.name,
    pluginRoot,
    manifestPath,
    manifest
  };
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

/**
 * Resolve a marketplace path relative to its owning root.
 *
 * Schemas require local paths to start with "./"; this resolver strips that
 * prefix, resolves the path, and rejects traversal outside the expected root so
 * the smoke cannot inspect arbitrary files on the machine.
 */
function resolveRelativePath(root, relativePath, label) {
  assert(
    typeof relativePath === 'string' && relativePath.startsWith('./'),
    `${label} must start with ./`
  );

  const relativePart = relativePath.slice(2);
  const absolute = path.resolve(root, ...relativePart.split('/').filter(Boolean));
  const rootAbsolute = path.resolve(root);

  assert(
    absolute === rootAbsolute || absolute.startsWith(`${rootAbsolute}${path.sep}`),
    `${label} resolves outside ${rootAbsolute}`
  );

  return absolute;
}

function runClaudeJson(args, context) {
  const result = runClaude(args, context);
  const stdout = result.stdout.trim();
  assert(stdout, `${context} did not return JSON output`);

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${error.message}\n\nstdout:\n${stdout}`);
  }
}

function runClaude(args, context) {
  const result = childProcess.spawnSync('claude', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: isolatedClaudeEnv(),
    maxBuffer: 10 * 1024 * 1024,
    timeout: commandTimeoutMs
  });

  if (result.error) {
    const message =
      result.error.code === 'ENOENT'
        ? 'claude CLI was not found on PATH'
        : result.error.message;
    throw new Error(`${context} failed: ${message}`);
  }

  if (result.status !== 0) {
    throw new Error(
      `${context} exited with status ${result.status}${commandDetails(result.stdout, result.stderr)}`
    );
  }

  return result;
}

function isolatedClaudeEnv() {
  const env = { ...process.env };

  // Claude plugin cache/seed env vars can redirect marketplace writes outside
  // CLAUDE_CONFIG_DIR, so remove inherited plugin-specific configuration.
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_PLUGIN_')) {
      delete env[key];
    }
  }

  return {
    ...env,
    HOME: tmpHome,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CI: '1',
    NO_COLOR: '1'
  };
}

function commandDetails(stdout, stderr) {
  const parts = [];
  if (stdout.trim()) {
    parts.push(`stdout:\n${stdout.trim()}`);
  }
  if (stderr.trim()) {
    parts.push(`stderr:\n${stderr.trim()}`);
  }
  return parts.length === 0 ? '' : `\n\n${parts.join('\n\n')}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readPositiveIntegerEnv(name, defaultValue) {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return defaultValue;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  return value;
}

function assertSameRealPath(actualPath, expectedPath, context) {
  assert(actualPath, `${context} missing path`);
  const actual = fs.realpathSync(actualPath);
  const expected = fs.realpathSync(expectedPath);
  assertEqual(actual, expected, context);
}

function assertPathInside(actualPath, expectedRoot, context) {
  assert(actualPath, `${context} missing path`);
  const actual = fs.realpathSync(actualPath);
  const root = fs.realpathSync(expectedRoot);
  assert(
    actual === root || actual.startsWith(`${root}${path.sep}`),
    `${context}: expected path inside ${formatValue(root)}, got ${formatValue(actual)}`
  );
}

function assertEqual(actual, expected, context) {
  if (actual !== expected) {
    throw new Error(`${context}: expected ${formatValue(expected)}, got ${formatValue(actual)}`);
  }
}

function assertDeepEqual(actual, expected, context) {
  const actualJson = JSON.stringify(sortJsonValue(actual));
  const expectedJson = JSON.stringify(sortJsonValue(expected));
  if (actualJson !== expectedJson) {
    throw new Error(`${context}: expected ${formatValue(expected)}, got ${formatValue(actual)}`);
  }
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])])
    );
  }
  return value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function formatValue(value) {
  return JSON.stringify(value);
}

function pluginId(pluginName) {
  return `${pluginName}@${marketplace.name}`;
}
