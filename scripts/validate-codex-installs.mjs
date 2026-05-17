#!/usr/bin/env node
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Smoke-test Slop Market's Codex catalog through Codex's native install path.
 *
 * Validation runs in layers:
 * 1. Start a Codex app-server with isolated HOME and CODEX_HOME directories.
 * 2. Add this repository as a local marketplace through Codex's marketplace API.
 * 3. Compare plugin/list and plugin/read metadata with the marketplace catalog
 *    and, for local sources, the plugin manifest registered by Codex.
 * 4. Install each installable plugin and verify the Codex config plus the
 *    installed/enabled state reported by plugin/list.
 *
 * This script uses the app-server plugin/install route until a released Codex
 * CLI exposes direct plugin install commands.
 *
 * Set CODEX_INSTALL_SMOKE_TIMEOUT_MS to adjust the per-request timeout, and
 * KEEP_CODEX_INSTALL_SMOKE_HOME=1 to inspect the temporary Codex home.
 */
const repoRoot = process.cwd();
const marketplacePath = path.join(repoRoot, '.agents', 'plugins', 'marketplace.json');
const marketplace = readJson(marketplacePath);

// Use throwaway homes so install state and config writes never touch the real
// developer or CI runner Codex configuration.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-market-codex-'));
const codexHome = path.join(tmpHome, '.codex');
const requestTimeoutMs = readPositiveIntegerEnv('CODEX_INSTALL_SMOKE_TIMEOUT_MS', 30_000);

fs.mkdirSync(codexHome, { recursive: true });

// The released Codex CLI does not yet expose direct plugin install commands, so
// the smoke talks to the same app-server JSON-RPC route the app uses.
const appServer = childProcess.spawn(
  'codex',
  [
    'app-server',
    '--enable',
    'plugins',
    '--disable',
    'remote_plugin',
    '--listen',
    'stdio://'
  ],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tmpHome,
      CODEX_HOME: codexHome,
      CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: '1',
      RUST_LOG: process.env.RUST_LOG ?? 'warn'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  }
);

let nextRequestId = 0;
let stdoutBuffer = '';
let stderrBuffer = '';
let appServerError = null;
const pendingRequests = new Map();

appServer.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString();
  const lines = stdoutBuffer.split(/\n/);
  stdoutBuffer = lines.pop() ?? '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!Object.hasOwn(message, 'id')) {
      continue;
    }

    const pending = pendingRequests.get(message.id);
    if (!pending) {
      continue;
    }

    clearTimeout(pending.timeout);
    pendingRequests.delete(message.id);
    pending.resolve(message);
  }
});

appServer.stderr.on('data', (chunk) => {
  stderrBuffer += chunk.toString();
  if (stderrBuffer.length > 16_000) {
    stderrBuffer = stderrBuffer.slice(-16_000);
  }
});

appServer.on('exit', (code, signal) => {
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(
      new Error(
        `codex app-server exited before request ${id} (${pending.method}) completed: ` +
          `code=${code ?? 'null'} signal=${signal ?? 'null'}${stderrDetails()}`
      )
    );
  }
  pendingRequests.clear();
});

appServer.on('error', (error) => {
  appServerError = error;
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(
      new Error(
        `codex app-server failed before request ${id} (${pending.method}) completed: ` +
          `${error.message}${stderrDetails()}`
      )
    );
  }
  pendingRequests.clear();
});

try {
  await run();
} finally {
  appServer.kill();
  if (process.env.KEEP_CODEX_INSTALL_SMOKE_HOME === '1') {
    console.error(`Keeping Codex smoke home at ${tmpHome}`);
  } else {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

async function run() {
  const initializeResult = await sendRequest('initialize', {
    clientInfo: {
      name: 'slop-market-codex-install-smoke',
      title: null,
      version: marketplace.version ?? '0.1.0'
    },
    capabilities: {
      experimentalApi: true
    }
  });
  assert(initializeResult.codexHome, 'initialize response did not include codexHome');
  sendNotification('initialized');

  const addResult = await sendRequest('marketplace/add', {
    source: repoRoot,
    refName: null,
    sparsePaths: null
  });
  assertEqual(addResult.marketplaceName, marketplace.name, 'marketplace/add marketplaceName');
  assertSameRealPath(addResult.installedRoot, repoRoot, 'marketplace/add installedRoot');

  const initialList = await listLocalPlugins();
  const listedMarketplace = findListedMarketplace(initialList);
  assertEqual(
    listedMarketplace.interface?.displayName ?? null,
    marketplace.interface?.displayName ?? null,
    `${marketplace.name} displayName`
  );
  assertSameRealPath(listedMarketplace.path, marketplacePath, `${marketplace.name} marketplace path`);

  const installablePlugins = marketplace.plugins.filter(
    (plugin) => plugin.policy?.installation !== 'NOT_AVAILABLE'
  );

  if (installablePlugins.length === 0) {
    console.log(`No installable Codex plugins found in marketplace ${marketplace.name}.`);
    return;
  }

  const checkedPlugins = [];
  for (const marketplacePlugin of installablePlugins) {
    await validateInstallablePlugin(listedMarketplace, marketplacePlugin);
    checkedPlugins.push(pluginId(marketplacePlugin.name));
  }

  console.log(
    `Codex install smoke passed for ${checkedPlugins.length} plugin(s): ${checkedPlugins.join(', ')}`
  );
}

async function validateInstallablePlugin(listedMarketplace, marketplacePlugin) {
  if (marketplacePlugin.policy.installation === 'INSTALLED_BY_DEFAULT') {
    await validateInstalledByDefaultPlugin(listedMarketplace, marketplacePlugin);
    return;
  }

  await validateAvailablePluginInstall(listedMarketplace, marketplacePlugin);
}

async function validateInstalledByDefaultPlugin(listedMarketplace, marketplacePlugin) {
  const id = pluginId(marketplacePlugin.name);
  const manifestInfo = readLocalPluginManifest(marketplacePlugin);
  const listedPlugin = findListedPlugin(listedMarketplace, marketplacePlugin.name);

  validateListedPlugin(
    listedPlugin,
    marketplacePlugin,
    manifestInfo,
    'plugin/list installed-by-default'
  );
  validatePluginState(
    listedPlugin,
    { installed: true, enabled: true, availability: ['AVAILABLE', 'ENABLED'] },
    `${id} installed-by-default state`
  );

  const readResult = await sendRequest('plugin/read', {
    marketplacePath: listedMarketplace.path,
    remoteMarketplaceName: null,
    pluginName: marketplacePlugin.name
  });
  validateReadPlugin(readResult.plugin, marketplacePlugin, manifestInfo, 'plugin/read installed-by-default');
}

async function validateAvailablePluginInstall(listedMarketplace, marketplacePlugin) {
  const id = pluginId(marketplacePlugin.name);
  const manifestInfo = readLocalPluginManifest(marketplacePlugin);
  const listedPlugin = findListedPlugin(listedMarketplace, marketplacePlugin.name);

  validateListedPlugin(listedPlugin, marketplacePlugin, manifestInfo, 'plugin/list before install');
  validatePluginState(
    listedPlugin,
    { installed: false, enabled: false, availability: ['AVAILABLE'] },
    `${id} before install state`
  );

  const readResult = await sendRequest('plugin/read', {
    marketplacePath: listedMarketplace.path,
    remoteMarketplaceName: null,
    pluginName: marketplacePlugin.name
  });
  validateReadPlugin(readResult.plugin, marketplacePlugin, manifestInfo, 'plugin/read before install');

  const installResult = await sendRequest('plugin/install', {
    marketplacePath: listedMarketplace.path,
    remoteMarketplaceName: null,
    pluginName: marketplacePlugin.name
  });
  assertEqual(installResult.authPolicy, marketplacePlugin.policy.authentication, `${id} install authPolicy`);
  assert(Array.isArray(installResult.appsNeedingAuth), `${id} appsNeedingAuth must be an array`);

  validateConfigEntry(id);

  const listAfterInstall = await listLocalPlugins();
  const marketplaceAfterInstall = findListedMarketplace(listAfterInstall);
  const pluginAfterInstall = findListedPlugin(marketplaceAfterInstall, marketplacePlugin.name);
  validateListedPlugin(
    pluginAfterInstall,
    marketplacePlugin,
    manifestInfo,
    'plugin/list after install'
  );
  validatePluginState(
    pluginAfterInstall,
    { installed: true, enabled: true, availability: ['AVAILABLE', 'ENABLED'] },
    `${id} after install state`
  );
}

function validateListedPlugin(listedPlugin, marketplacePlugin, manifestInfo, context) {
  const id = pluginId(marketplacePlugin.name);
  assertEqual(listedPlugin.id, id, `${context} ${id} id`);
  assertEqual(listedPlugin.name, marketplacePlugin.name, `${context} ${id} name`);
  assertEqual(
    listedPlugin.installPolicy,
    marketplacePlugin.policy.installation,
    `${context} ${id} installPolicy`
  );
  assertEqual(
    listedPlugin.authPolicy,
    marketplacePlugin.policy.authentication,
    `${context} ${id} authPolicy`
  );
  assertEqual(
    listedPlugin.interface?.category ?? null,
    marketplacePlugin.category,
    `${context} ${id} category`
  );
  validateSource(listedPlugin.source, manifestInfo, `${context} ${id} source`);
  validateManifestInterface(listedPlugin.interface, manifestInfo, `${context} ${id} interface`);
}

function validateReadPlugin(readPlugin, marketplacePlugin, manifestInfo, context) {
  const id = pluginId(marketplacePlugin.name);
  assert(readPlugin, `${context} ${id} missing plugin detail`);
  assertEqual(readPlugin.marketplaceName, marketplace.name, `${context} ${id} marketplaceName`);
  assertEqual(readPlugin.summary?.id, id, `${context} ${id} summary id`);
  assertEqual(readPlugin.summary?.name, marketplacePlugin.name, `${context} ${id} summary name`);
  assertEqual(
    readPlugin.summary?.installPolicy,
    marketplacePlugin.policy.installation,
    `${context} ${id} summary installPolicy`
  );
  assertEqual(
    readPlugin.summary?.authPolicy,
    marketplacePlugin.policy.authentication,
    `${context} ${id} summary authPolicy`
  );
  assertEqual(
    readPlugin.summary?.interface?.category ?? null,
    marketplacePlugin.category,
    `${context} ${id} summary category`
  );
  validateSource(readPlugin.summary?.source, manifestInfo, `${context} ${id} summary source`);
  validateManifestInterface(
    readPlugin.summary?.interface,
    manifestInfo,
    `${context} ${id} summary interface`
  );
}

function validateManifestInterface(actualInterface, manifestInfo, context) {
  if (!manifestInfo) {
    return;
  }

  assertEqual(manifestInfo.manifest.name, manifestInfo.pluginName, `${context} manifest name`);
  const expectedInterface = manifestInfo.manifest.interface ?? {};
  const fields = [
    ['displayName', 'displayName'],
    ['shortDescription', 'shortDescription'],
    ['longDescription', 'longDescription'],
    ['developerName', 'developerName'],
    ['capabilities', 'capabilities'],
    ['websiteURL', 'websiteUrl'],
    ['defaultPrompt', 'defaultPrompt'],
    ['brandColor', 'brandColor']
  ];

  for (const [manifestKey, actualKey] of fields) {
    if (!Object.hasOwn(expectedInterface, manifestKey)) {
      continue;
    }
    assert(actualInterface, `${context} missing interface`);
    const expectedValue = normalizeInterfaceValue(manifestKey, expectedInterface[manifestKey]);
    assertDeepEqual(
      actualInterface[actualKey],
      expectedValue,
      `${context} ${manifestKey}`
    );
  }
}

function validateSource(actualSource, manifestInfo, context) {
  if (!manifestInfo) {
    return;
  }

  assert(actualSource, `${context} missing source`);
  assertEqual(actualSource.type, 'local', `${context} type`);
  assertSameRealPath(actualSource.path, manifestInfo.pluginRoot, context);
}

function validateConfigEntry(id) {
  const configPath = path.join(codexHome, 'config.toml');
  const config = fs.readFileSync(configPath, 'utf8');
  const headerPattern = `\\[plugins\\."${escapeRegExp(id)}"\\]`;
  const sectionMatch = config.match(new RegExp(`${headerPattern}\\s*([\\s\\S]*?)(?=\\n\\[|$)`));
  assert(sectionMatch, `${id} missing config section in ${configPath}`);
  assert(
    /^\s*enabled\s*=\s*true\s*$/m.test(sectionMatch[1]),
    `${id} config section does not contain enabled = true`
  );
}

function validatePluginState(listedPlugin, expected, context) {
  assertEqual(listedPlugin.installed, expected.installed, `${context} installed`);

  const hasEnabled = Object.hasOwn(listedPlugin, 'enabled');
  const hasAvailability = Object.hasOwn(listedPlugin, 'availability');

  if (hasEnabled) {
    assertEqual(listedPlugin.enabled, expected.enabled, `${context} enabled`);
  }
  if (hasAvailability) {
    assertOneOfAvailability(listedPlugin.availability, expected.availability, `${context} availability`);
  }

  assert(hasEnabled || hasAvailability, `${context} missing enabled or availability state`);
}

function assertOneOfAvailability(actual, expectedValues, context) {
  const normalizedActual = typeof actual === 'string' ? actual.toUpperCase() : actual;
  const normalizedExpected = expectedValues.map((value) => value.toUpperCase());
  if (!normalizedExpected.includes(normalizedActual)) {
    throw new Error(
      `${context}: expected one of ${formatValue(expectedValues)}, got ${formatValue(actual)}`
    );
  }
}

async function listLocalPlugins() {
  return sendRequest('plugin/list', {
    cwds: null,
    marketplaceKinds: ['local']
  });
}

function findListedMarketplace(listResponse) {
  const listedMarketplace = listResponse.marketplaces?.find(
    (candidate) => candidate.name === marketplace.name
  );
  assert(listedMarketplace, `plugin/list did not include marketplace ${marketplace.name}`);
  return listedMarketplace;
}

function findListedPlugin(listedMarketplace, pluginName) {
  const listedPlugin = listedMarketplace.plugins?.find((candidate) => candidate.name === pluginName);
  assert(listedPlugin, `plugin/list did not include plugin ${pluginId(pluginName)}`);
  return listedPlugin;
}

function readLocalPluginManifest(marketplacePlugin) {
  const sourcePath = resolveLocalSourcePath(marketplacePlugin.source);
  if (!sourcePath) {
    return null;
  }

  const pluginRoot = resolveRelativePath(repoRoot, sourcePath, `${marketplacePlugin.name}.source`);
  const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
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

function normalizeInterfaceValue(key, value) {
  if (key === 'defaultPrompt' && typeof value === 'string') {
    return [value];
  }
  return value;
}

function pluginId(pluginName) {
  return `${pluginName}@${marketplace.name}`;
}

async function sendRequest(method, params) {
  if (appServerError) {
    throw new Error(`codex app-server failed: ${appServerError.message}${stderrDetails()}`);
  }

  const id = nextRequestId++;
  const message = {
    jsonrpc: '2.0',
    id,
    method,
    params
  };

  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timed out waiting for ${method} response${stderrDetails()}`));
    }, requestTimeoutMs);

    pendingRequests.set(id, {
      method,
      resolve,
      reject,
      timeout
    });

    appServer.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (!error) {
        return;
      }
      clearTimeout(timeout);
      pendingRequests.delete(id);
      reject(error);
    });
  });

  if (response.error) {
    throw new Error(
      `${method} returned error ${response.error.code}: ${response.error.message}${stderrDetails()}`
    );
  }

  return response.result;
}

function sendNotification(method, params) {
  appServer.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
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

function assertEqual(actual, expected, context) {
  if (actual !== expected) {
    throw new Error(`${context}: expected ${formatValue(expected)}, got ${formatValue(actual)}`);
  }
}

function assertDeepEqual(actual, expected, context) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${context}: expected ${formatValue(expected)}, got ${formatValue(actual)}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function formatValue(value) {
  return JSON.stringify(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stderrDetails() {
  const trimmed = stderrBuffer.trim();
  return trimmed ? `\n\ncodex app-server stderr:\n${trimmed}` : '';
}
