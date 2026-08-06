import { createHash } from "node:crypto";
import { compile } from "../core/compiler.js";
import {
  ASTNode,
  BoxJSON,
  CompileError,
  CompileWarning,
  ErrorCode,
  ObjectDatabase,
  PatcherJSON,
} from "../core/types.js";
import { parse } from "../dsl/parser.js";

export type PatchValue =
  | string
  | number
  | boolean
  | null
  | readonly PatchValue[]
  | { readonly [key: string]: PatchValue };

export type PatchSetValue =
  | string
  | number
  | readonly (string | number)[];

export interface PatchEndpoint {
  readonly id: string;
  readonly varName: string;
  readonly port: number;
}

export interface PatchConnection {
  readonly source: PatchEndpoint;
  readonly destination: PatchEndpoint;
}

export interface PatchBox {
  readonly id: string;
  readonly varName: string;
  readonly maxclass: string;
  readonly numinlets: number;
  readonly numoutlets: number;
  readonly outlettype: readonly string[];
  readonly patchingRect: readonly [number, number, number, number];
  readonly text?: string;
  readonly comment?: string;
  readonly attributes: Readonly<Record<string, PatchValue>>;
  readonly patcher?: PatchGraphNode;
}

export interface PatchGraphNode {
  readonly boxes: readonly PatchBox[];
  readonly connections: readonly PatchConnection[];
}

export interface PatchGraph {
  readonly protocolVersion: 1;
  readonly scope: string;
  readonly revision: string;
  readonly patcher: PatchGraphNode;
}

export interface PatchGraphCompileResult {
  success: boolean;
  errors: CompileError[];
  warnings: CompileWarning[];
  graph?: PatchGraph;
}

export type PatchOperation =
  | {
      readonly op: "disconnect";
      readonly targetPath: readonly string[];
      readonly source: PatchEndpoint;
      readonly destination: PatchEndpoint;
    }
  | {
      readonly op: "delete";
      readonly targetPath: readonly string[];
      readonly id: string;
      readonly varName: string;
    }
  | {
      readonly op: "create";
      readonly targetPath: readonly string[];
      readonly box: Omit<PatchBox, "patcher">;
    }
  | {
      readonly op: "set";
      readonly targetPath: readonly string[];
      readonly id: string;
      readonly varName: string;
      readonly attribute: string;
      readonly value: PatchSetValue;
    }
  | {
      readonly op: "connect";
      readonly targetPath: readonly string[];
      readonly source: PatchEndpoint;
      readonly destination: PatchEndpoint;
    };

export interface PatchPlan {
  readonly protocolVersion: 1;
  readonly scope: string;
  readonly baseRevision: string;
  readonly targetRevision: string;
  readonly baseStructureToken?: string;
  readonly operations: readonly PatchOperation[];
  readonly rollbackOperations?: readonly PatchOperation[];
}

const BOX_KEYS = new Set([
  "id",
  "maxclass",
  "numinlets",
  "numoutlets",
  "outlettype",
  "patching_rect",
  "text",
  "comment",
  "patcher",
  "varname",
]);

interface FlatBox {
  targetPath: readonly string[];
  box: PatchBox;
}

interface FlatConnection {
  targetPath: readonly string[];
  connection: PatchConnection;
}

interface FlatGraph {
  boxes: FlatBox[];
  connections: FlatConnection[];
}

export function compileDslToPatchGraph(
  source: string,
  database: ObjectDatabase,
  scope: string,
  allowUnknown = false
): PatchGraphCompileResult {
  const scopeError = validateScope(scope);
  if (scopeError) {
    return { success: false, errors: [scopeError], warnings: [] };
  }

  const { ast, errors: parseErrors } = parse(source);
  if (parseErrors.length > 0) {
    return { success: false, errors: parseErrors, warnings: [] };
  }

  const varNameError = findReservedVarName(ast);
  if (varNameError) {
    return { success: false, errors: [varNameError], warnings: [] };
  }

  const result = compile(ast, database, allowUnknown);
  if (!result.success) {
    return {
      success: false,
      errors: result.errors,
      warnings: result.warnings,
    };
  }

  return {
    success: true,
    errors: [],
    warnings: result.warnings,
    graph: compiledPatcherToPatchGraph(result.output!, scope),
  };
}

/**
 * Convert a live or saved Max patcher snapshot into managed state.
 * Only boxes whose existing varname belongs to the requested scope are included.
 */
export function patcherToPatchGraph(
  patcher: PatcherJSON | PatcherJSON["patcher"],
  scope: string
): PatchGraph {
  const scopeError = validateScope(scope);
  if (scopeError) throw new Error(scopeError.message);

  const root = "patcher" in patcher ? patcher.patcher : patcher;
  const graphNode = snapshotPatcherNodeToGraph(root, scope);
  return createPatchGraph(scope, graphNode);
}

export function createEmptyPatchGraph(scope: string): PatchGraph {
  return createPatchGraph(scope, { boxes: [], connections: [] });
}

export function createPatchGraph(
  scope: string,
  patcher: PatchGraphNode
): PatchGraph {
  const scopeError = validateScope(scope);
  if (scopeError) throw new Error(scopeError.message);

  const immutablePatcher = cloneAndFreezePatcher(patcher);
  return Object.freeze({
    protocolVersion: 1,
    scope,
    revision: calculateRevision(scope, immutablePatcher),
    patcher: immutablePatcher,
  });
}

export function diffPatchGraphs(current: PatchGraph, desired: PatchGraph): PatchPlan {
  return diffPatchGraphsInternal(current, desired, true);
}

function diffPatchGraphsInternal(
  current: PatchGraph,
  desired: PatchGraph,
  includeRollback: boolean
): PatchPlan {
  assertProtocolVersion(current);
  assertProtocolVersion(desired);
  if (current.scope !== desired.scope) {
    throw new Error(
      `Cannot diff patch graphs with different scopes: "${current.scope}" and "${desired.scope}"`
    );
  }

  const scope = desired.scope;
  const currentFlat = flattenGraph(current.patcher, scope);
  const desiredFlat = flattenGraph(desired.patcher, scope);
  const currentBoxes = new Map(currentFlat.boxes.map((entry) => [boxKey(entry), entry]));
  const desiredBoxes = new Map(desiredFlat.boxes.map((entry) => [boxKey(entry), entry]));
  const replacedKeys = new Set<string>();

  for (const [key, currentEntry] of currentBoxes) {
    const desiredEntry = desiredBoxes.get(key);
    if (desiredEntry && requiresBoxReplacement(currentEntry.box, desiredEntry.box)) {
      replacedKeys.add(key);
    }
  }

  const allBoxes = [...currentFlat.boxes, ...desiredFlat.boxes];
  expandReplacedDescendants(replacedKeys, allBoxes);
  const replacedPaths = new Set(
    allBoxes
      .filter((entry) => replacedKeys.has(boxKey(entry)))
      .map((entry) => pathKey([...entry.targetPath, entry.box.varName]))
  );

  const disconnects: PatchOperation[] = [];
  const deletes: PatchOperation[] = [];
  const creates: PatchOperation[] = [];
  const sets: PatchOperation[] = [];
  const connects: PatchOperation[] = [];

  const currentConnections = new Map(
    currentFlat.connections.map((entry) => [connectionKey(entry), entry])
  );
  const desiredConnections = new Map(
    desiredFlat.connections.map((entry) => [connectionKey(entry), entry])
  );

  for (const [key, entry] of currentConnections) {
    if (
      !desiredConnections.has(key) ||
      connectionTouchesReplacement(entry, replacedKeys, replacedPaths)
    ) {
      disconnects.push({
        op: "disconnect",
        targetPath: entry.targetPath,
        source: entry.connection.source,
        destination: entry.connection.destination,
      });
    }
  }

  const currentEntries = [...currentBoxes.entries()].sort(
    ([, left], [, right]) => right.targetPath.length - left.targetPath.length
  );
  for (const [key, entry] of currentEntries) {
    if (!desiredBoxes.has(key) || replacedKeys.has(key)) {
      deletes.push({
        op: "delete",
        targetPath: entry.targetPath,
        id: entry.box.id,
        varName: entry.box.varName,
      });
    }
  }

  const desiredEntries = [...desiredBoxes.entries()].sort(
    ([, left], [, right]) => left.targetPath.length - right.targetPath.length
  );
  for (const [key, entry] of desiredEntries) {
    const currentEntry = currentBoxes.get(key);
    if (!currentEntry || replacedKeys.has(key)) {
      const { patcher: _patcher, ...box } = entry.box;
      creates.push({
        op: "create",
        targetPath: entry.targetPath,
        box,
      });
      continue;
    }

    if (!sameRect(currentEntry.box.patchingRect, entry.box.patchingRect)) {
      sets.push({
        op: "set",
        targetPath: entry.targetPath,
        id: entry.box.id,
        varName: entry.box.varName,
        attribute: "patching_rect",
        value: entry.box.patchingRect,
      });
    }
    if (
      entry.box.maxclass !== "newobj" &&
      entry.box.text !== undefined &&
      currentEntry.box.text !== entry.box.text
    ) {
      sets.push({
        op: "set",
        targetPath: entry.targetPath,
        id: entry.box.id,
        varName: entry.box.varName,
        attribute: "text",
        value: entry.box.text,
      });
    }
    if (
      entry.box.comment !== undefined &&
      currentEntry.box.comment !== entry.box.comment
    ) {
      sets.push({
        op: "set",
        targetPath: entry.targetPath,
        id: entry.box.id,
        varName: entry.box.varName,
        attribute: "comment",
        value: entry.box.comment,
      });
    }
    for (const [attribute, value] of Object.entries(entry.box.attributes)) {
      if (stableStringify(currentEntry.box.attributes[attribute]) === stableStringify(value)) {
        continue;
      }
      // Unsupported structured values are classified as replacement changes by
      // requiresBoxReplacement(), so no partial set operation can escape here.
      if (!isSettablePatchValue(value)) continue;
      sets.push({
        op: "set",
        targetPath: entry.targetPath,
        id: entry.box.id,
        varName: entry.box.varName,
        attribute,
        value,
      });
    }
  }

  for (const [key, entry] of desiredConnections) {
    if (
      !currentConnections.has(key) ||
      connectionTouchesReplacement(entry, replacedKeys, replacedPaths)
    ) {
      connects.push({
        op: "connect",
        targetPath: entry.targetPath,
        source: entry.connection.source,
        destination: entry.connection.destination,
      });
    }
  }

  const operations = [...disconnects, ...deletes, ...creates, ...sets, ...connects];
  return {
    protocolVersion: 1,
    scope,
    baseRevision: current.revision,
    targetRevision: desired.revision,
    operations,
    ...(includeRollback
      ? {
          rollbackOperations: diffPatchGraphsInternal(
            desired,
            current,
            false
          ).operations,
        }
      : {}),
  };
}

export function managedVarName(scope: string, id: string): string {
  const match = id.match(/^obj-(\w+)$/);
  if (!match) {
    throw new Error(`Invalid managed box id: "${id}"`);
  }
  return `maxforge_${scope}_obj_${match[1]}`;
}

function compiledPatcherToPatchGraph(
  patcher: PatcherJSON | PatcherJSON["patcher"],
  scope: string
): PatchGraph {
  const root = "patcher" in patcher ? patcher.patcher : patcher;
  const graphNode = compiledPatcherNodeToGraph(root, scope);
  return createPatchGraph(scope, graphNode);
}

function compiledPatcherNodeToGraph(
  patcher: PatcherJSON["patcher"],
  scope: string
): PatchGraphNode {
  const boxes = patcher.boxes.map(({ box }) => compiledBoxToPatchBox(box, scope));
  const boxById = new Map(boxes.map((box) => [box.id, box]));
  const connections: PatchConnection[] = [];

  for (const { patchline } of patcher.lines) {
    const source = boxById.get(patchline.source[0]);
    const destination = boxById.get(patchline.destination[0]);
    if (!source || !destination) continue;

    connections.push({
      source: {
        id: source.id,
        varName: source.varName,
        port: patchline.source[1],
      },
      destination: {
        id: destination.id,
        varName: destination.varName,
        port: patchline.destination[1],
      },
    });
  }

  return { boxes, connections };
}

function compiledBoxToPatchBox(box: BoxJSON, scope: string): PatchBox {
  return boxToPatchBox(
    box,
    box.id,
    managedVarName(scope, box.id),
    box.patcher ? compiledPatcherNodeToGraph(box.patcher, scope) : undefined
  );
}

function snapshotPatcherNodeToGraph(
  patcher: PatcherJSON["patcher"],
  scope: string
): PatchGraphNode {
  const runtimeIdToBox = new Map<string, PatchBox>();
  const boxes: PatchBox[] = [];

  for (const { box } of patcher.boxes) {
    const id = managedIdFromVarName(scope, box.varname);
    if (!id || !box.varname) continue;

    const managedBox = boxToPatchBox(
      box,
      id,
      box.varname,
      box.patcher ? snapshotPatcherNodeToGraph(box.patcher, scope) : undefined
    );
    boxes.push(managedBox);
    runtimeIdToBox.set(box.id, managedBox);
  }

  const connections: PatchConnection[] = [];
  for (const { patchline } of patcher.lines) {
    const source = runtimeIdToBox.get(patchline.source[0]);
    const destination = runtimeIdToBox.get(patchline.destination[0]);
    if (!source || !destination) continue;

    connections.push({
      source: {
        id: source.id,
        varName: source.varName,
        port: patchline.source[1],
      },
      destination: {
        id: destination.id,
        varName: destination.varName,
        port: patchline.destination[1],
      },
    });
  }

  return { boxes, connections };
}

function boxToPatchBox(
  box: BoxJSON,
  id: string,
  varName: string,
  patcher: PatchGraphNode | undefined
): PatchBox {
  const attributes: Record<string, PatchValue> = {};
  for (const [key, value] of Object.entries(box)) {
    if (BOX_KEYS.has(key) || value === undefined) continue;
    attributes[key] = toPatchValue(value);
  }

  return {
    id,
    varName,
    maxclass: box.maxclass,
    numinlets: box.numinlets,
    numoutlets: box.numoutlets,
    outlettype: box.outlettype ?? [],
    patchingRect: box.patching_rect,
    text: box.text,
    comment: box.comment,
    attributes,
    patcher,
  };
}

function flattenGraph(
  patcher: PatchGraphNode,
  scope: string,
  targetPath: readonly string[] = []
): FlatGraph {
  const boxes: FlatBox[] = [];
  const connections: FlatConnection[] = [];

  for (const box of patcher.boxes) {
    if (!isManagedBox(box, scope)) continue;
    boxes.push({ targetPath, box });
    if (box.patcher) {
      const child = flattenGraph(box.patcher, scope, [...targetPath, box.varName]);
      boxes.push(...child.boxes);
      connections.push(...child.connections);
    }
  }

  const managedIds = new Set(boxes
    .filter((entry) => samePath(entry.targetPath, targetPath))
    .map((entry) => entry.box.id));
  for (const connection of patcher.connections) {
    if (
      managedIds.has(connection.source.id) &&
      managedIds.has(connection.destination.id)
    ) {
      connections.push({ targetPath, connection });
    }
  }

  return { boxes, connections };
}

function expandReplacedDescendants(
  replacedKeys: Set<string>,
  boxes: FlatBox[]
): void {
  let changed = true;
  while (changed) {
    changed = false;
    const replacedPaths = boxes
      .filter((entry) => replacedKeys.has(boxKey(entry)))
      .map((entry) => pathKey([...entry.targetPath, entry.box.varName]));

    for (const entry of boxes) {
      const targetPath = pathKey(entry.targetPath);
      if (
        replacedPaths.some(
          (path) => targetPath === path || targetPath.startsWith(`${path}/`)
        ) &&
        !replacedKeys.has(boxKey(entry))
      ) {
        replacedKeys.add(boxKey(entry));
        changed = true;
      }
    }
  }
}

function connectionTouchesReplacement(
  entry: FlatConnection,
  replacedKeys: Set<string>,
  replacedPaths: Set<string>
): boolean {
  const sourceKey = boxKey({
    targetPath: entry.targetPath,
    box: { id: entry.connection.source.id } as PatchBox,
  });
  const destinationKey = boxKey({
    targetPath: entry.targetPath,
    box: { id: entry.connection.destination.id } as PatchBox,
  });
  if (replacedKeys.has(sourceKey) || replacedKeys.has(destinationKey)) return true;

  const targetPath = pathKey(entry.targetPath);
  for (const replacedPath of replacedPaths) {
    if (
      targetPath === replacedPath ||
      targetPath.startsWith(`${replacedPath}/`)
    ) {
      return true;
    }
  }
  return false;
}

function requiresBoxReplacement(left: PatchBox, right: PatchBox): boolean {
  if (stableStringify({
    maxclass: left.maxclass,
    numinlets: left.numinlets,
    numoutlets: left.numoutlets,
    outlettype: left.outlettype,
  }) !== stableStringify({
    maxclass: right.maxclass,
    numinlets: right.numinlets,
    numoutlets: right.numoutlets,
    outlettype: right.outlettype,
  })) return true;
  if (left.maxclass === "newobj" && left.text !== right.text) return true;
  if (left.text !== undefined && right.text === undefined) return true;
  if (left.comment !== undefined && right.comment === undefined) return true;
  const attributeNames = new Set([
    ...Object.keys(left.attributes),
    ...Object.keys(right.attributes),
  ]);
  for (const attribute of attributeNames) {
    const leftValue = left.attributes[attribute];
    const rightValue = right.attributes[attribute];
    if (stableStringify(leftValue) === stableStringify(rightValue)) continue;
    if (!(attribute in right.attributes) || !isSettablePatchValue(rightValue)) {
      return true;
    }
  }
  return false;
}

function isSettablePatchValue(value: PatchValue): value is PatchSetValue {
  if (typeof value === "string" || typeof value === "number") return true;
  return Array.isArray(value) && value.length > 0 && value.length <= 256 && value.every(
    (item) => typeof item === "string" || typeof item === "number"
  );
}

function sameRect(
  left: readonly [number, number, number, number],
  right: readonly [number, number, number, number]
): boolean {
  return left.every((value, index) => value === right[index]);
}

function boxKey(entry: FlatBox): string {
  return `${pathKey(entry.targetPath)}::${entry.box.id}`;
}

function connectionKey(entry: FlatConnection): string {
  const { source, destination } = entry.connection;
  return `${pathKey(entry.targetPath)}::${source.id}:${source.port}->${destination.id}:${destination.port}`;
}

function pathKey(path: readonly string[]): string {
  return path.join("/");
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isManagedBox(box: PatchBox, scope: string): boolean {
  return managedIdFromVarName(scope, box.varName) === box.id;
}

export function managedIdFromVarName(
  scope: string,
  varName: string | undefined
): string | null {
  if (!varName) return null;
  const prefix = `maxforge_${scope}_obj_`;
  if (!varName.startsWith(prefix)) return null;

  const name = varName.substring(prefix.length);
  return /^\w+$/.test(name) ? `obj-${name}` : null;
}

function calculateRevision(scope: string, patcher: PatchGraphNode): string {
  return createHash("sha256")
    .update(stableStringify({ scope, patcher: canonicalPatcher(patcher) }))
    .digest("hex");
}

function cloneAndFreezePatcher(patcher: PatchGraphNode): PatchGraphNode {
  const boxes = patcher.boxes.map((box) => Object.freeze({
    ...box,
    outlettype: Object.freeze([...box.outlettype]),
    patchingRect: Object.freeze([...box.patchingRect]) as unknown as
      readonly [number, number, number, number],
    attributes: Object.freeze(clonePatchRecord(box.attributes)),
    patcher: box.patcher ? cloneAndFreezePatcher(box.patcher) : undefined,
  }));
  const connections = patcher.connections.map((connection) => Object.freeze({
    source: Object.freeze({ ...connection.source }),
    destination: Object.freeze({ ...connection.destination }),
  }));
  return Object.freeze({
    boxes: Object.freeze(boxes),
    connections: Object.freeze(connections),
  });
}

function clonePatchRecord(
  value: Readonly<Record<string, PatchValue>>
): Record<string, PatchValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, clonePatchValue(child)])
  );
}

function clonePatchValue(value: PatchValue): PatchValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(clonePatchValue));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(clonePatchRecord(value as Readonly<Record<string, PatchValue>>));
  }
  return value;
}

function assertProtocolVersion(graph: PatchGraph): void {
  const protocolVersion = (graph as { protocolVersion: number }).protocolVersion;
  if (protocolVersion !== 1) {
    throw new Error(`Unsupported patch graph protocol version: ${protocolVersion}`);
  }
}

function canonicalPatcher(patcher: PatchGraphNode): PatchGraphNode {
  return {
    boxes: [...patcher.boxes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((box) => ({
        ...box,
        patcher: box.patcher ? canonicalPatcher(box.patcher) : undefined,
      })),
    connections: [...patcher.connections].sort((left, right) => {
      const leftKey = `${left.source.id}:${left.source.port}->${left.destination.id}:${left.destination.port}`;
      const rightKey = `${right.source.id}:${right.source.port}->${right.destination.id}:${right.destination.port}`;
      return leftKey.localeCompare(rightKey);
    }),
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = sortValue(child);
    }
    return result;
  }
  return value;
}

function toPatchValue(value: unknown): PatchValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toPatchValue);
  if (typeof value === "object") {
    const result: Record<string, PatchValue> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child !== undefined) result[key] = toPatchValue(child);
    }
    return result;
  }
  return String(value);
}

function validateScope(scope: string): CompileError | null {
  if (/^[A-Za-z_]\w*$/.test(scope)) return null;
  return {
    code: ErrorCode.SYNTAX_ERROR,
    message: `Invalid maxforge scope: "${scope}". Use letters, digits, and underscores.`,
  };
}

function findReservedVarName(ast: ASTNode): CompileError | null {
  for (const statement of ast.statements) {
    if (statement.type !== "connection" && statement.attrs?.varname) {
      return {
        code: ErrorCode.RESERVED_ATTRIBUTE,
        message: "Managed patch graphs reserve @varname for stable object identity",
        line: statement.line,
      };
    }
    if (statement.type === "subpatcher_def") {
      const nested = findReservedVarName({
        type: "program",
        statements: statement.body,
      });
      if (nested) return nested;
    }
  }
  return null;
}
