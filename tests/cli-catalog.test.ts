import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli/index.js");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("maxforge catalog CLI", () => {
  it("searches built-ins when a query is supplied", async () => {
    const root = await temporaryDirectory();
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "catalog",
      "cycle~",
      "--json",
    ], { cwd: root });
    const result = JSON.parse(stdout);

    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "cycle~", kind: "built-in" }),
    ]));
  });

  it("lists only configured objects by default and reports argument rules", async () => {
    const root = await temporaryDirectory();
    const configPath = join(root, "maxforge.config.json");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      objects: [{
        name: "vendor.router",
        kind: "external",
        ports: {
          mode: "arguments",
          representative: { inlets: 1, outlets: [""] },
          outlets: {
            source: "argument-count",
            minimum: 1,
          },
        },
      }],
    }));

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "catalog",
      "--config",
      configPath,
      "--json",
    ], { cwd: root });
    const result = JSON.parse(stdout);

    expect(result.totalMatches).toBe(1);
    expect(result.objects).toEqual([
      expect.objectContaining({
        name: "vendor.router",
        kind: "external",
        argumentPorts: true,
        dynamicPorts: false,
      }),
    ]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "maxforge-cli-catalog-"));
  temporaryDirectories.push(path);
  return path;
}
