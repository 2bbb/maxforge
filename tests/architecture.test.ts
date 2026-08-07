import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

describe("module boundaries", () => {
  it("keeps the canonical patch graph independent from DSL and MCP", () => {
    const graph = source("src/max/patch-graph.ts");
    expect(graph).not.toMatch(/from "\.\.\/dsl\//);
    expect(graph).not.toMatch(/from "\.\.\/mcp\//);
    expect(graph).not.toContain("../core/compiler.js");
  });

  it("keeps reconciliation and persistence independent from the WebSocket bridge", () => {
    expect(source("src/mcp/reconcile.ts")).not.toContain("./bridge.js");
    expect(source("src/mcp/state-store.ts")).not.toContain("./bridge.js");
  });

  it("keeps services and MCP tools independent from the concrete DSL adapter", () => {
    expect(source("src/mcp/service.ts")).not.toContain("./dsl-patch-adapter.js");
    expect(source("src/mcp/mcp-server.ts")).not.toContain(
      "./dsl-patch-adapter.js"
    );
  });

  it("does not re-export patch-domain internals from the MCP entry point", () => {
    const mcpIndex = source("src/mcp/index.ts");
    expect(mcpIndex).not.toContain("../max/");
    expect(mcpIndex).not.toContain("./dsl-patch-adapter.js");
  });
});
