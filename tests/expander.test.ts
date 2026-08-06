import { describe, it, expect } from "vitest";
import { parse, compile } from "../src/index.js";
import { ObjectDatabase } from "../src/core/types.js";
import { expandControlFlow } from "../src/dsl/expander.js";
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

  it("expands else blocks and logical expressions", () => {
    const source = `
for i in 0..3 {
  if i % 2 == 0 && !(i == 2) {
    even_\${i} = number
  }
  else {
    other_\${i} = button
  }
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(
      ast.statements.map((statement) =>
        statement.type === "object_def" ? statement.name : statement.type
      )
    ).toEqual(["even_0", "other_1", "other_2", "other_3"]);
  });

  it("accepts an else block on the same line as the closing brace", () => {
    const { ast, errors } = parse(`
if 0 {
  no = number
} else {
  yes = button
}
`);
    expect(errors).toHaveLength(0);
    expect(ast.statements).toHaveLength(1);
    expect(ast.statements[0]).toMatchObject({ type: "object_def", name: "yes" });
  });

  it("applies logical precedence before disjunction", () => {
    const { ast, errors } = parse(`
if 0 || 1 && 1 {
  result = number
}
`);
    expect(errors).toHaveLength(0);
    expect(ast.statements).toHaveLength(1);
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

  it("rejects non-finite arithmetic", () => {
    const { errors } = parse("n = number @value ${1 / 0}");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("finite number");
  });

  it("bounds individual loop iteration counts", () => {
    const result = expandControlFlow(
      "for i in 0..3 {\n  n_${i} = number\n}",
      { maxLoopIterations: 3 }
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("exceeds 3 iterations");
  });

  it("bounds total expanded source lines across nested loops", () => {
    const result = expandControlFlow(
      "for i in 0..2 {\n  for j in 0..2 {\n    n_${i}_${j} = number\n  }\n}",
      { maxExpandedLines: 8 }
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("exceeds 8 lines");
  });

  it("rejects loop steps that move away from the end", () => {
    const { errors } = parse("for i in 0..3 step -1 {\n  n_${i} = number\n}");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("does not advance");
  });

  it("rejects orphan else blocks", () => {
    const { errors } = parse("else {\n  n = number\n}");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("must immediately follow");
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
