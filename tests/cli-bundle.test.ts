import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = resolve("dist/cli/index.js");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("maxforge bundle CLI", () => {
  it("writes a package with transitive abstractions and platform externals", async () => {
    const root = await temporaryDirectory();
    const output = join(root, "output");
    await mkdir(join(root, "patchers"));
    await mkdir(join(root, "externals", "vendor.fx.mxo", "Contents"), {
      recursive: true,
    });
    await writeFile(join(root, "externals", "vendor.fx.mxo", "Contents", "fixture"), "mac");
    await writeFile(join(root, "externals", "vendor.fx.mxe64"), "windows");
    await writeFile(join(root, "patchers", "voice.maxpat"), JSON.stringify({
      patcher: {
        boxes: [{ box: { id: "obj-1", maxclass: "newobj", text: "vendor.fx" } }],
        lines: [],
      },
    }));
    await writeFile(join(root, "input.maxdsl"), "voice_1 = voice\n");
    await writeJson(join(root, "maxforge.config.json"), {
      schemaVersion: 1,
      objects: [{
        name: "vendor.fx",
        kind: "external",
        path: [
          "./externals/vendor.fx.mxo",
          "./externals/vendor.fx.mxe64",
        ],
        ports: { mode: "fixed", inlets: 1, outlets: [""] },
      }],
      abstractions: [{
        name: "voice",
        path: "./patchers/voice.maxpat",
        ports: { mode: "fixed", inlets: 1, outlets: [""] },
      }],
    });

    const result = await execFileAsync(process.execPath, [
      cliPath,
      "bundle",
      "input.maxdsl",
      "-o",
      output,
      "--name",
      "portable-test",
    ], { cwd: root });

    expect(result.stdout).toContain("Dependencies: 2");
    await Promise.all([
      access(join(output, "patchers", "portable-test.maxpat")),
      access(join(output, "patchers", "voice.maxpat")),
      access(join(output, "externals", "vendor.fx.mxo", "Contents", "fixture")),
      access(join(output, "externals", "vendor.fx.mxe64")),
    ]);
    const packageInfo = JSON.parse(
      await readFile(join(output, "package-info.json"), "utf8")
    );
    expect(packageInfo).toMatchObject({
      title: "portable-test",
      author: "2bit",
      homepatcher: "patchers/portable-test.maxpat",
      os: {
        macintosh: { externals: ["externals/"] },
        windows: { externals: ["externals/"] },
      },
    });
    expect(Object.keys(packageInfo.filelist)).toEqual([
      "patchers/portable-test.maxpat",
      "externals/vendor.fx.mxe64",
      "externals/vendor.fx.mxo",
      "patchers/voice.maxpat",
    ]);
  });

  it("rejects dependency basename collisions", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "a"));
    await mkdir(join(root, "b"));
    await writeFile(join(root, "a", "shared.mxe64"), "a");
    await writeFile(join(root, "b", "shared.mxe64"), "b");
    await writeFile(join(root, "input.maxdsl"), "left = vendor.left\nright = vendor.right\n");
    await writeJson(join(root, "maxforge.config.json"), {
      schemaVersion: 1,
      objects: [
        {
          name: "vendor.left",
          kind: "external",
          path: "./a/shared.mxe64",
          ports: { mode: "fixed", inlets: 1, outlets: [] },
        },
        {
          name: "vendor.right",
          kind: "external",
          path: "./b/shared.mxe64",
          ports: { mode: "fixed", inlets: 1, outlets: [] },
        },
      ],
    });

    await expect(execFileAsync(process.execPath, [
      cliPath,
      "bundle",
      "input.maxdsl",
      "-o",
      join(root, "output"),
    ], { cwd: root })).rejects.toMatchObject({
      stderr: expect.stringContaining("Bundle path collision for externals/shared.mxe64"),
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "maxforge-cli-bundle-"));
  temporaryDirectories.push(path);
  return path;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
