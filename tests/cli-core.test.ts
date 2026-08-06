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
    expect(await readFile(recovered, "utf8")).toContain("button -> print");
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
