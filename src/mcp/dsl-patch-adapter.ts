import { lookupObject } from "../core/object-db.js";
import type { CompileWarning, ObjectDatabase } from "../core/types.js";
import { compileDslToPatchGraph } from "../max/dsl-patch-graph.js";
import type { PatchBox, PatchGraph } from "../max/patch-graph.js";
import type { MaxforgeSnapshotBox } from "../max/patch-protocol.js";
import { resolveSnapshotAttributes } from "../max/patch-snapshot.js";
import type { PatchGraphAdapter } from "./patch-adapter.js";

export class DslPatchAdapter implements PatchGraphAdapter {
  constructor(private database: ObjectDatabase) {}

  replaceDatabase(database: ObjectDatabase): void {
    this.database = database;
  }

  compile(
    source: string,
    scope: string
  ): { graph: PatchGraph; warnings: readonly CompileWarning[] } {
    const result = compileDslToPatchGraph(source, this.database, scope);
    if (!result.success || !result.graph) {
      const diagnostics = result.errors.map((error) => {
        const location = error.line ? `Line ${error.line}: ` : "";
        return `${location}[${error.code}] ${error.message}`;
      });
      throw new Error(diagnostics.join("\n") || "DSL compilation failed");
    }
    return {
      graph: result.graph,
      warnings: result.warnings,
    };
  }

  resolveLiveBox(
    snapshot: MaxforgeSnapshotBox,
    base: PatchBox,
    baseline?: MaxforgeSnapshotBox
  ): PatchBox {
    const objectText = base.maxclass === "newobj"
      ? snapshot.text
      : snapshot.maxclass;
    const resolved = !base.patcher && objectText
      ? lookupObject(objectText, this.database, true)
      : null;
    return {
      ...base,
      varName: snapshot.varName,
      maxclass: resolved?.maxclass ?? base.maxclass,
      numinlets: resolved?.def.numinlets ?? base.numinlets,
      numoutlets: resolved?.def.numoutlets ?? base.numoutlets,
      outlettype: resolved?.def.outlettype ?? base.outlettype,
      patchingRect: snapshot.patchingRect,
      text: snapshot.text,
      comment: snapshot.comment,
      attributes: resolveSnapshotAttributes(snapshot, base, baseline),
    };
  }
}
