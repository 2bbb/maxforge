import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import dbData from "../data/objects.json" with { type: "json" };
import { compile } from "../src/core/compiler.js";
import { serialize } from "../src/core/serializer.js";
import { ObjectDatabase, PatcherJSON } from "../src/core/types.js";
import { parse } from "../src/dsl/parser.js";
import { compileDslToPatchGraph } from "../src/max/dsl-patch-graph.js";
import {
  createEmptyPatchGraph,
  diffPatchGraphs,
} from "../src/max/patch-graph.js";

const database = dbData as unknown as ObjectDatabase;

const generatedPairs = [
  ["examples/basic_synth.maxdsl", "examples/basic_synth.maxpat"],
  ["examples/max_node_script/generated_patch.maxdsl", "examples/max_node_script/generated_patch.maxpat"],
  ["examples/max_node_script/maxforge_node_script_demo.maxdsl", "examples/max_node_script/maxforge_node_script_demo.maxpat"],
  ["examples/max_sync/maxforge_sync_demo.maxdsl", "examples/max_sync/maxforge_sync_demo.maxpat"],
  ["examples/mcp_bridge/maxforge_mcp_bridge.maxdsl", "examples/mcp_bridge/maxforge_mcp_bridge.maxpat"],
] as const;

describe("checked-in generated Max artifacts", () => {
  for (const [dslPath, patchPath] of generatedPairs) {
    it(`${patchPath} matches its DSL source`, () => {
      const source = readFileSync(new URL(`../${dslPath}`, import.meta.url), "utf8");
      const parsed = parse(source);
      const result = compile(parsed.ast, database);

      expect(parsed.errors).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
      const checkedSource = readFileSync(
        new URL(`../${patchPath}`, import.meta.url),
        "utf8"
      );
      expect(checkedSource).toBe(serialize(result.output!));
      validatePatcher(JSON.parse(checkedSource) as PatcherJSON, patchPath);
    });
  }

  it("keeps the shipped native sync plan aligned with its DSL source", () => {
    const source = readFileSync(
      new URL("../examples/max_sync/managed_patch.maxdsl", import.meta.url),
      "utf8"
    );
    const compiled = compileDslToPatchGraph(source, database, "sync_demo");
    expect(compiled.errors).toEqual([]);
    expect(compiled.graph).toBeDefined();
    const expected = diffPatchGraphs(
      createEmptyPatchGraph("sync_demo"),
      compiled.graph!
    );
    const shipped = JSON.parse(readFileSync(
      new URL("../help/managed_plan.json", import.meta.url),
      "utf8"
    ));
    expect(shipped).toEqual(JSON.parse(JSON.stringify(expected)));
  });

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

function validatePatcher(document: PatcherJSON, source: string): void {
  validatePatcherBody(document.patcher, source);
}

function validatePatcherBody(
  patcher: PatcherJSON["patcher"],
  source: string
): void {
  const boxes = patcher.boxes.map(({ box }) => box);
  const byId = new Map(boxes.map((box) => [box.id, box]));
  expect(byId.size, `${source}: duplicate box id`).toBe(boxes.length);

  for (const box of boxes) {
    expect(box.numinlets, `${source}:${box.id} numinlets`).toBeGreaterThanOrEqual(0);
    expect(box.numoutlets, `${source}:${box.id} numoutlets`).toBeGreaterThanOrEqual(0);
    if (box.numoutlets > 0) {
      expect(box.outlettype, `${source}:${box.id} outlettype`).toHaveLength(
        box.numoutlets
      );
    } else if (box.outlettype !== undefined) {
      expect(box.outlettype, `${source}:${box.id} outlettype`).toHaveLength(0);
    }
    if (box.patcher) validatePatcherBody(box.patcher, `${source}:${box.id}`);
  }

  for (const { patchline } of patcher.lines) {
    const sourceBox = byId.get(patchline.source[0]);
    const destinationBox = byId.get(patchline.destination[0]);
    expect(sourceBox, `${source}: missing source ${patchline.source[0]}`).toBeDefined();
    expect(destinationBox, `${source}: missing destination ${patchline.destination[0]}`)
      .toBeDefined();
    expect(Number.isInteger(patchline.source[1])).toBe(true);
    expect(Number.isInteger(patchline.destination[1])).toBe(true);
    expect(patchline.source[1]).toBeGreaterThanOrEqual(0);
    expect(patchline.source[1]).toBeLessThan(sourceBox!.numoutlets);
    expect(patchline.destination[1]).toBeGreaterThanOrEqual(0);
    expect(patchline.destination[1]).toBeLessThan(destinationBox!.numinlets);
  }
}
