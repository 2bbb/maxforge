import { describe, it, expect } from "vitest";
import { parse, compile } from "../src/index.js";
import { ObjectDatabase } from "../src/core/types.js";
import dbData from "../data/objects.json" with { type: "json" };

const db = dbData as unknown as ObjectDatabase;

describe("block parsing regressions", () => {
  it("does not consume statements after a nested subpatcher block", () => {
    const source = `
outer = p outer_patch {
  i = inlet
  o = outlet
  inner = p inner_patch {
    ii = inlet
    oo = outlet
    ii -> oo
  }
  i -> inner -> o
}
after = number
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.statements).toHaveLength(2);
    expect(ast.statements[0].type).toBe("subpatcher_def");
    expect(ast.statements[1].type).toBe("object_def");
    if (ast.statements[1].type === "object_def") {
      expect(ast.statements[1].name).toBe("after");
    }
  });

  it("expands for blocks inside a subpatcher before compiling inlet/outlet counts", () => {
    const source = `
fx = p generated {
  for i in 0..1 {
    in_\${i} = inlet
    out_\${i} = outlet
    in_\${i} -> out_\${i}
  }
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    const box = result.output!.patcher.boxes[0].box;
    expect(box.numinlets).toBe(2);
    expect(box.numoutlets).toBe(2);
  });

  it("reports an unclosed outer subpatcher when an inner block closes first", () => {
    const source = `
outer = p outer_patch {
  inner = p inner_patch {
    i = inlet
    o = outlet
    i -> o
  }
`;
    const { errors } = parse(source);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.code === "E007")).toBe(true);
  });

  it("reports unexpected top-level closing braces", () => {
    const { errors } = parse("}");
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("E007");
  });
});
