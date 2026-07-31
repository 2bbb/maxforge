import {
  CompileWarning,
  ObjectDatabase,
} from "../core/types.js";
import {
  compileDslToPatchGraph,
  createEmptyPatchGraph,
  diffPatchGraphs,
  PatchGraph,
  PatchPlan,
} from "../max/patch-graph.js";
import {
  MaxforgeAppliedEvent,
  PatchPlanTransport,
} from "./bridge.js";

export interface CompilePlanRequest {
  readonly desiredDsl: string;
  readonly scope: string;
  readonly currentDsl?: string;
}

export interface CompilePlanResult {
  readonly plan: PatchPlan;
  readonly desiredGraph: PatchGraph;
  readonly warnings: readonly CompileWarning[];
}

export interface ApplyDslResult {
  readonly plan: PatchPlan;
  readonly acknowledgement: MaxforgeAppliedEvent;
  readonly warnings: readonly CompileWarning[];
}

export class MaxforgePatchService {
  private readonly managedGraphs = new Map<string, PatchGraph>();

  constructor(
    private readonly database: ObjectDatabase,
    private readonly transport: PatchPlanTransport
  ) {}

  compilePlan(request: CompilePlanRequest): CompilePlanResult {
    const desired = this.compileGraph(request.desiredDsl, request.scope);
    const current = request.currentDsl === undefined
      ? { graph: createEmptyPatchGraph(request.scope), warnings: [] }
      : this.compileGraph(request.currentDsl, request.scope);
    return {
      plan: diffPatchGraphs(current.graph, desired.graph),
      desiredGraph: desired.graph,
      warnings: [...current.warnings, ...desired.warnings],
    };
  }

  async applyDsl(request: CompilePlanRequest): Promise<ApplyDslResult> {
    const desired = this.compileGraph(request.desiredDsl, request.scope);
    const current = this.resolveCurrentGraph(request);
    this.assertLiveRevision(request.scope, current.graph);

    const plan = diffPatchGraphs(current.graph, desired.graph);
    const acknowledgement = await this.transport.apply(plan);
    this.managedGraphs.set(request.scope, desired.graph);

    return {
      plan,
      acknowledgement,
      warnings: [...current.warnings, ...desired.warnings],
    };
  }

  getManagedRevisions(): Readonly<Record<string, string>> {
    return Object.fromEntries(
      [...this.managedGraphs.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([scope, graph]) => [scope, graph.revision])
    );
  }

  private resolveCurrentGraph(request: CompilePlanRequest): {
    graph: PatchGraph;
    warnings: readonly CompileWarning[];
  } {
    if (request.currentDsl !== undefined) {
      return this.compileGraph(request.currentDsl, request.scope);
    }

    const managed = this.managedGraphs.get(request.scope);
    if (managed) return { graph: managed, warnings: [] };

    const liveRevision = this.transport.getLiveRevision(request.scope);
    if (typeof liveRevision === "string") {
      throw new Error(
        `Max scope "${request.scope}" is already initialized at revision ` +
        `${liveRevision}, but this MCP process has no graph state. Provide ` +
        "currentDsl once to seed the diff."
      );
    }

    return {
      graph: createEmptyPatchGraph(request.scope),
      warnings: [],
    };
  }

  private assertLiveRevision(scope: string, current: PatchGraph): void {
    const liveRevision = this.transport.getLiveRevision(scope);
    if (liveRevision === undefined) return;

    const expectedRevision = liveRevision ?? createEmptyPatchGraph(scope).revision;
    if (current.revision !== expectedRevision) {
      throw new Error(
        `Current DSL revision ${current.revision} does not match Max scope ` +
        `"${scope}" revision ${liveRevision ?? "uninitialized"}`
      );
    }
  }

  private compileGraph(
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
}
