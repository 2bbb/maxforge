import {
  CompileError,
  CompileWarning,
  ErrorCode,
  PortRef,
  WarningCode,
} from "./types.js";
import { CompiledBox, CompiledLine } from "./compiled-model.js";

export interface ConnectionPairResult {
  line?: CompiledLine;
  errors: CompileError[];
  warning?: CompileWarning;
}

export function compileConnectionPair(
  src: PortRef,
  dst: PortRef,
  sourceLine: number,
  nameMap: Map<string, CompiledBox>,
  existingLines: CompiledLine[]
): ConnectionPairResult {
  const srcBox = nameMap.get(src.name);
  const dstBox = nameMap.get(dst.name);

  if (!srcBox) {
    return {
      errors: [{
        code: ErrorCode.UNDEFINED_REF,
        message: `Undefined reference: "${src.name}"`,
        line: sourceLine,
      }],
    };
  }
  if (!dstBox) {
    return {
      errors: [{
        code: ErrorCode.UNDEFINED_REF,
        message: `Undefined reference: "${dst.name}"`,
        line: sourceLine,
      }],
    };
  }

  const outletIdx = src.outlet ?? 0;
  const inletIdx = dst.inlet ?? dst.outlet ?? 0;

  if (outletIdx >= srcBox.numoutlets) {
    return {
      errors: [{
        code: ErrorCode.OUTLET_OUT_OF_RANGE,
        message: `Outlet index out of range: ${src.name}[${outletIdx}] has ${srcBox.numoutlets} outlets`,
        line: sourceLine,
      }],
    };
  }
  if (inletIdx >= dstBox.numinlets) {
    return {
      errors: [{
        code: ErrorCode.INLET_OUT_OF_RANGE,
        message: `Inlet index out of range: ${dst.name}[${inletIdx}] has ${dstBox.numinlets} inlets`,
        line: sourceLine,
      }],
    };
  }

  const line: CompiledLine = {
    sourceId: srcBox.id,
    sourceOutlet: outletIdx,
    destId: dstBox.id,
    destInlet: inletIdx,
  };

  if (existingLines.some((existing) => sameCompiledLine(existing, line))) {
    return {
      errors: [],
      warning: {
        code: WarningCode.DUPLICATE_CONNECTION,
        message: `Duplicate connection: ${src.name}[${outletIdx}] -> ${dst.name}[${inletIdx}]`,
        line: sourceLine,
      },
    };
  }

  return { errors: [], line };
}

function sameCompiledLine(a: CompiledLine, b: CompiledLine): boolean {
  return (
    a.sourceId === b.sourceId &&
    a.sourceOutlet === b.sourceOutlet &&
    a.destId === b.destId &&
    a.destInlet === b.destInlet
  );
}
