#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_TTL_HOURS = 24;
const EXPECTED_SOURCE = "bbb-max-externals/maxforge";
const EXPECTED_SOURCE_URL = "https://github.com/bbb-max-externals/maxforge.git";
const EXPECTED_SKILLS = new Map([
  ["maxforge", "skills/maxforge/SKILL.md"],
  ["maxforge-mcp", "skills/maxforge-mcp/SKILL.md"],
]);

function usage() {
  return `Usage:
  node refresh-skills.mjs [options]

Options:
  --force               Ignore a fresh successful-check cache.
  --offline             Do not invoke the Skills CLI.
  --json                Emit the complete machine-readable result.
  --global, -g          Inspect the global Skills lock.
  --project, -p         Inspect the nearest project Skills lock.
  --lock <path>         Override lock discovery (mainly for managed setups).
  --cache <path>        Override the successful-check cache.
  --ttl-hours <hours>   Cache lifetime. Default: 24.
  --help                Show this help.

The Skills CLI has no check-only mode. When a tracked hash differs, this command
updates that skill. It never treats a failed upstream check as up to date.`;
}

function fail(message) {
  throw new Error(message);
}

function defaultCachePath() {
  return process.env.MAXFORGE_SKILL_REFRESH_CACHE ||
    join(homedir(), ".maxforge", "cache", "skill-refresh-v1.json");
}

function parseArguments(argv) {
  const options = {
    cache: defaultCachePath(),
    force: false,
    global: false,
    help: false,
    json: false,
    lock: undefined,
    offline: false,
    project: false,
    ttlHours: DEFAULT_TTL_HOURS,
  };
  const values = new Map([
    ["--cache", "cache"],
    ["--lock", "lock"],
    ["--ttl-hours", "ttlHours"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--global" || argument === "-g") {
      options.global = true;
      continue;
    }
    if (argument === "--project" || argument === "-p") {
      options.project = true;
      continue;
    }
    if (["--force", "--offline", "--json"].includes(argument)) {
      options[argument.slice(2)] = true;
      continue;
    }
    const key = values.get(argument);
    if (!key) fail(`unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    options[key] = key === "ttlHours" ? Number(value) : resolve(value);
    index += 1;
  }
  if (options.global && options.project) fail("--global and --project are mutually exclusive");
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

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function now() {
  const fixture = process.env.MAXFORGE_SKILL_REFRESH_NOW;
  if (!fixture) return new Date();
  const parsed = new Date(fixture);
  if (Number.isNaN(parsed.valueOf())) fail("MAXFORGE_SKILL_REFRESH_NOW is invalid");
  return parsed;
}

function issue(code, severity, message, details = undefined) {
  return { code, severity, message, ...(details ? { details } : {}) };
}

async function findProjectLock(start) {
  let current = resolve(start);
  while (true) {
    const candidate = join(current, "skills-lock.json");
    if (await exists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function relevantEntries(lock) {
  if (!lock || typeof lock !== "object" || !lock.skills || typeof lock.skills !== "object") {
    return [];
  }
  return [...EXPECTED_SKILLS].flatMap(([name, expectedPath]) => {
    const entry = lock.skills[name];
    return entry ? [{ name, expectedPath, entry }] : [];
  });
}

function validateEntries(entries, lockPath, issues) {
  const hashes = {};
  const names = [];
  for (const { name, expectedPath, entry } of entries) {
    if (entry.source !== EXPECTED_SOURCE || entry.sourceType !== "github" ||
      entry.sourceUrl !== EXPECTED_SOURCE_URL) {
      issues.push(issue(
        "UNTRUSTED_SKILL_SOURCE",
        "error",
        `Refusing to refresh ${name} from an unexpected source.`,
        {
          lockPath,
          source: entry.source ?? null,
          sourceType: entry.sourceType ?? null,
          sourceUrl: entry.sourceUrl ?? null,
        }
      ));
      continue;
    }
    if (entry.ref) {
      issues.push(issue(
        "SKILL_SOURCE_PINNED",
        "error",
        `${name} is pinned to a Git ref and cannot establish the current default-branch skill revision.`,
        { lockPath, ref: entry.ref }
      ));
      continue;
    }
    if (entry.skillPath !== expectedPath || typeof entry.skillFolderHash !== "string" ||
      entry.skillFolderHash.length === 0) {
      issues.push(issue(
        "UNTRACKED_SKILL_REVISION",
        "error",
        `${name} lacks the expected tracked skill path or folder hash.`,
        { lockPath }
      ));
      continue;
    }
    names.push(name);
    hashes[name] = entry.skillFolderHash;
  }
  return { hashes, names };
}

async function inspectLock(path, scope, issues) {
  if (!path || !(await exists(path))) return undefined;
  try {
    const entries = relevantEntries(await readJson(path));
    if (entries.length === 0) return undefined;
    const validated = validateEntries(entries, path, issues);
    return { path, scope, ...validated };
  } catch (error) {
    issues.push(issue(
      "SKILL_LOCK_UNREADABLE",
      "error",
      "The Skills lock could not be read.",
      { path, error: error instanceof Error ? error.message : String(error) }
    ));
    return { path, scope, hashes: {}, names: [] };
  }
}

async function discoverLock(options, issues) {
  if (options.lock) {
    const scope = options.project ? "project" : "global";
    return inspectLock(options.lock, scope, issues);
  }
  const globalPath = join(homedir(), ".agents", ".skill-lock.json");
  const projectPath = await findProjectLock(process.cwd());
  if (options.global) return inspectLock(globalPath, "global", issues);
  if (options.project) return inspectLock(projectPath, "project", issues);

  const globalLock = await inspectLock(globalPath, "global", issues);
  const projectLock = await inspectLock(projectPath, "project", issues);
  if (globalLock && projectLock) {
    issues.push(issue(
      "AMBIGUOUS_SKILL_SCOPE",
      "error",
      "maxforge skills are tracked in both global and project scopes; select one explicitly."
    ));
    return undefined;
  }
  return globalLock ?? projectLock;
}

function hashesEqual(left, right) {
  const leftEntries = Object.entries(left ?? {}).sort();
  const rightEntries = Object.entries(right ?? {}).sort();
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

async function readCache(path) {
  try {
    const cache = await readJson(path);
    const checkedAt = new Date(cache.checkedAt);
    if (cache.schemaVersion !== CACHE_SCHEMA_VERSION || Number.isNaN(checkedAt.valueOf()) ||
      typeof cache.lockPath !== "string" || !cache.hashes || typeof cache.hashes !== "object") {
      return undefined;
    }
    return { ...cache, checkedAt: checkedAt.toISOString() };
  } catch {
    return undefined;
  }
}

async function writeCache(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function invokeSkillsCli(lock) {
  const scope = lock.scope === "global" ? "--global" : "--project";
  const fixtureCli = process.env.MAXFORGE_SKILLS_CLI_FIXTURE;
  const command = fixtureCli ? process.execPath : "npx";
  const arguments_ = fixtureCli
    ? [fixtureCli, ...lock.names, scope, "--yes"]
    : ["-y", "skills", "update", ...lock.names, scope, "--yes"];
  return spawnSync(command, arguments_, {
    encoding: "utf8",
    env: { ...process.env, MAXFORGE_SKILL_REFRESH_LOCK: lock.path },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function cliFailure(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error) return result.error.message;
  if (result.status !== 0) return output.trim() || `exit ${String(result.status)}`;
  if (/Failed to fetch tree|Failed to check skills|✗\s+Failed/i.test(output)) {
    return "Skills CLI reported an upstream check failure despite returning success.";
  }
  return undefined;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const checkedAt = now();
  const issues = [];
  const lock = await discoverLock(options, issues);
  if (!lock || lock.names.length === 0 || issues.some((entry) => entry.severity === "error")) {
    const result = {
      schemaVersion: 1,
      checkedAt: checkedAt.toISOString(),
      status: issues.some((entry) => entry.severity === "error") ? "blocked" : "untracked",
      checked: false,
      reloadRequired: false,
      updatedSkills: [],
      lock: lock ? { path: lock.path, scope: lock.scope, hashes: lock.hashes } : null,
      issues: issues.length > 0 ? issues : [issue(
        "SKILLS_UNTRACKED",
        "warning",
        "No tracked maxforge skill lock was found; current skill freshness is unknown."
      )],
    };
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : textReport(result));
    return;
  }

  const cache = await readCache(options.cache);
  const ageMs = cache ? checkedAt.valueOf() - new Date(cache.checkedAt).valueOf() : Infinity;
  const fresh = ageMs >= 0 && ageMs <= options.ttlHours * 60 * 60 * 1_000;
  if (!options.force && fresh && cache.lockPath === lock.path && hashesEqual(cache.hashes, lock.hashes)) {
    const result = {
      schemaVersion: 1,
      checkedAt: checkedAt.toISOString(),
      status: "current",
      checked: true,
      cached: true,
      reloadRequired: false,
      updatedSkills: [],
      lock: { path: lock.path, scope: lock.scope, hashes: lock.hashes },
      issues,
    };
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : textReport(result));
    return;
  }

  if (options.offline) {
    issues.push(issue(
      "SKILL_UPDATE_UNCHECKED",
      "warning",
      "Skill freshness could not be checked in offline mode."
    ));
    const result = {
      schemaVersion: 1,
      checkedAt: checkedAt.toISOString(),
      status: "unknown",
      checked: false,
      cached: false,
      reloadRequired: false,
      updatedSkills: [],
      lock: { path: lock.path, scope: lock.scope, hashes: lock.hashes },
      issues,
    };
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : textReport(result));
    return;
  }

  const commandResult = invokeSkillsCli(lock);
  const commandFailure = cliFailure(commandResult);
  if (commandFailure) {
    issues.push(issue(
      "SKILL_UPDATE_CHECK_FAILED",
      "warning",
      "The Skills CLI could not establish the latest skill revision.",
      { error: commandFailure }
    ));
    const result = {
      schemaVersion: 1,
      checkedAt: checkedAt.toISOString(),
      status: "unknown",
      checked: false,
      cached: false,
      reloadRequired: false,
      updatedSkills: [],
      lock: { path: lock.path, scope: lock.scope, hashes: lock.hashes },
      issues,
    };
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : textReport(result));
    return;
  }

  const refreshedIssues = [];
  const refreshed = await inspectLock(lock.path, lock.scope, refreshedIssues);
  if (!refreshed || refreshed.names.length !== lock.names.length || refreshedIssues.length > 0) {
    issues.push(...refreshedIssues, issue(
      "SKILL_LOCK_REFRESH_INVALID",
      "error",
      "The Skills CLI completed but the refreshed lock is incomplete or invalid."
    ));
  }
  const updatedSkills = refreshed
    ? lock.names.filter((name) => lock.hashes[name] !== refreshed.hashes[name])
    : [];
  const finalHashes = refreshed?.hashes ?? lock.hashes;
  if (!issues.some((entry) => entry.severity === "error")) {
    try {
      await writeCache(options.cache, {
        schemaVersion: CACHE_SCHEMA_VERSION,
        checkedAt: checkedAt.toISOString(),
        lockPath: lock.path,
        hashes: finalHashes,
      });
    } catch (error) {
      issues.push(issue(
        "SKILL_CACHE_WRITE_FAILED",
        "warning",
        "Skill freshness was checked, but its cache could not be written.",
        { error: error instanceof Error ? error.message : String(error) }
      ));
    }
  }
  const result = {
    schemaVersion: 1,
    checkedAt: checkedAt.toISOString(),
    status: issues.some((entry) => entry.severity === "error")
      ? "blocked"
      : updatedSkills.length > 0 ? "updated" : "current",
    checked: !issues.some((entry) => entry.severity === "error"),
    cached: false,
    reloadRequired: updatedSkills.length > 0,
    updatedSkills,
    lock: { path: lock.path, scope: lock.scope, hashes: finalHashes },
    issues,
  };
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : textReport(result));
}

function textReport(result) {
  const lines = [`maxforge skill refresh: ${result.status}`];
  if (result.lock) lines.push(`scope: ${result.lock.scope} (${result.lock.path})`);
  if (result.updatedSkills.length > 0) lines.push(`updated: ${result.updatedSkills.join(", ")}`);
  if (result.reloadRequired) lines.push("reload the installed skill instructions before continuing");
  for (const entry of result.issues) lines.push(`${entry.severity}: [${entry.code}] ${entry.message}`);
  return `${lines.join("\n")}\n`;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
