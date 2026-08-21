#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = await mkdtemp(join(tmpdir(), "maxforge-npm-package-"));

try {
  const packageJson = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(join(repository, "package-lock.json"), "utf8"));
  assertEqual(packageLock.packages?.[""]?.version, packageJson.version, "package-lock version");
  assertEqual(packageLock.packages?.[""]?.bin, packageJson.bin, "package-lock bins");

  const packDirectory = join(temporaryRoot, "pack");
  await mkdir(packDirectory);
  await writeFile(join(temporaryRoot, "package.json"), JSON.stringify({ private: true }));
  const { stdout: packOutput } = await execFileAsync("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    packDirectory,
  ], { cwd: repository });
  const packResult = JSON.parse(packOutput)[0];
  if (!packResult?.filename) throw new Error("npm pack did not report an archive");

  const packedFiles = new Set(packResult.files.map(({ path }) => path));
  for (const path of Object.values(packageJson.bin)) {
    if (!packedFiles.has(path)) throw new Error(`npm package is missing bin target: ${path}`);
  }
  for (const path of [
    "skills/maxforge/SKILL.md",
    "skills/maxforge/agents/openai.yaml",
    "skills/maxforge-mcp/SKILL.md",
    "skills/maxforge-mcp/agents/openai.yaml",
    "skills/maxforge-mcp/references/native-version-alignment.md",
    "skills/maxforge-mcp/scripts/align-native-package.mjs",
  ]) {
    if (!packedFiles.has(path)) throw new Error(`npm package is missing skill artifact: ${path}`);
  }

  const archive = join(packDirectory, packResult.filename);
  await execFileAsync("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    archive,
  ], { cwd: temporaryRoot });

  const binDirectory = join(temporaryRoot, "node_modules", ".bin");
  const installedBins = Object.fromEntries(
    Object.keys(packageJson.bin).map((name) => [
      name,
      installedBin(binDirectory, name),
    ])
  );
  for (const executable of Object.values(installedBins)) {
    await assertExecutable(executable);
  }
  const cli = installedBins.maxforge;
  const mcp = installedBins["maxforge-mcp"];
  const broker = installedBins["maxforge-broker"];

  const dslPath = join(temporaryRoot, "smoke.maxdsl");
  await writeFile(dslPath, [
    'patch "Package smoke" | "Installed CLI" | 320x240',
    "btn = button",
    "out = print maxforge_package_smoke",
    "btn -> out",
    "",
  ].join("\n"));
  const validation = await execFileAsync(cli, ["validate", dslPath], {
    cwd: temporaryRoot,
  });
  if (validation.stdout.trim() !== "Validation passed." || validation.stderr) {
    throw new Error(`installed CLI validation failed: ${validation.stderr || validation.stdout}`);
  }

  await verifyMcpPackageExport(packageJson.version);
  const environment = await mcpEnvironment(temporaryRoot);
  const brokerProcess = await startBroker(broker, cli, environment, packageJson.version);
  try {
    await initializeMcp(mcp, environment, packageJson.version);
  } finally {
    let stopError;
    try {
      await stopBroker(cli, environment);
    } catch (error) {
      stopError = error;
      brokerProcess.kill("SIGTERM");
    }
    await waitForCleanExit(brokerProcess);
    if (stopError) throw stopError;
  }

  console.log(`Verified installed maxforge npm package ${packageJson.version}.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function installedBin(directory, name) {
  return join(directory, process.platform === "win32" ? `${name}.cmd` : name);
}

async function assertExecutable(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`npm bin is not a file: ${path}`);
  if (process.platform !== "win32" && (metadata.mode & 0o111) === 0) {
    throw new Error(`npm bin is not executable: ${path}`);
  }
}

function assertEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} does not match package.json`);
  }
}

async function mcpEnvironment(root) {
  const configPath = join(root, "maxforge.config.json");
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    project: { id: `npm_package_smoke_${process.pid}` },
  }));
  return {
    ...process.env,
    MAXFORGE_CONFIG: configPath,
    MAXFORGE_BROKER_PORT: String(await freePort()),
    MAXFORGE_WS_PORT: String(await freePort()),
    MAXFORGE_BROKER_IDLE_MS: "100",
    MAXFORGE_BROKER_START_TIMEOUT_MS: "5000",
    MAXFORGE_BROKER_DIR: join(root, "broker"),
    MAXFORGE_EDIT_HISTORY_DIR: join(root, "history"),
    MAXFORGE_STATE_FILE: join(root, "state.json"),
  };
}

async function verifyMcpPackageExport(expectedVersion) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      'const module = await import("maxforge/mcp");',
      'const required = ["MaxforgeWebSocketBridge", "MaxforgePatchService", "brokerDescriptorFromEnvironment"];',
      'const missing = required.filter((name) => typeof module[name] !== "function");',
      'if (missing.length) throw new Error(`missing exports: ${missing.join(", ")}`);',
      `process.stdout.write(${JSON.stringify(expectedVersion)});`,
    ].join("\n"),
  ], { cwd: temporaryRoot });
  if (stdout !== expectedVersion || stderr) {
    throw new Error(`installed maxforge/mcp export smoke failed: ${stderr || stdout}`);
  }
}

function initializeMcp(executable, environment, expectedVersion) {
  return new Promise((resolveInitialize, reject) => {
    const child = spawn(executable, [], {
      cwd: temporaryRoot,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let response;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(
      `installed maxforge-mcp timed out; stderr=${stderr.trim()}`
    )), 10_000);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
      if (error) reject(error);
      else resolveInitialize();
    };

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            response = message;
            child.stdin.end();
          }
        } catch {
          finish(new Error(`installed maxforge-mcp polluted stdout: ${line}`));
        }
      }
    });
    child.once("error", finish);
    child.once("exit", (code, signal) => {
      if (!response) {
        finish(new Error(
          `installed maxforge-mcp exited before initialize ` +
          `(code=${String(code)}, signal=${String(signal)}, stderr=${stderr.trim()})`
        ));
        return;
      }
      const serverInfo = response.result?.serverInfo;
      if (
        response.jsonrpc !== "2.0" ||
        response.result?.protocolVersion !== "2025-06-18" ||
        serverInfo?.name !== "maxforge" ||
        serverInfo?.version !== expectedVersion
      ) {
        finish(new Error(`invalid MCP initialize response: ${JSON.stringify(response)}`));
        return;
      }
      if (code !== 0) {
        finish(new Error(`installed maxforge-mcp exited with code ${String(code)}`));
        return;
      }
      finish();
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "maxforge-package-smoke", version: "1.0.0" },
      },
    })}\n`);
  });
}

async function startBroker(executable, cli, environment, expectedVersion) {
  const child = spawn(executable, [], {
    cwd: temporaryRoot,
    env: { ...environment, MAXFORGE_BROKER_IDLE_MS: "10000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) {
      throw new Error(
        `installed maxforge-broker exited during startup ` +
        `(code=${child.exitCode}, stdout=${stdout.trim()}, stderr=${stderr.trim()})`
      );
    }
    try {
      const { stdout: statusOutput, stderr: statusError } = await execFileAsync(
        cli,
        ["broker", "status", "--config", environment.MAXFORGE_CONFIG],
        { cwd: temporaryRoot, env: environment }
      );
      if (statusError) throw new Error(statusError);
      const status = JSON.parse(statusOutput);
      if (status.state === "ready") {
        if (status.brokerVersion !== expectedVersion) {
          child.kill("SIGTERM");
          throw new Error(
            `installed maxforge-broker version ${String(status.brokerVersion)} ` +
            `does not match package ${expectedVersion}`
          );
        }
        return child;
      }
    } catch (error) {
      const code = error?.code;
      if (code !== "ECONNREFUSED" && !String(error).includes("ECONNREFUSED")) {
        if (!String(error).includes("socket hang up")) {
          child.kill("SIGTERM");
          throw error;
        }
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  child.kill("SIGTERM");
  throw new Error(
    `installed maxforge-broker timed out; stdout=${stdout.trim()}, stderr=${stderr.trim()}`
  );
}

async function waitForCleanExit(child) {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) {
      throw new Error(`installed maxforge-broker exited with code ${child.exitCode}`);
    }
    return;
  }
  await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("installed maxforge-broker did not stop"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(
        `installed maxforge-broker exited unexpectedly ` +
        `(code=${String(code)}, signal=${String(signal)})`
      ));
    });
  });
}

async function stopBroker(cli, environment) {
  try {
    await execFileAsync(cli, ["broker", "stop", "--config", environment.MAXFORGE_CONFIG], {
      cwd: temporaryRoot,
      env: environment,
    });
  } catch (error) {
    if (!String(error?.stderr ?? error).includes("ECONNREFUSED")) throw error;
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a localhost test port");
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}
