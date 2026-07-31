import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import dbData from "../data/objects.json" with { type: "json" };
import { compile } from "../src/core/compiler.js";
import { ObjectDatabase } from "../src/core/types.js";
import { parse } from "../src/dsl/parser.js";

const database = dbData as ObjectDatabase;

describe("MCP Max bridge example", () => {
  it("compiles to one self-contained maxforge.sync controller", () => {
    const source = readFileSync(
      new URL(
        "../examples/mcp_bridge/maxforge_mcp_bridge.maxdsl",
        import.meta.url
      ),
      "utf8"
    );
    const parsed = parse(source);
    const result = compile(parsed.ast, database);

    expect(parsed.errors).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);

    const boxes = result.output!.patcher.boxes.map(({ box }) => box);
    expect(boxes).toHaveLength(1);
    expect(result.output!.patcher.lines).toEqual([]);
    expect(boxes[0]).toMatchObject({
      text: "maxforge.sync",
      numinlets: 1,
      numoutlets: 1,
      host: "127.0.0.1",
      port: 8766,
      scope: "agent_demo",
      patcher_id: "maxforge_bridge",
      controller: 1,
    });
  });
});
