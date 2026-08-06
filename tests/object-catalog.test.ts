import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import catalogJson from "../data/objects.json" with { type: "json" };
import { lookupObject } from "../src/core/object-db.js";
import { ObjectDatabase, ObjectDef } from "../src/core/types.js";

const catalog = catalogJson as ObjectDatabase;
const catalogPath = path.join(__dirname, "..", "data", "objects.json");

function shape(text: string): Pick<ObjectDef, "numinlets" | "numoutlets" | "outlettype"> {
  const result = lookupObject(text, catalog);
  expect(result, `catalog lookup failed for ${text}`).not.toBeNull();
  return {
    numinlets: result!.def.numinlets,
    numoutlets: result!.def.numoutlets,
    outlettype: result!.def.outlettype,
  };
}

describe("object catalog integrity", () => {
  it("contains 321 unique top-level entries", () => {
    const raw = fs.readFileSync(catalogPath, "utf8");
    const serializedTopLevelKeys = [...raw.matchAll(/^  "(?:[^"\\]|\\.)+": \{/gm)];
    expect(serializedTopLevelKeys).toHaveLength(321);
    expect(Object.keys(catalog)).toHaveLength(321);
  });

  it("contains no fabricated port classes or removed unsupported names", () => {
    for (const name of [
      "inlet~",
      "outlet~",
      "function~",
      "freeverb~",
      "OSC-route",
      "jit.camera",
      "jit.syphonin",
      "jit.syphonout",
      "live.arrow",
      "selector",
      "mstosamps",
      "bbb.agent.hub",
    ]) {
      expect(catalog).not.toHaveProperty(name);
    }
    expect(catalog).toHaveProperty("inlet");
    expect(catalog).toHaveProperty("outlet");
    expect(catalog).toHaveProperty("function");
    expect(catalog).toHaveProperty("live.arrows");
    expect(catalog).toHaveProperty("selector~");
    expect(catalog).toHaveProperty("mstosamps~");
  });

  it("keeps outlet metadata structurally consistent", () => {
    for (const [name, definition] of Object.entries(catalog)) {
      expect(definition.outlettype, name).toHaveLength(definition.numoutlets);
      expect(definition.numinlets, name).toBeGreaterThanOrEqual(0);
      expect(definition.numoutlets, name).toBeGreaterThanOrEqual(0);
      expect(Boolean(definition.dynamicPorts && definition.argRule), name).toBe(false);
      expect(definition, name).not.toHaveProperty("argDependent");
    }
  });

  it("matches representative Max 9 saved-patcher shapes", () => {
    expect(shape("number")).toEqual({
      numinlets: 1,
      numoutlets: 2,
      outlettype: ["", "bang"],
    });
    expect(shape("loadbang")).toEqual({
      numinlets: 1,
      numoutlets: 1,
      outlettype: ["bang"],
    });
    expect(shape("counter")).toEqual({
      numinlets: 5,
      numoutlets: 4,
      outlettype: ["int", "", "", "int"],
    });
    expect(shape("dict")).toEqual({
      numinlets: 2,
      numoutlets: 5,
      outlettype: ["dictionary", "", "", "", ""],
    });
    expect(shape("jit.matrix")).toEqual({
      numinlets: 1,
      numoutlets: 2,
      outlettype: ["jit_matrix", ""],
    });
    expect(shape("node.script demo.js")).toEqual({
      numinlets: 1,
      numoutlets: 2,
      outlettype: ["", ""],
    });
  });
});

describe("argument-dependent Max port resolution", () => {
  const cases: Array<[
    string,
    number,
    number,
    string[]
  ]> = [
    ["gate 4", 2, 4, ["", "", "", ""]],
    ["gate~ 3", 2, 3, ["signal", "signal", "signal"]],
    ["selector~ 4", 5, 1, ["signal"]],
    ["switch 4", 5, 1, [""]],
    ["route one two", 3, 3, ["", "", ""]],
    ['route "Control Border" "Text / Icon" "Slider Range Value"', 4, 4, ["", "", "", ""]],
    ["routepass one two", 3, 3, ["", "", ""]],
    ["funnel 4", 4, 1, ["list"]],
    ["spray 4", 1, 4, ["", "", "", ""]],
    ["pack 0 0. symbol", 3, 1, [""]],
    ["pak 0 0. symbol", 3, 1, [""]],
    ["unpack i f s", 1, 3, ["int", "float", ""]],
    ["bucket 4", 1, 4, ["", "", "", ""]],
    ["expr in1 + in4", 4, 1, [""]],
    ["expr sqrt(2.5 * 5 / samplerate)", 1, 1, [""]],
    ["vexpr $f1 + $f3", 3, 1, [""]],
    ["sel 1 2", 3, 3, ["bang", "bang", ""]],
    ['sel "Band Pass" "Band Reject"', 3, 3, ["bang", "bang", ""]],
    ["trigger b f i l", 1, 4, ["bang", "float", "int", ""]],
    ["t b i", 1, 2, ["bang", "int"]],
    ["trigger this that 2 1.5 b", 1, 5, ["this", "that", "int", "float", "bang"]],
    ["bondo 4", 4, 4, ["", "", "", ""]],
    ["b 3", 1, 3, ["bang", "bang", "bang"]],
    ["jit.pack 3", 3, 2, ["jit_matrix", ""]],
    ["jit.unpack 3", 1, 4, ["jit_matrix", "jit_matrix", "jit_matrix", ""]],
    ["matrix~ 4 2", 4, 3, ["signal", "signal", ""]],
    ["sfrecord~ 4", 4, 1, ["signal"]],
    ["adc~ 1 3 4", 1, 3, ["signal", "signal", "signal"]],
    ["dac~ 1 3 4", 3, 0, []],
    ["sfplay~ 2", 2, 3, ["signal", "signal", "bang"]],
    ["sfplay~ 2 60000 1", 2, 4, ["signal", "signal", "signal", "bang"]],
    ["play~ audio 2", 1, 3, ["signal", "signal", "bang"]],
    ["record~ audio 2", 4, 1, ["signal"]],
    ["groove~ audio 2", 3, 3, ["signal", "signal", "signal"]],
    ["delay 44100 4", 5, 4, ["", "", "", ""]],
    ["pipe 0 0 1000", 3, 2, ["", ""]],
    ["sprintf %d-%s", 2, 1, [""]],
    ["tapout~ 100 200", 2, 2, ["signal", "signal"]],
    ["print left right", 2, 0, []],
    ["+ 5", 2, 1, ["int"]],
    ["+ 5.7", 2, 1, ["float"]],
    ["- 5", 2, 1, ["int"]],
    ["* 5", 2, 1, ["int"]],
    ["/ 5", 2, 1, ["int"]],
    ["accum 0.", 3, 1, ["float"]],
    ["split 1. 10.", 3, 2, ["float", "float"]],
    ["swap 5", 2, 2, ["int", "int"]],
    ["jit.movie @output_texture 1", 1, 2, ["jit_gl_texture", ""]],
    ["if $i3 then out2 bang", 3, 2, ["", ""]],
    ["receive named", 0, 1, [""]],
    ["receive", 1, 1, [""]],
    ["r named", 0, 1, [""]],
  ];

  it("covers every argument-dependent catalog entry", () => {
    const covered = new Set(cases.map(([text]) => text.split(/\s/, 1)[0]));
    const argumentDependent = new Set(
      Object.entries(catalog)
        .filter(([, definition]) => definition.argRule)
        .map(([name]) => name)
    );
    expect(covered).toEqual(argumentDependent);
  });

  for (const [text, numinlets, numoutlets, outlettype] of cases) {
    it(`resolves ${text}`, () => {
      expect(shape(text)).toEqual({ numinlets, numoutlets, outlettype });
    });
  }
});
