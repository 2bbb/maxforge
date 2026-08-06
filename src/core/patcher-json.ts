import {
  ASTNode,
  BoxJSON,
  BoxWrapper,
  LineWrapper,
  PatcherJSON,
} from "./types.js";
import { applyBoxAttrs } from "./attributes.js";
import { CompiledBox, CompiledLine } from "./compiled-model.js";

export function buildPatcherJSON(
  patchDecl: ASTNode["patchDecl"],
  boxes: CompiledBox[],
  lines: CompiledLine[]
): PatcherJSON {
  const boxWrappers: BoxWrapper[] = boxes.map((b) => {
    const box: BoxJSON = {
      id: b.id,
      maxclass: b.maxclass,
      numinlets: b.numinlets,
      numoutlets: b.numoutlets,
      patching_rect: [b.x, b.y, b.defaultSize[0], b.defaultSize[1]],
    };

    if (b.outlettype.length > 0) {
      box.outlettype = b.outlettype;
    }

    const isUINative =
      b.maxclass !== "newobj" &&
      b.maxclass !== "comment" &&
      b.maxclass !== "message" &&
      b.maxclass !== "inlet" &&
      b.maxclass !== "outlet";

    if (b.text !== undefined && !isUINative) {
      box.text = b.text;
    }
    if (b.comment !== undefined) {
      box.comment = b.comment;
    }
    if (b.patcher) {
      box.patcher = b.patcher;
    }

    applyBoxAttrs(box, b.attrs);

    return { box };
  });

  const lineWrappers: LineWrapper[] = lines.map((l) => ({
    patchline: {
      source: [l.sourceId, l.sourceOutlet],
      destination: [l.destId, l.destInlet],
    },
  }));

  return {
    patcher: {
      fileversion: 1,
      appversion: {
        major: 9,
        minor: 0,
        revision: 0,
        architecture: "x64",
        modernui: 1,
      },
      classnamespace: "box",
      rect: [100.0, 100.0, patchDecl?.size?.[0] ?? 640, patchDecl?.size?.[1] ?? 480],
      bglocked: 0,
      openrect: [0.0, 0.0, 0.0, 0.0],
      openinpresentation: 0,
      default_fontsize: 12.0,
      default_fontface: 0,
      default_fontname: "Arial",
      gridonopen: 2,
      gridsize: [15.0, 15.0],
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
      devicewidth: 0.0,
      ...(patchDecl ? { title: patchDecl.name } : {}),
      description: patchDecl?.description ?? "",
      digest: "",
      tags: "",
      style: "",
      subpatcher_template: "",
      assistshowspatchername: 0,
      boxes: boxWrappers,
      lines: lineWrappers,
    },
  };
}
