import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectCatalogDependencies,
  loadObjectCatalog,
} from "../src/index.js";
import { compile } from "../src/core/compiler.js";
import { parse } from "../src/dsl/parser.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("portable catalog dependencies", () => {
  it("collects transitive abstractions and external bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "maxforge-bundle-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "patchers"));
    await mkdir(join(root, "externals"));
    const externalPath = join(root, "externals", "vendor.fx.mxe64");
    await writeFile(externalPath, "fixture");
    const abstractionPath = join(root, "patchers", "voice.maxpat");
    await writeFile(abstractionPath, JSON.stringify({
      patcher: {
        boxes: [{ box: { id: "obj-1", maxclass: "newobj", text: "vendor.fx mode" } }],
        lines: [],
      },
    }));
    const configPath = join(root, "maxforge.config.json");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      objects: [{
        name: "vendor.fx",
        kind: "external",
        path: "./externals/vendor.fx.mxe64",
        ports: { mode: "fixed", inlets: 1, outlets: [""] },
      }],
      abstractions: [{
        name: "voice",
        path: "./patchers/voice.maxpat",
        ports: { mode: "fixed", inlets: 1, outlets: [""] },
      }],
    }));
    const catalog = await loadObjectCatalog({ configPath });
    const parsed = parse("v = voice");
    const compiled = compile(parsed.ast, catalog.database);

    expect(compiled.success).toBe(true);
    await expect(collectCatalogDependencies(compiled.output!, catalog)).resolves.toEqual([
      expect.objectContaining({
        name: "vendor.fx",
        destination: "externals",
        path: externalPath,
      }),
      expect.objectContaining({
        name: "voice",
        destination: "patchers",
        path: abstractionPath,
      }),
    ]);
  });

  it("refuses a portable bundle when a used external has no source path", async () => {
    const root = await mkdtemp(join(tmpdir(), "maxforge-bundle-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "maxforge.config.json");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      objects: [{
        name: "vendor.fx",
        kind: "external",
        ports: { mode: "fixed", inlets: 1, outlets: [""] },
      }],
    }));
    const catalog = await loadObjectCatalog({ configPath });
    const compiled = compile(parse("fx = vendor.fx").ast, catalog.database);

    await expect(collectCatalogDependencies(compiled.output!, catalog)).rejects.toThrow(
      'requires a path for external "vendor.fx"'
    );
  });

  it("detects custom objects serialized directly as their maxclass", async () => {
    const root = await mkdtemp(join(tmpdir(), "maxforge-bundle-"));
    temporaryDirectories.push(root);
    const externalPath = join(root, "vendor.ui.mxe64");
    await writeFile(externalPath, "fixture");
    const configPath = join(root, "maxforge.config.json");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      objects: [{
        name: "vendor.ui",
        kind: "external",
        path: "./vendor.ui.mxe64",
        serialization: { maxclass: "vendor.ui" },
        ports: { mode: "fixed", inlets: 1, outlets: [] },
      }],
    }));
    const catalog = await loadObjectCatalog({ configPath });
    const patcher = {
      patcher: {
        boxes: [{ box: { id: "obj-1", maxclass: "vendor.ui" } }],
        lines: [],
      },
    } as never;

    await expect(collectCatalogDependencies(patcher, catalog)).resolves.toEqual([
      expect.objectContaining({ name: "vendor.ui", path: externalPath }),
    ]);
  });
});
