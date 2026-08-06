import { describe, expect, it } from "vitest";
import {
  compileDslToThispatcherCommands,
  formatThispatcherCommand,
  patcherToThispatcherCommands,
} from "../src/index.js";
import { ObjectDatabase } from "../src/core/types.js";
import dbData from "../data/objects.json" with { type: "json" };

const db = dbData as ObjectDatabase;

describe("thispatcher command generation", () => {
  it("emits newobject and connect messages for a flat patcher", () => {
    const result = compileDslToThispatcherCommands(
      `
osc = cycle~ 440 at(10, 20)
dac = ezdac~ at(100, 20)
osc -> dac
`,
      db
    );

    expect(result.success).toBe(true);
    expect(result.commands).toEqual([
      {
        targetPath: [],
        message: [
          "script",
          "newobject",
          "newobj",
          "@varname",
          "maxforge_obj_osc",
          "@patching_position",
          10,
          20,
          "@patching_size",
          80,
          22,
          "@text",
          "cycle~",
          440,
        ],
      },
      {
        targetPath: [],
        message: [
          "script",
          "newobject",
          "ezdac~",
          "@varname",
          "maxforge_obj_dac",
          "@patching_position",
          100,
          20,
          "@patching_size",
          52,
          36,
        ],
      },
      {
        targetPath: [],
        message: [
          "script",
          "connect",
          "maxforge_obj_osc",
          0,
          "maxforge_obj_dac",
          0,
        ],
      },
    ]);
  });

  it("can wrap a root patcher as a subpatcher command stream", () => {
    const result = compileDslToThispatcherCommands(
      `
in = inlet signal at(10, 20)
out = outlet signal at(100, 20)
in -> out
`,
      db,
      false,
      { asSubpatcher: "Generated", subpatcherPosition: [300, 120] }
    );

    expect(result.success).toBe(true);
    expect(result.commands?.[0]).toEqual({
      targetPath: [],
      message: [
        "script",
        "newobject",
        "newobj",
        "@varname",
        "maxforge_Generated",
        "@patching_position",
        300,
        120,
        "@text",
        "p",
        "Generated",
      ],
    });
    expect(result.commands?.slice(1).every((c) => c.targetPath.join("/") === "maxforge_Generated")).toBe(true);
  });

  it("emits nested subpatcher commands with a target path", () => {
    const result = compileDslToThispatcherCommands(
      `
fx = p passthrough at(40, 50) {
  in = inlet signal at(10, 20)
  out = outlet signal at(100, 20)
  in -> out
}
`,
      db
    );

    expect(result.success).toBe(true);
    const nested = result.commands?.filter((c) => c.targetPath.length > 0) ?? [];
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.every((c) => c.targetPath[0] === "maxforge_obj_fx")).toBe(true);
  });

  it("formats target paths for logs or text output", () => {
    const [command] = patcherToThispatcherCommands(
      {
        patcher: {
          fileversion: 1,
          appversion: { major: 9, minor: 0, revision: 0, architecture: "x64", modernui: 1 },
          classnamespace: "box",
          rect: [0, 0, 100, 100],
          bglocked: 0,
          openrect: [0, 0, 0, 0],
          openinpresentation: 0,
          default_fontsize: 12,
          default_fontface: 0,
          default_fontname: "Arial",
          gridonopen: 2,
          gridsize: [15, 15],
          gridsnaponopen: 0,
          objectsnaponopen: 1,
          statusbarvisible: 2,
          toolbarvisible: 2,
          lefttoolbarpinned: 0,
          toptoolbarpinned: 0,
          righttoolbarpinned: 0,
          bottomtoolbarpinned: 0,
          toolbars_unpinned_last_save: 0,
          tallnewobj: 0,
          boxanimatetime: 200,
          enablehscroll: 1,
          enablevscroll: 1,
          devicewidth: 0,
          description: "",
          digest: "",
          tags: "",
          style: "",
          subpatcher_template: "",
          assistshowspatchername: 0,
          boxes: [
            { box: { id: "obj-1", maxclass: "newobj", numinlets: 1, numoutlets: 1, patching_rect: [1, 2, 80, 22], text: "print hello world" } },
          ],
          lines: [],
        },
      },
      { varPrefix: "mf_" }
    );

    expect(formatThispatcherCommand(command)).toBe(
      "script newobject newobj @varname mf_obj_1 @patching_position 1 2 @patching_size 80 22 @text print hello world"
    );
  });
});
