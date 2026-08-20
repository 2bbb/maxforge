import { execFile, spawn } from "node:child_process";
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
  it("compiles, validates, decompiles, plans, and diagnoses through the published entrypoint", async () => {
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

    const doctor = await execFileAsync(process.execPath, [
      cliPath,
      "doctor",
      "--input",
      input,
    ]);
    expect(doctor.stdout).toContain("Object catalog validation passed.");
    expect(doctor.stdout).toContain("Config: built-in only");
  });

  it("round-trips compressed patch text from stdin", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "source.maxdsl");
    const recovered = join(root, "recovered.maxdsl");
    await writeFile(input, 'patch "Clipboard CLI"\nsource = button\nsink = print\nsource -> sink\n');

    const compiled = await execFileAsync(process.execPath, [
      cliPath,
      "compile",
      input,
      "--clipboard",
    ]);
    const result = await spawnWithInput(
      [cliPath, "from-clipboard", "-o", recovered],
      compiled.stdout
    );

    expect(result.code).toBe(0);
    expect(await readFile(recovered, "utf8")).toContain('patch "Clipboard CLI"');
    expect(await readFile(recovered, "utf8")).toContain("source -> sink");
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

  it("requires --allow-unknown instead of silently accepting unknown objects", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "unknown.maxdsl");
    const output = join(root, "unknown.maxpat");
    await writeFile(input, "custom = vendor.not_installed 123\n");

    await expect(execFileAsync(process.execPath, [
      cliPath,
      "compile",
      input,
      "-o",
      output,
    ])).rejects.toMatchObject({ stderr: expect.stringContaining("[E003]") });

    await execFileAsync(process.execPath, [
      cliPath,
      "compile",
      input,
      "--allow-unknown",
      "-o",
      output,
    ]);
    const patch = JSON.parse(await readFile(output, "utf8"));
    expect(patch.patcher.boxes).toEqual([
      expect.objectContaining({
        box: expect.objectContaining({ text: "vendor.not_installed 123" }),
      }),
    ]);
  });

  it("builds a compact differential plan from --current DSL", async () => {
    const root = await temporaryDirectory();
    const current = join(root, "current.maxdsl");
    const desired = join(root, "desired.maxdsl");
    await writeFile(current, "source = button\n");
    await writeFile(desired, "source = button\nsink = print cli_diff\nsource -> sink\n");

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "plan",
      desired,
      "--current",
      current,
      "--scope",
      "cli_diff",
      "--compact",
    ]);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const plan = JSON.parse(stdout);
    expect(plan.operations).toEqual([
      expect.objectContaining({ op: "create", box: expect.objectContaining({ id: "obj-sink" }) }),
      expect.objectContaining({ op: "connect" }),
    ]);
  });

  it("rejects ambiguous output and unknown command options", async () => {
    const root = await temporaryDirectory();
    const input = join(root, "source.maxdsl");
    const output = join(root, "output.maxpat");
    await writeFile(input, "source = button\n");

    await expect(execFileAsync(process.execPath, [
      cliPath,
      "compile",
      input,
      "-o",
      output,
      "--clipboard",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("either -o or --clipboard"),
    });

    await expect(execFileAsync(process.execPath, [
      cliPath,
      "decompile",
      output,
      "--bogus",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown decompile argument"),
    });

    const clipboard = await spawnWithInput(
      [cliPath, "from-clipboard", "--bogus"],
      "ignored"
    );
    expect(clipboard.code).toBe(1);
    expect(clipboard.stderr).toContain("Unknown from-clipboard argument");
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "maxforge-cli-core-"));
  temporaryDirectories.push(path);
  return path;
}

async function spawnWithInput(
  args: string[],
  input: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
