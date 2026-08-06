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

  it("uses a persistent per-port state file unless explicitly disabled", () => {
    expect(stateFileFromEnvironment({}, 8766)).toMatch(
      /\.maxforge\/mcp-state-8766-v1\.json$/
    );
    expect(stateFileFromEnvironment({ MAXFORGE_STATE_FILE: "off" }, 8766))
      .toBeUndefined();
  });
});
