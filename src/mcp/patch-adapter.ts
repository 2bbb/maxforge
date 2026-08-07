import type { CompileWarning } from "../core/types.js";
import type { PatchBox, PatchGraph } from "../max/patch-graph.js";
import type { MaxforgeSnapshotBox } from "../max/patch-protocol.js";

export interface PatchGraphAdapter {
  compile(
    source: string,
    scope: string
  ): { graph: PatchGraph; warnings: readonly CompileWarning[] };
  resolveLiveBox(
    snapshot: MaxforgeSnapshotBox,
    base: PatchBox,
    baseline?: MaxforgeSnapshotBox
  ): PatchBox;
}
