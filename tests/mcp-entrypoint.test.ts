import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bridgeOptionsFromEnvironment,
  catalogOptionsFromEnvironment,
} from "../src/mcp/server.js";
import { stateFileFromEnvironment } from "../src/mcp/state-store.js";

describe("maxforge MCP environment", () => {
  it("keeps the unauthenticated default on loopback", () => {
    expect(bridgeOptionsFromEnvironment({})).toMatchObject({
      host: "127.0.0.1",
      port: 8766,
      token: undefined,
    });
  });

  it("publishes to the LAN when a token is configured", () => {
    expect(bridgeOptionsFromEnvironment({
      MAXFORGE_WS_TOKEN: "studio-session_1",
    })).toMatchObject({
      host: "0.0.0.0",
      port: 8766,
      token: "studio-session_1",
    });
  });

  it("respects an explicit authenticated bind address", () => {
    expect(bridgeOptionsFromEnvironment({
      MAXFORGE_WS_HOST: "192.168.1.20",
      MAXFORGE_WS_PORT: "9000",
      MAXFORGE_WS_TOKEN: "studio-session_1",
    })).toMatchObject({
      host: "192.168.1.20",
      port: 9000,
      token: "studio-session_1",
    });
  });

  it("loads MCP catalogs only from the explicit environment path", () => {
    expect(catalogOptionsFromEnvironment({})).toEqual({
      configPath: undefined,
      discover: false,
    });
    expect(catalogOptionsFromEnvironment({
      MAXFORGE_CONFIG: "/project/maxforge.config.json",
    })).toEqual({
      configPath: "/project/maxforge.config.json",
      discover: false,
    });
  });

  it("uses project-scoped state when identified and per-port fallback otherwise", () => {
    expect(stateFileFromEnvironment({}, 8766)).toMatch(
      /\.maxforge\/mcp-state-8766-v1\.json$/
    );
    expect(stateFileFromEnvironment({ MAXFORGE_STATE_FILE: "off" }, 8766))
      .toBeUndefined();
    expect(stateFileFromEnvironment({}, 8766, "studio_patchset")).toMatch(
      /\.maxforge\/projects\/studio_patchset\/mcp-state-v1\.json$/
    );
  });
});

describe("maxforge MCP executable", () => {
  it("responds to initialize when Node receives the npm bin symlink as argv[1]", async () => {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const packageJson = JSON.parse(
      readFileSync(join(repository, "package.json"), "utf8")
    ) as { bin?: Record<string, string> };
    const entrypoint = packageJson.bin?.["maxforge-mcp"];
    expect(entrypoint).toBeTypeOf("string");

    const directory = mkdtempSync(join(tmpdir(), "maxforge-mcp-bin-"));
    const symlink = join(directory, basename(entrypoint!));
    symlinkSync(resolve(repository, entrypoint!), symlink);

    try {
      const response = await initializeThroughSymlink(repository, symlink);
      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          serverInfo: { name: "maxforge" },
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});

function initializeThroughSymlink(
  repository: string,
  symlink: string
): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, reject) => {
    const child = spawn(process.execPath, [symlink], {
      cwd: repository,
      env: {
        ...process.env,
        MAXFORGE_WS_PORT: "0",
        MAXFORGE_STATE_FILE: "off",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (
      error: Error | undefined,
      response?: Record<string, unknown>
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolveResponse(response!);
    };

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id === 1) {
            finish(undefined, message);
            return;
          }
        } catch {
          // Wait for a complete newline-delimited JSON-RPC message.
        }
      }
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(
          `maxforge-mcp exited before initialize response ` +
          `(code=${String(code)}, signal=${String(signal)}, stderr=${stderr.trim()})`
        ));
      }
    });

    const timeout = setTimeout(() => {
      finish(new Error(
        `maxforge-mcp timed out before initialize response; stderr=${stderr.trim()}`
      ));
    }, 5_000);

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "maxforge-regression-test", version: "1.0.0" },
      },
    }) + "\n");
  });
}
