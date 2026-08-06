import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { LoadedObjectCatalog, CustomObjectInfo } from "./catalog-config.js";
import { PatcherJSON } from "./types.js";

export interface CatalogDependency extends CustomObjectInfo {
  readonly destination: "externals" | "patchers";
}

export async function collectCatalogDependencies(
  patcher: PatcherJSON,
  catalog: LoadedObjectCatalog
): Promise<readonly CatalogDependency[]> {
  const customByName = new Map(catalog.customObjects.map((item) => [item.name, item]));
  const dependencies = new Map<string, CatalogDependency>();
  const visitedAbstractions = new Set<string>();

  async function visit(document: PatcherJSON): Promise<void> {
    const names = objectNames(document.patcher);
    for (const name of names) {
      const dependency = customByName.get(name);
      if (!dependency || dependencies.has(name)) continue;
      const paths = dependency.paths ?? (dependency.path ? [dependency.path] : []);
      if (paths.length === 0) {
        throw new Error(
          `Portable bundle requires a path for ${dependency.kind} "${name}"`
        );
      }
      dependencies.set(name, {
        ...dependency,
        destination: dependency.kind === "external" ? "externals" : "patchers",
      });
      const abstractionPath = dependency.path;
      if (
        dependency.kind !== "abstraction" ||
        !abstractionPath ||
        visitedAbstractions.has(abstractionPath)
      ) {
        continue;
      }
      visitedAbstractions.add(abstractionPath);
      let nested: PatcherJSON;
      try {
        nested = JSON.parse(await readFile(abstractionPath, "utf8")) as PatcherJSON;
      } catch (error) {
        throw new Error(
          `Could not inspect abstraction dependency ${abstractionPath}: ` +
          (error instanceof Error ? error.message : String(error))
        );
      }
      await visit(nested);
    }
  }

  await visit(patcher);
  return [...dependencies.values()].sort((left, right) =>
    left.destination.localeCompare(right.destination) ||
    basename(left.paths?.[0] ?? left.path!).localeCompare(
      basename(right.paths?.[0] ?? right.path!)
    )
  );
}

function objectNames(patcher: PatcherJSON["patcher"]): Set<string> {
  const names = new Set<string>();
  for (const { box } of patcher.boxes) {
    names.add(box.maxclass);
    if (box.text) {
      const name = box.text.trim().match(/^(\S+)/)?.[1];
      if (name) names.add(name);
    }
    if (box.patcher) {
      for (const name of objectNames(box.patcher)) names.add(name);
    }
  }
  return names;
}
