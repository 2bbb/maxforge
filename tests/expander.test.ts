import { describe, it, expect } from "vitest";
import { parse, compile } from "../src/index.js";
import { ObjectDatabase } from "../src/core/types.js";
import dbData from "../data/objects.json" with { type: "json" };

const db = dbData as ObjectDatabase;

// ---------------------------------------------------------------------------
// Control-flow / expression expansion tests
// ---------------------------------------------------------------------------
describe("control-flow expansion", () => {
  it("expands for loops with interpolated names, arguments, positions, and connections", () => {
    const source = `
for i in 0..3 {
  osc_\${i} = cycle~ \${440 + i * 10} at(\${50 + i * 100}, 80)
  gain_\${i} = *~ 0.25 at(\${50 + i * 100}, 140)
  osc_\${i} -> gain_\${i}
}
dac = ezdac~
gain_0 -> dac
gain_1 -> dac
gain_2 -> dac
gain_3 -> dac
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.statements.filter((s) => s.type === "object_def")).toHaveLength(9);
    expect(ast.statements.filter((s) => s.type === "connection")).toHaveLength(8);

    const result = compile(ast, db);
    expect(result.success).toBe(true);
    expect(result.output!.patcher.boxes).toHaveLength(9);
    expect(
      result.output!.patcher.boxes.some((b) => b.box.text === "cycle~ 470")
    ).toBe(true);
    const osc3 = result.output!.patcher.boxes.find(
      (b) => b.box.text === "cycle~ 470"
    )!.box;
    expect(osc3.patching_rect[0]).toBe(350);
    expect(osc3.patching_rect[1]).toBe(80);
  });

  it("expands if blocks using loop variables and comparison expressions", () => {
    const source = `
for i in 0..3 {
  if i < 2 {
    n_\${i} = number
  }
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.statements).toHaveLength(2);
    expect((ast.statements[0] as any).name).toBe("n_0");
    expect((ast.statements[1] as any).name).toBe("n_1");
  });

  it("supports arithmetic in attribute values", () => {
    const source = `
for i in 1..2 {
  s_\${i} = slider @size \${10 * i} \${40 + i * 10}
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    const result = compile(ast, db);
    expect(result.success).toBe(true);
    expect((result.output!.patcher.boxes[0].box as any).size).toEqual([10, 50]);
    expect((result.output!.patcher.boxes[1].box as any).size).toEqual([20, 60]);
  });

  it("reports expression errors instead of emitting broken DSL", () => {
    const { errors } = parse("n_${missing} = number");
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("E007");
  });

  it("reports unclosed control blocks", () => {
    const { errors } = parse(`
for i in 0..3 {
  n_\${i} = number
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("E007");
  });
});
