import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import dbData from "../data/objects.json" with { type: "json" };
import { compile } from "../src/core/compiler.js";
import { serialize } from "../src/core/serializer.js";
import { ObjectDatabase } from "../src/core/types.js";
import { parse } from "../src/dsl/parser.js";

const database = dbData as ObjectDatabase;

const generatedPairs = [
  ["examples/basic_synth.maxdsl", "examples/basic_synth.maxpat", false],
  ["examples/max_node_script/generated_patch.maxdsl", "examples/max_node_script/generated_patch.maxpat", false],
  ["examples/max_node_script/maxforge_node_script_demo.maxdsl", "examples/max_node_script/maxforge_node_script_demo.maxpat", false],
  ["examples/max_sync/maxforge_sync_demo.maxdsl", "examples/max_sync/maxforge_sync_demo.maxpat", false],
  ["examples/mcp_bridge/maxforge_mcp_bridge.maxdsl", "examples/mcp_bridge/maxforge_mcp_bridge.maxpat", false],
] as const;

describe("checked-in generated Max artifacts", () => {
  for (const [dslPath, patchPath, allowUnknown] of generatedPairs) {
    it(`${patchPath} matches its DSL source`, () => {
      const source = readFileSync(new URL(`../${dslPath}`, import.meta.url), "utf8");
      const parsed = parse(source);
      const result = compile(parsed.ast, database, allowUnknown);

      expect(parsed.errors).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
      expect(readFileSync(new URL(`../${patchPath}`, import.meta.url), "utf8"))
        .toBe(serialize(result.output!));
    });
  }

  it("ships the current sync example as the Max help patch", () => {
    const example = readFileSync(
      new URL("../examples/max_sync/maxforge_sync_demo.maxpat", import.meta.url),
      "utf8"
    );
    const help = readFileSync(
      new URL("../help/maxforge.sync.maxhelp", import.meta.url),
      "utf8"
    );
    expect(help).toBe(example);
  });
});
