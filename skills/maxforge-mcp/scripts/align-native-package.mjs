#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const REPOSITORY = "bbb-max-externals/maxforge";
const REQUIRED_PACKAGE_PATHS = [
  "package-info.json",
  "externals/maxforge.sync.mxo/Contents/Info.plist",
  "externals/maxforge.sync.mxo/Contents/MacOS/maxforge.sync",
  "externals/maxforge.sync.mxe64",
  "help/maxforge.sync.maxhelp",
  "help/managed_plan.json",
  "docs/maxforge.sync.maxref.xml",
];

function usage() {
  return `Usage:
  node align-native-package.mjs --version X.Y.Z --destination /absolute/path/maxforge
  node align-native-package.mjs --version X.Y.Z --verify-only

Options:
  --version <version>       Exact npm/native version required by the broker.
  --destination <path>      Absolute destination package root named maxforge.
  --backup-root <path>      Backup directory outside Max search paths.
                            Default: ~/.maxforge/backups/native
  --verify-only             Download and validate without installing.
  --archive <path>          Use a local maxforge-vX.Y.Z.zip (requires --checksum).
  --checksum <path>         Use its .sha256 file (requires --archive).
  --help                    Show this help.

The downloader uses only the exact GitHub tag v<version>. It never falls back
to the moving latest release.`;
}

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    archive: undefined,
    backupRoot: join(homedir(), ".maxforge", "backups", "native"),
    checksum: undefined,
    destination: undefined,
    help: false,
    verifyOnly: false,
    version: undefined,
  };
  const valueOptions = new Map([
    ["--archive", "archive"],
    ["--backup-root", "backupRoot"],
    ["--checksum", "checksum"],
    ["--destination", "destination"],
    ["--version", "version"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--verify-only") {
      options.verifyOnly = true;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) fail(`unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function validateVersion(version) {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (!version || !semver.test(version)) {
    fail(`--version must be an exact semantic version, received: ${version ?? "<missing>"}`);
  }
}

function validateDestination(destination) {
  if (!destination) fail("--destination is required unless --verify-only is used");
  if (!isAbsolute(destination)) fail("--destination must be an absolute path");
  if (basename(destination) !== "maxforge") {
    fail("--destination must be the maxforge package root, not its Packages or externals directory");
  }
}

function isWithin(parent, child) {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, description) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(`${description}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    fail(`${description}: ${detail}`);
  }
  return result.stdout;
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { "user-agent": "maxforge-native-package-aligner" },
    redirect: "follow",
  });
  if (!response.ok) {
    fail(
      `failed to download exact release asset (${response.status} ${response.statusText}): ${url}. ` +
      "Do not fall back to the moving latest release."
    );
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function acquireArtifacts(options, workspace) {
  const archiveName = `maxforge-v${options.version}.zip`;
  const archivePath = join(workspace, archiveName);
  const checksumPath = join(workspace, `${archiveName}.sha256`);

  if (Boolean(options.archive) !== Boolean(options.checksum)) {
    fail("--archive and --checksum must be supplied together");
  }
  if (options.archive) {
    await cp(resolve(options.archive), archivePath);
    await cp(resolve(options.checksum), checksumPath);
    return { archiveName, archivePath, checksumPath, source: "local" };
  }

  const tag = `v${options.version}`;
  const releaseBase = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}`;
  await download(`${releaseBase}/${archiveName}`, archivePath);
  await download(`${releaseBase}/${archiveName}.sha256`, checksumPath);
  return { archiveName, archivePath, checksumPath, source: `${REPOSITORY}@${tag}` };
}

async function verifyChecksum(archivePath, checksumPath, archiveName) {
  const checksumText = await readFile(checksumPath, "utf8");
  const checksumLines = checksumText.trim().split(/\r?\n/);
  if (checksumLines.length !== 1) {
    fail(`checksum file must contain exactly one SHA-256 entry for ${archiveName}`);
  }
  const match = checksumLines[0].match(/^([0-9a-fA-F]{64})[ \t*]+(.+)$/);
  if (!match || match[2] !== archiveName) {
    fail(`checksum file must contain exactly one SHA-256 entry for ${archiveName}`);
  }
  const actual = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  const expected = match[1].toLowerCase();
  if (actual !== expected) {
    fail(`archive checksum mismatch: expected ${expected}, received ${actual}`);
  }
  return actual;
}

async function extractArchive(archivePath, extractionRoot) {
  await mkdir(extractionRoot, { recursive: true });
  if (process.platform === "darwin") {
    run("ditto", ["-x", "-k", archivePath, extractionRoot], "failed to extract archive with ditto");
    return;
  }
  if (process.platform === "win32") {
    const escapedArchive = archivePath.replaceAll("'", "''");
    const escapedRoot = extractionRoot.replaceAll("'", "''");
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedRoot}' -Force`],
      "failed to extract archive with PowerShell"
    );
    return;
  }
  run("unzip", ["-q", archivePath, "-d", extractionRoot], "failed to extract archive with unzip");
}

async function validatePackage(packageRoot, expectedVersion) {
  for (const relativePath of REQUIRED_PACKAGE_PATHS) {
    const requiredPath = join(packageRoot, relativePath);
    if (!(await exists(requiredPath))) {
      fail(`release archive is missing required package path: ${relativePath}`);
    }
    const metadata = await lstat(requiredPath);
    if (!metadata.isFile() || metadata.size === 0) {
      fail(`release archive package path must be a non-empty file: ${relativePath}`);
    }
  }

  let packageInfo;
  try {
    packageInfo = JSON.parse(await readFile(join(packageRoot, "package-info.json"), "utf8"));
  } catch (error) {
    fail(`invalid package-info.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (packageInfo.title !== "maxforge") {
    fail(`unexpected Max package title: ${String(packageInfo.title)}`);
  }
  if (packageInfo.version !== expectedVersion) {
    fail(
      `Max package version mismatch: expected ${expectedVersion}, archive contains ${String(packageInfo.version)}`
    );
  }
}

function assertMaxIsClosed() {
  if (process.platform === "darwin") {
    const result = spawnSync("pgrep", ["-x", "Max"], { stdio: "ignore" });
    if (result.status === 0) fail("Max is running. Close Max before replacing the native package.");
    if (result.error && result.error.code !== "ENOENT") fail(`could not check Max process: ${result.error.message}`);
    return;
  }
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "if (Get-Process -Name Max -ErrorAction SilentlyContinue) { exit 23 }"],
      { stdio: "ignore" }
    );
    if (result.status === 23) fail("Max is running. Close Max before replacing the native package.");
    if (result.error || result.status !== 0) fail("could not determine whether Max is running");
    return;
  }
  fail(`native installation is supported only on macOS and Windows, received ${process.platform}`);
}

async function copyPackage(source, destination) {
  if (process.platform === "darwin") {
    run("ditto", [source, destination], "failed to copy Max package with ditto");
    return;
  }
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}

function verifyMacSignature(packageRoot) {
  if (process.platform !== "darwin") return;
  const external = join(packageRoot, "externals", "maxforge.sync.mxo");
  run(
    "codesign",
    ["--verify", "--deep", "--strict", external],
    "macOS external signature verification failed"
  );
  const details = spawnSync("codesign", ["-dv", "--verbose=4", external], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (details.error || details.status !== 0) {
    fail("could not inspect the macOS external signing identity");
  }
  const signingDetails = `${details.stdout}\n${details.stderr}`;
  const authority = signingDetails.match(
    /^Authority=Developer ID Application: ISHII 2BIT PROGRAM OFFICE \(([A-Z0-9]+)\)$/m
  );
  if (!authority) {
    fail("macOS external is not signed by the expected maxforge Developer ID identity");
  }
  if (!signingDetails.includes(`TeamIdentifier=${authority[1]}`)) {
    fail("macOS external TeamIdentifier does not match its Developer ID authority");
  }
  if (!signingDetails.includes("Identifier=jp.2bit.maxforge.sync")) {
    fail("macOS external signing identifier is not jp.2bit.maxforge.sync");
  }
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function installPackage(sourceRoot, options) {
  const destination = resolve(options.destination);
  const destinationParent = dirname(destination);
  const backupRoot = resolve(options.backupRoot);
  if (isWithin(destinationParent, backupRoot)) {
    fail("--backup-root must be outside the destination package directory and its Max search-path parent");
  }

  assertMaxIsClosed();
  await mkdir(destinationParent, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  if (await exists(destination)) {
    const stat = await lstat(destination);
    if (stat.isSymbolicLink()) fail("refusing to replace a symbolic-link destination");
    if (!stat.isDirectory()) fail("destination exists but is not a directory");
  }

  const nonce = randomUUID();
  const staging = join(destinationParent, `.maxforge.install-${nonce}`);
  const previous = join(destinationParent, `.maxforge.previous-${nonce}`);
  const backup = (await exists(destination))
    ? join(backupRoot, `${timestamp()}-${nonce}`, "maxforge")
    : undefined;
  let installedNewPackage = false;
  let movedPreviousPackage = false;

  try {
    await copyPackage(sourceRoot, staging);
    await validatePackage(staging, options.version);
    verifyMacSignature(staging);

    if (backup) {
      await mkdir(dirname(backup), { recursive: true });
      await copyPackage(destination, backup);
      await rename(destination, previous);
      movedPreviousPackage = true;
    }

    try {
      await rename(staging, destination);
      installedNewPackage = true;
      await validatePackage(destination, options.version);
      verifyMacSignature(destination);
      if (movedPreviousPackage) {
        await rm(previous, { recursive: true, force: true });
        movedPreviousPackage = false;
      }
    } catch (error) {
      if (installedNewPackage && await exists(destination)) {
        await rm(destination, { recursive: true, force: true });
        installedNewPackage = false;
      }
      if (movedPreviousPackage && await exists(previous)) {
        await rename(previous, destination);
        movedPreviousPackage = false;
      }
      throw error;
    }

    return { backup: backup ?? null, destination };
  } finally {
    if (await exists(staging)) await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  validateVersion(options.version);
  if (!options.verifyOnly) validateDestination(options.destination);

  const workspace = await mkdtemp(join(tmpdir(), "maxforge-native-"));
  try {
    const artifacts = await acquireArtifacts(options, workspace);
    const sha256 = await verifyChecksum(
      artifacts.archivePath,
      artifacts.checksumPath,
      artifacts.archiveName
    );
    const extractionRoot = join(workspace, "extracted");
    await extractArchive(artifacts.archivePath, extractionRoot);
    const packageRoot = join(extractionRoot, "maxforge");
    await validatePackage(packageRoot, options.version);

    if (options.verifyOnly) {
      process.stdout.write(`${JSON.stringify({
        installed: false,
        source: artifacts.source,
        version: options.version,
        sha256,
        verified: true,
      }, null, 2)}\n`);
      return;
    }

    const result = await installPackage(packageRoot, options);
    process.stdout.write(`${JSON.stringify({
      installed: true,
      source: artifacts.source,
      version: options.version,
      sha256,
      ...result,
      next: "Start Max, reopen the controller patch, then require versionCompatible: true.",
    }, null, 2)}\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  process.stderr.write(`maxforge native alignment failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
