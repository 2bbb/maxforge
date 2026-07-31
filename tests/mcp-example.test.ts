import { describe, expect, it } from "vitest";
import dbData from "../data/objects.json" with { type: "json" };
import { compile } from "../src/core/compiler.js";
import { ObjectDatabase } from "../src/core/types.js";
import { parse } from "../src/dsl/parser.js";

const database = dbData as ObjectDatabase;

describe("MCP Max transport objects", () => {
  it("compiles the native bridge with exact hub and sync outlet counts", () => {
    const source = `
hub = bbb.agent.hub
route_data = route data
apply = prepend apply
sync = maxforge.sync
hub[1] -> route_data -> apply -> sync
`;
    const parsed = parse(source);
    const result = compile(parsed.ast, database);

    expect(parsed.errors).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);

    const boxes = result.output!.patcher.boxes.map(({ box }) => box);
    expect(boxes.find((box) => box.text === "bbb.agent.hub")).toMatchObject({
      numinlets: 1,
      numoutlets: 2,
    });
    expect(boxes.find((box) => box.text === "maxforge.sync")).toMatchObject({
      numinlets: 1,
      numoutlets: 1,
    });
    expect(result.output!.patcher.lines[0].patchline.source).toEqual([
      "obj-hub",
      1,
    ]);
  });
});
