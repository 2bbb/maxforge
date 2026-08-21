#!/usr/bin/env node

import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_TTL_HOURS = 24;
const GITHUB_LATEST_URL =
  "https://api.github.com/repos/bbb-max-externals/maxforge/releases/latest";
const NPM_LATEST_URL = "https://registry.npmjs.org/maxforge/latest";
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function usage() {
  return `Usage:
  node check-version.mjs [options]

Options:
  --force                  Ignore a fresh remote-version cache.
  --offline                Do not access GitHub or npm.
  --json                   Emit the complete machine-readable result.
  --cache <path>           Override the remote-version cache file.
  --codex-config <path>    Override the Codex config path.
  --max-package <path>     Add an explicit maxforge Max package root. Repeatable.
  --project-root <path>    Root used for bounded project-local discovery.
  --ttl-hours <hours>      Remote cache lifetime. Default: 24.
  --help                   Show this help.

This command only inspects versions. It never edits MCP configuration or a Max
package, and an unavailable network does not block unrelated local work.`;
}

function fail(message) {
  throw new Error(message);
}

function defaultCachePath() {
  return process.env.MAXFORGE_VERSION_CACHE ||
    join(homedir(), ".maxforge", "cache", "version-check-v1.json");
}

function defaultCodexConfigPath() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexHome, "config.toml");
}

function parseArguments(argv) {
  const options = {
    cache: defaultCachePath(),
    codexConfig: defaultCodexConfigPath(),
    force: false,
    help: false,
    json: false,
    maxPackages: [],
    offline: false,
    projectRoot: process.cwd(),
    ttlHours: DEFAULT_TTL_HOURS,
  };
  const values = new Map([
    ["--cache", "cache"],
    ["--codex-config", "codexConfig"],
    ["--project-root", "projectRoot"],
    ["--ttl-hours", "ttlHours"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--force" || argument === "--offline" || argument === "--json") {
      options[argument.slice(2)] = true;
      continue;
    }
    if (argument === "--max-package") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("--max-package requires a value");
      options.maxPackages.push(resolve(value));
      index += 1;
      continue;
    }
    const key = values.get(argument);
    if (!key) fail(`unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    options[key] = key === "ttlHours" ? Number(value) : resolve(value);
    index += 1;
  }

  if (!Number.isFinite(options.ttlHours) || options.ttlHours < 0) {
    fail("--ttl-hours must be a non-negative number");
  }
  return options;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function exactVersion(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  return SEMVER.test(normalized) ? normalized : undefined;
}

function compareVersions(left, right) {
  const leftMatch = exactVersion(left)?.match(SEMVER);
  const rightMatch = exactVersion(right)?.match(SEMVER);
  if (!leftMatch || !rightMatch) return undefined;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  const leftPre = leftMatch[4];
  const rightPre = rightMatch[4];
  if (!leftPre && !rightPre) return 0;
  if (!leftPre) return 1;
  if (!rightPre) return -1;
  const leftParts = leftPre.split(".");
  const rightParts = rightPre.split(".");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    if (leftParts[index] === rightParts[index]) continue;
    const leftNumeric = /^\d+$/.test(leftParts[index]);
    const rightNumeric = /^\d+$/.test(rightParts[index]);
    if (leftNumeric && rightNumeric) {
      return Math.sign(Number(leftParts[index]) - Number(rightParts[index]));
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftParts[index].localeCompare(rightParts[index]) < 0 ? -1 : 1;
  }
  return 0;
}

function now() {
  const fixture = process.env.MAXFORGE_VERSION_CHECK_NOW;
  if (!fixture) return new Date();
  const parsed = new Date(fixture);
  if (Number.isNaN(parsed.valueOf())) fail("MAXFORGE_VERSION_CHECK_NOW is invalid");
  return parsed;
}

function issue(code, severity, message, details = undefined) {
  return { code, severity, message, ...(details ? { details } : {}) };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function validateRemote(remote) {
  if (!remote || remote.schemaVersion !== CACHE_SCHEMA_VERSION) return undefined;
  const githubVersion = exactVersion(remote.github?.version);
  const npmVersion = exactVersion(remote.npm?.version);
  const checkedAt = new Date(remote.checkedAt);
  if (!githubVersion || !npmVersion || Number.isNaN(checkedAt.valueOf())) return undefined;
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    checkedAt: checkedAt.toISOString(),
    github: {
      version: githubVersion,
      url: typeof remote.github.url === "string" ? remote.github.url : null,
      assetsComplete: remote.github.assetsComplete === true,
    },
    npm: { version: npmVersion },
  };
}

async function readCache(path) {
  try {
    return validateRemote(await readJson(path));
  } catch {
    return undefined;
  }
}

async function writeCache(path, remote) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(remote, null, 2)}\n`, { mode: 0o600 });
}

async function fetchJson(url, fixtureEnvironmentName) {
  const fixture = process.env[fixtureEnvironmentName];
  if (fixture) return readJson(fixture);
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "maxforge-version-preflight",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    fail(`${url} returned ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchRemote(checkedAt) {
  const [github, npm] = await Promise.all([
    fetchJson(GITHUB_LATEST_URL, "MAXFORGE_VERSION_CHECK_GITHUB_FIXTURE"),
    fetchJson(NPM_LATEST_URL, "MAXFORGE_VERSION_CHECK_NPM_FIXTURE"),
  ]);
  const githubVersion = exactVersion(github.tag_name);
  const npmVersion = exactVersion(npm.version);
  if (!githubVersion) fail("GitHub latest release did not contain an exact semantic version tag");
  if (!npmVersion) fail("npm latest metadata did not contain an exact semantic version");
  const assetNames = new Set(
    Array.isArray(github.assets) ? github.assets.map((asset) => asset?.name) : []
  );
  const archive = `maxforge-v${githubVersion}.zip`;
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    checkedAt: checkedAt.toISOString(),
    github: {
      version: githubVersion,
      url: typeof github.html_url === "string" ? github.html_url : null,
      assetsComplete: assetNames.has(archive) && assetNames.has(`${archive}.sha256`),
    },
    npm: { version: npmVersion },
  };
}

async function resolveRemote(options, issues, checkedAt) {
  const cached = await readCache(options.cache);
  const ageMs = cached ? checkedAt.valueOf() - new Date(cached.checkedAt).valueOf() : Infinity;
  const fresh = ageMs >= 0 && ageMs <= options.ttlHours * 60 * 60 * 1_000;

  if (!options.force && fresh) return { ...cached, cached: true, stale: false };
  if (options.offline) {
    if (cached) return { ...cached, cached: true, stale: !fresh };
    issues.push(issue(
      "REMOTE_UNAVAILABLE",
      "warning",
      "No cached release metadata is available in offline mode."
    ));
    return null;
  }

  try {
    const remote = await fetchRemote(checkedAt);
    try {
      await writeCache(options.cache, remote);
    } catch (error) {
      issues.push(issue(
        "CACHE_WRITE_FAILED",
        "warning",
        "Remote metadata was fetched but its cache could not be written.",
        { error: error instanceof Error ? error.message : String(error) }
      ));
    }
    return { ...remote, cached: false, stale: false };
  } catch (error) {
    issues.push(issue(
      "REMOTE_UNAVAILABLE",
      "warning",
      cached
        ? "Release metadata refresh failed; stale cached metadata is being used."
        : "Release metadata could not be fetched and no cache is available.",
      { error: error instanceof Error ? error.message : String(error) }
    ));
    return cached ? { ...cached, cached: true, stale: true } : null;
  }
}

function maxforgeSection(contents) {
  const lines = contents.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    /^\s*\[\s*mcp_servers\.(?:maxforge|"maxforge"|'maxforge')\s*]\s*(?:#.*)?$/.test(line)
  );
  if (start < 0) return undefined;
  const section = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) break;
    section.push(lines[index]);
  }
  return section.join("\n");
}

function tomlAssignment(section, key) {
  const match = new RegExp(`^\\s*${key}\\s*=`, "m").exec(section);
  if (!match) return undefined;
  let index = match.index + match[0].length;
  while (/\s/.test(section[index] ?? "")) index += 1;
  const start = index;
  const isArray = section[index] === "[";
  let depth = 0;
  let quote = null;
  let escaped = false;
  let comment = false;

  for (; index < section.length; index += 1) {
    const character = section[index];
    if (comment) {
      if (character === "\n") {
        comment = false;
        if (!isArray) return section.slice(start, index);
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") {
      comment = true;
      continue;
    }
    if (isArray && character === "[") depth += 1;
    if (isArray && character === "]") {
      depth -= 1;
      if (depth === 0) return section.slice(start, index + 1);
    }
    if (!isArray && character === "\n") return section.slice(start, index);
  }
  return section.slice(start);
}

function withoutTomlComments(value) {
  let result = "";
  let quote = null;
  let escaped = false;
  let comment = false;
  for (const character of value) {
    if (comment) {
      if (character === "\n") {
        comment = false;
        result += character;
      }
      continue;
    }
    if (quote) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
    } else if (character === "#") {
      comment = true;
    } else {
      result += character;
    }
  }
  return result;
}

async function inspectCodexConfig(path, issues) {
  if (!(await exists(path))) return null;
  let section;
  try {
    section = maxforgeSection(await readFile(path, "utf8"));
  } catch (error) {
    issues.push(issue("MCP_CONFIG_UNREADABLE", "warning", "Codex MCP configuration could not be read.", {
      path,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
  if (section === undefined) return null;
  const command = withoutTomlComments(tomlAssignment(section, "command") ?? "");
  const arguments_ = withoutTomlComments(tomlAssignment(section, "args") ?? "");
  const packageMatch = arguments_.match(/(?:--package=)?maxforge@([^\s"',\]]+)/);
  const specifier = packageMatch?.[1];
  if (specifier === "latest") {
    issues.push(issue(
      "MCP_MOVING_VERSION",
      "error",
      "The maxforge MCP command uses the moving npm latest tag.",
      { path }
    ));
    return { path, mode: "npx-moving", version: null };
  }
  const version = exactVersion(specifier);
  if (version) return { path, mode: "npx-exact", version };
  const bundled = /tools[\\/]mcp[\\/]maxforge-mcp\.mjs/.test(`${command}\n${arguments_}`);
  if (bundled) return { path, mode: "max-package-bundled", version: null };
  issues.push(issue(
    "MCP_VERSION_UNKNOWN",
    "warning",
    "A maxforge MCP entry exists, but its exact runtime version cannot be determined safely.",
    { path }
  ));
  return { path, mode: "unknown", version: null };
}

async function defaultPackageCandidates(projectRoot) {
  const candidates = new Set();
  if (process.env.MAXFORGE_VERSION_CHECK_NO_HOME_DISCOVERY !== "1") {
    const documents = join(homedir(), "Documents");
    try {
      for (const entry of await readdir(documents, { withFileTypes: true })) {
        if (entry.isDirectory() && /^Max \d+$/.test(entry.name)) {
          candidates.add(join(documents, entry.name, "Packages", "maxforge"));
        }
      }
    } catch {
      // A missing or redirected Documents directory is not a version error.
    }
  }

  let current = resolve(projectRoot);
  while (true) {
    candidates.add(join(current, "Packages", "maxforge"));
    candidates.add(join(current, "packages", "maxforge"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

async function inspectPackage(root, explicit, issues) {
  const metadataPath = join(root, "package-info.json");
  if (!(await exists(metadataPath))) {
    if (explicit) {
      issues.push(issue(
        "MAX_PACKAGE_NOT_FOUND",
        "warning",
        "An explicitly selected maxforge Max package has no package-info.json.",
        { root }
      ));
    }
    return null;
  }
  try {
    const metadata = await readJson(metadataPath);
    const version = exactVersion(metadata.version);
    if (metadata.title !== "maxforge" || !version) {
      issues.push(issue(
        "MAX_PACKAGE_INVALID",
        "warning",
        "Max package metadata does not identify an exact maxforge version.",
        { root }
      ));
      return { root, version: null };
    }
    return { root, version };
  } catch (error) {
    issues.push(issue(
      "MAX_PACKAGE_INVALID",
      "warning",
      "Max package metadata could not be parsed.",
      { root, error: error instanceof Error ? error.message : String(error) }
    ));
    return { root, version: null };
  }
}

async function inspectPackages(options, issues) {
  const explicit = new Set(options.maxPackages.map((path) => resolve(path)));
  const candidates = await defaultPackageCandidates(options.projectRoot);
  for (const path of explicit) candidates.add(path);
  const packages = [];
  for (const root of [...candidates].sort()) {
    const inspected = await inspectPackage(root, explicit.has(root), issues);
    if (inspected) packages.push(inspected);
  }
  return packages;
}

function compareLocalToLatest(label, localVersion, latestVersion, details, issues) {
  if (!localVersion || !latestVersion) return;
  const comparison = compareVersions(localVersion, latestVersion);
  if (comparison < 0) {
    issues.push(issue(
      `${label}_OUTDATED`,
      "notice",
      `${label === "MCP" ? "MCP runtime" : "Max package"} ${localVersion} is older than ${latestVersion}.`,
      details
    ));
  } else if (comparison > 0) {
    issues.push(issue(
      `${label}_AHEAD_OF_RELEASE`,
      "warning",
      `${label === "MCP" ? "MCP runtime" : "Max package"} ${localVersion} is newer than the latest coherent release ${latestVersion}.`,
      details
    ));
  }
}

function assess(remote, mcp, packages, issues) {
  let latest = null;
  if (remote) {
    if (remote.github.version !== remote.npm.version) {
      issues.push(issue(
        "PUBLISHED_VERSION_MISMATCH",
        "error",
        `GitHub Release ${remote.github.version} and npm latest ${remote.npm.version} are not coherent.`
      ));
    } else if (!remote.github.assetsComplete) {
      issues.push(issue(
        "RELEASE_ASSETS_INCOMPLETE",
        "error",
        `GitHub Release ${remote.github.version} lacks its exact Max package archive or checksum.`
      ));
    } else {
      latest = remote.github.version;
    }
  }

  compareLocalToLatest("MCP", mcp?.version, latest, mcp ? { path: mcp.path } : undefined, issues);
  for (const installed of packages) {
    compareLocalToLatest(
      "NATIVE",
      installed.version,
      latest,
      { root: installed.root },
      issues
    );
  }

  const localVersions = new Set([
    ...(mcp?.version ? [mcp.version] : []),
    ...packages.flatMap((installed) => installed.version ? [installed.version] : []),
  ]);
  if (localVersions.size > 1) {
    issues.push(issue(
      "LOCAL_VERSION_MISMATCH",
      "error",
      `Configured MCP and discovered Max packages do not form one exact version set: ${[...localVersions].sort().join(", ")}.`
    ));
  }

  const codes = new Set(issues.map((entry) => entry.code));
  let status = "current";
  if (!remote) status = "unknown";
  if ([...issues].some((entry) => entry.severity === "error")) status = "blocked";
  else if (codes.has("MCP_OUTDATED") || codes.has("NATIVE_OUTDATED")) status = "update-available";
  else if (remote?.stale) status = "stale";
  return { latest, status };
}

function textReport(result) {
  const lines = [`maxforge version preflight: ${result.status}`];
  if (result.latest) lines.push(`latest coherent release: ${result.latest}`);
  else if (result.remote) {
    lines.push(`published: GitHub ${result.remote.github.version}, npm ${result.remote.npm.version}`);
  } else {
    lines.push("published: unavailable");
  }
  lines.push(result.local.mcp
    ? `MCP: ${result.local.mcp.version ?? result.local.mcp.mode} (${result.local.mcp.path})`
    : "MCP: not configured in the inspected Codex config");
  if (result.local.maxPackages.length === 0) lines.push("Max package: not discovered");
  for (const installed of result.local.maxPackages) {
    lines.push(`Max package: ${installed.version ?? "unknown"} (${installed.root})`);
  }
  for (const entry of result.issues) {
    lines.push(`${entry.severity}: [${entry.code}] ${entry.message}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const checkedAt = now();
  const issues = [];
  const [remote, mcp, packages] = await Promise.all([
    resolveRemote(options, issues, checkedAt),
    inspectCodexConfig(options.codexConfig, issues),
    inspectPackages(options, issues),
  ]);
  const assessment = assess(remote, mcp, packages, issues);
  const result = {
    schemaVersion: 1,
    checkedAt: checkedAt.toISOString(),
    status: assessment.status,
    latest: assessment.latest,
    remote,
    local: {
      codexConfig: options.codexConfig,
      mcp,
      maxPackages: packages,
    },
    issues,
  };
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : textReport(result));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
