import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findObjectCatalogConfig,
  loadObjectCatalog,
} from "../src/core/catalog-config.js";
import { lookupObject } from "../src/core/object-db.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("project object catalogs", () => {
  it("keeps the built-in catalog when no project config exists", async () => {
    const root = await temporaryDirectory();
    const catalog = await loadObjectCatalog({ cwd: root });

    expect(catalog.configPath).toBeUndefined();
    expect(catalog.customObjects).toEqual([]);
    expect(catalog.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.database).toHaveProperty("cycle~");
  });

  it("loads fixed and dynamic external definitions", async () => {
    const root = await temporaryDirectory();
    const configPath = join(root, "maxforge.config.json");
    await writeJson(configPath, {
      schemaVersion: 1,
      objects: [
        {
          name: "vendor.fixed~",
          kind: "external",
          ports: {
            mode: "fixed",
            inlets: 3,
            outlets: ["signal", "bang"],
          },
          defaultSize: [120, 24],
        },
        {
          name: "vendor.dynamic~",
          kind: "external",
          ports: {
            mode: "dynamic",
            representative: { inlets: 1, outlets: ["signal"] },
          },
        },
      ],
    });

    const catalog = await loadObjectCatalog({ configPath });
    const fixed = lookupObject("vendor.fixed~ mode", catalog.database);
    const dynamic = lookupObject("vendor.dynamic~ 8", catalog.database);

    expect(fixed?.def).toMatchObject({
      maxclass: "newobj",
      numinlets: 3,
      numoutlets: 2,
      outlettype: ["signal", "bang"],
      defaultSize: [120, 24],
    });
    expect(dynamic?.def).toMatchObject({
      numinlets: 1,
      numoutlets: 1,
      dynamicPorts: true,
    });
    expect(catalog.customObjects.map(({ name, ports }) => ({ name, ports })))
      .toEqual([
        { name: "vendor.dynamic~", ports: "dynamic" },
        { name: "vendor.fixed~", ports: "fixed" },
      ]);
  });

  it("imports reusable catalogs before local definitions", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "catalogs"));
    await writeJson(join(root, "catalogs", "vendor.json"), {
      schemaVersion: 1,
      objects: [{
        name: "vendor.object",
        kind: "external",
        ports: { mode: "fixed", inlets: 1, outlets: [] },
      }],
    });
    await writeJson(join(root, "maxforge.config.json"), {
      schemaVersion: 1,
      catalogs: ["./catalogs/vendor.json"],
      objects: [{
        name: "local.object",
        kind: "external",
        ports: { mode: "fixed", inlets: 0, outlets: [""] },
      }],
    });

    const catalog = await loadObjectCatalog({ cwd: root });
    expect(catalog.sources).toEqual([
      join(root, "maxforge.config.json"),
      join(root, "catalogs", "vendor.json"),
    ]);
    expect(catalog.database).toHaveProperty("vendor.object");
    expect(catalog.database).toHaveProperty("local.object");
  });

  it("requires explicit override for collisions", async () => {
    const root = await temporaryDirectory();
    const configPath = join(root, "maxforge.config.json");
    await writeJson(configPath, {
      schemaVersion: 1,
      objects: [{
        name: "cycle~",
        kind: "external",
        ports: { mode: "fixed", inlets: 9, outlets: [] },
      }],
    });

    await expect(loadObjectCatalog({ configPath })).rejects.toThrow(
      'Object "cycle~" is already defined; set override to true'
    );
  });

  it("derives abstraction ports from its root patcher", async () => {
    const root = await temporaryDirectory();
    const abstractionPath = join(root, "patchers", "my.voice.maxpat");
    await mkdir(join(root, "patchers"));
    await writeJson(abstractionPath, abstractionFixture());
    await writeJson(join(root, "maxforge.config.json"), {
      schemaVersion: 1,
      abstractions: [{
        name: "my.voice",
        path: "./patchers/my.voice.maxpat",
        ports: "derive",
      }],
    });

    const catalog = await loadObjectCatalog({ cwd: root });
    const result = lookupObject("my.voice 440", catalog.database);
    expect(result?.def).toMatchObject({
      maxclass: "newobj",
      numinlets: 2,
      numoutlets: 2,
      outlettype: ["signal", ""],
      defaultSize: [100, 22],
    });
    expect(catalog.customObjects[0]).toMatchObject({
      name: "my.voice",
      kind: "abstraction",
      path: abstractionPath,
    });
  });

  it("discovers config upward from the input DSL", async () => {
    const root = await temporaryDirectory();
    const nested = join(root, "patches", "voices");
    await mkdir(nested, { recursive: true });
    const configPath = join(root, "maxforge.config.json");
    await writeJson(configPath, { schemaVersion: 1 });

    await expect(findObjectCatalogConfig(
      join(nested, "main.maxdsl")
    )).resolves.toBe(configPath);
  });

  it("rejects unknown schema properties instead of ignoring mistakes", async () => {
    const root = await temporaryDirectory();
    const configPath = join(root, "maxforge.config.json");
    await writeJson(configPath, {
      schemaVersion: 1,
      object: [],
    });

    await expect(loadObjectCatalog({ configPath })).rejects.toThrow(
      "Unrecognized key"
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "maxforge-catalog-"));
  temporaryDirectories.push(path);
  return path;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function abstractionFixture(): unknown {
  const box = (
    id: string,
    maxclass: string,
    x: number,
    outlettype?: string[]
  ) => ({
    box: {
      id,
      maxclass,
      numinlets: maxclass === "inlet" ? 0 : 1,
      numoutlets: maxclass === "outlet" ? 0 : 1,
      ...(outlettype ? { outlettype } : {}),
      patching_rect: [x, 20, 20, 20],
    },
  });
  return {
    patcher: {
      boxes: [
        box("in-1", "inlet", 20, ["signal"]),
        box("in-2", "inlet", 100, [""]),
        box("source-signal", "newobj", 20, ["signal"]),
        box("source-message", "newobj", 100, [""]),
        box("out-1", "outlet", 20),
        box("out-2", "outlet", 100),
      ],
      lines: [
        {
          patchline: {
            source: ["source-signal", 0],
            destination: ["out-1", 0],
          },
        },
        {
          patchline: {
            source: ["source-message", 0],
            destination: ["out-2", 0],
          },
        },
      ],
    },
  };
}
