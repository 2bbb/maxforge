#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function usage() {
  return `Usage:
  node set-codex-mcp-version.mjs --version X.Y.Z [options]

Options:
  --version <version>      Exact coherent maxforge version to pin.
  --config <path>          Codex config. Default: $CODEX_HOME/config.toml or ~/.codex/config.toml
  --backup-root <path>     Default: ~/.maxforge/backups/codex-config
  --dry-run                Validate and report without writing.
  --json                   Emit machine-readable output.
  --help                   Show this help.

Only the package specifier inside [mcp_servers.maxforge].args is changed. Other
MCP settings, environment variables, comments, and credentials are preserved.`;
}

function fail(message) {
  throw new Error(message);
}

function defaultConfigPath() {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

function parseArguments(argv) {
  const options = {
    backupRoot: join(homedir(), ".maxforge", "backups", "codex-config"),
    config: defaultConfigPath(),
    dryRun: false,
    help: false,
    json: false,
    version: undefined,
  };
  const values = new Map([
    ["--backup-root", "backupRoot"],
    ["--config", "config"],
    ["--version", "version"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--dry-run" || argument === "--json") {
      options[argument === "--dry-run" ? "dryRun" : "json"] = true;
      continue;
    }
    const key = values.get(argument);
    if (!key) fail(`unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    options[key] = key === "version" ? value : resolve(value);
    index += 1;
  }
  if (!options.help && (!options.version || !SEMVER.test(options.version))) {
    fail(`--version must be an exact semantic version, received: ${options.version ?? "<missing>"}`);
  }
  return options;
}

function isWithin(parent, child) {
  const fromParent = relative(resolve(parent), resolve(child));
  return fromParent === "" || (!fromParent.startsWith(`..${sep}`) && fromParent !== "..");
}

function findMaxforgeSection(contents) {
  const pattern = /^[ \t]*\[[ \t]*mcp_servers\.(?:maxforge|"maxforge"|'maxforge')[ \t]*][ \t]*(?:#.*)?$/gm;
  const matches = [...contents.matchAll(pattern)];
  if (matches.length === 0) fail("Codex config has no [mcp_servers.maxforge] section");
  if (matches.length > 1) fail("Codex config contains multiple maxforge MCP sections");
  const match = matches[0];
  const start = match.index + match[0].length;
  const nextTable = /^[ \t]*\[/gm;
  nextTable.lastIndex = start;
  const next = nextTable.exec(contents);
  return { start, end: next?.index ?? contents.length };
}

function findTomlAssignment(contents, section, key) {
  const sectionText = contents.slice(section.start, section.end);
  const match = new RegExp(`^[ \\t]*${key}[ \\t]*=`, "m").exec(sectionText);
  if (!match) fail(`maxforge MCP section has no ${key} assignment`);
  let index = section.start + match.index + match[0].length;
  while (/\s/.test(contents[index] ?? "")) index += 1;
  const start = index;
  const isArray = contents[index] === "[";
  let depth = 0;
  let quote = null;
  let escaped = false;
  let comment = false;
  for (; index < section.end; index += 1) {
    const character = contents[index];
    if (comment) {
      if (character === "\n") {
        comment = false;
        if (!isArray) return { start, end: index };
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
      if (depth === 0) return { start, end: index + 1 };
    }
    if (!isArray && character === "\n") return { start, end: index };
  }
  fail(`maxforge MCP ${key} assignment is incomplete`);
}

function maskTomlComments(value) {
  let result = "";
  let quote = null;
  let escaped = false;
  let comment = false;
  for (const character of value) {
    if (comment) {
      if (character === "\n") {
        comment = false;
        result += character;
      } else {
        result += " ";
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
      result += " ";
    } else {
      result += character;
    }
  }
  return result;
}

function rewritePin(contents, version) {
  const section = findMaxforgeSection(contents);
  const assignment = findTomlAssignment(contents, section, "args");
  const args = contents.slice(assignment.start, assignment.end);
  const visibleArgs = maskTomlComments(args);
  const matches = [...visibleArgs.matchAll(/(?:--package=)?maxforge@([^\s"',\]]+)/g)];
  if (matches.length === 0) {
    fail("maxforge MCP args do not contain a maxforge@<version> package specifier");
  }
  if (matches.length > 1) fail("maxforge MCP args contain multiple maxforge package specifiers");
  const match = matches[0];
  const previous = match[1];
  if (previous !== "latest" && !SEMVER.test(previous)) {
    fail(`existing maxforge MCP package specifier is not an exact version: ${previous}`);
  }
  const specifierStart = assignment.start + match.index + match[0].lastIndexOf("@") + 1;
  const specifierEnd = specifierStart + previous.length;
  return {
    changed: previous !== version,
    contents: previous === version
      ? contents
      : `${contents.slice(0, specifierStart)}${version}${contents.slice(specifierEnd)}`,
    previous,
  };
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function writeAtomically(config, contents, mode) {
  const temporary = join(dirname(config), `.config.toml.maxforge-${randomUUID()}`);
  try {
    await writeFile(temporary, contents, { mode: mode & 0o777 });
    await rename(temporary, config);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (isWithin(dirname(options.config), options.backupRoot)) {
    fail("--backup-root must be outside the Codex config directory");
  }
  const metadata = await lstat(options.config);
  if (metadata.isSymbolicLink()) fail("refusing to rewrite a symbolic-link Codex config");
  if (!metadata.isFile()) fail("Codex config path is not a regular file");
  const original = await readFile(options.config, "utf8");
  const rewritten = rewritePin(original, options.version);
  let backup = null;
  if (rewritten.changed && !options.dryRun) {
    await mkdir(options.backupRoot, { recursive: true });
    backup = join(options.backupRoot, `${timestamp()}-${randomUUID()}-config.toml`);
    await copyFile(options.config, backup);
    try {
      await writeAtomically(options.config, rewritten.contents, metadata.mode);
      const verification = rewritePin(await readFile(options.config, "utf8"), options.version);
      if (verification.changed || verification.previous !== options.version) {
        fail("Codex config verification did not find the requested exact pin");
      }
    } catch (error) {
      try {
        await writeAtomically(options.config, original, metadata.mode);
      } catch (rollbackError) {
        fail(
          `Codex config update failed and rollback also failed: ` +
          `${error instanceof Error ? error.message : String(error)}; ` +
          `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
      throw error;
    }
  }
  const result = {
    changed: rewritten.changed,
    dryRun: options.dryRun,
    config: options.config,
    backup,
    previousVersion: rewritten.previous,
    targetVersion: options.version,
    codexRestartRequired: rewritten.changed && !options.dryRun,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `maxforge MCP pin: ${rewritten.previous} -> ${options.version}` +
      `${options.dryRun ? " (dry run)" : rewritten.changed ? "" : " (unchanged)"}\n`
    );
    if (backup) process.stdout.write(`backup: ${backup}\n`);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
