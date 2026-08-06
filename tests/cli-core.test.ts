import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("maxforge core CLI commands", () => {
  it("compiles, validates, decompiles, and plans through the published entrypoint", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "source.maxdsl");
    const output = join(root, "compiled.maxpat");
    const recovered = join(root, "recovered.maxdsl");
    const plan = join(root, "plan.json");
    await writeFile(
      input,
      'patch "CLI | test" | "metadata" | 720x480\nsource = button\nsink = print\nsource -> sink\n'
    );

    await execFileAsync(process.execPath, [cliPath, "compile", input, "-o", output]);
    const patch = JSON.parse(await readFile(output, "utf8"));
    expect(patch.patcher).toMatchObject({
      title: "CLI | test",
      description: "metadata",
      rect: [100, 100, 720, 480],
    });

    const validation = await execFileAsync(process.execPath, [
      cliPath,
      "validate",
      input,
    ]);
    expect(validation.stdout).toContain("Validation passed.");

    await execFileAsync(process.execPath, [
      cliPath,
      "decompile",
      output,
      "-o",
      recovered,
    ]);
    expect(await readFile(recovered, "utf8")).toContain(
      'patch "CLI | test" | "metadata" | 720x480'
    );

    await execFileAsync(process.execPath, [
      cliPath,
      "plan",
      input,
      "--scope",
      "cli_test",
      "-o",
      plan,
    ]);
    expect(JSON.parse(await readFile(plan, "utf8"))).toMatchObject({
      protocolVersion: 1,
      scope: "cli_test",
      operations: expect.arrayContaining([
        expect.objectContaining({ op: "create" }),
        expect.objectContaining({ op: "connect" }),
      ]),
    });
  });

  it("returns a failing exit status for invalid DSL", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "invalid.maxdsl");
    await writeFile(input, "fabricated = definitely.not.a.max.object\n");

    await expect(execFileAsync(process.execPath, [
      cliPath,
      "validate",
      input,
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("[E003]"),
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "maxforge-cli-core-"));
  temporaryDirectories.push(path);
  return path;
}
