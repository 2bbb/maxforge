import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const verifier = resolve("scripts/verify-max-package.py");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("Max package verifier", () => {
  it("accepts the checked-in package sources", async () => {
    await expect(execFileAsync("python3", [
      verifier,
      "--source",
      resolve("."),
    ])).resolves.toMatchObject({ stderr: "" });
  });

  it("rejects traversal in package-info filelist paths", async () => {
    const root = await sourceFixture();
    const packageInfoPath = join(root, "package-info.json");
    const packageInfo = JSON.parse(await readFile(packageInfoPath, "utf8"));
    packageInfo.filelist["../escape"] = {};
    await writeJson(packageInfoPath, packageInfo);

    await expect(execFileAsync("python3", [
      verifier,
      "--source",
      root,
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("unsafe filelist path"),
    });
  });

  it("rejects a help patch that does not instantiate maxforge.sync", async () => {
    const root = await sourceFixture();
    const helpPath = join(root, "help", "maxforge.sync.maxhelp");
    const help = JSON.parse(await readFile(helpPath, "utf8"));
    help.patcher.boxes = help.patcher.boxes.filter(
      ({ box }: { box: { text?: string } }) => box.text !== "maxforge.sync"
    );
    await writeJson(helpPath, help);

    await expect(execFileAsync("python3", [
      verifier,
      "--source",
      root,
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("does not instantiate maxforge.sync"),
    });
  });
});

async function sourceFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "maxforge-package-verifier-"));
  temporaryDirectories.push(root);
  for (const relative of [
    "package.json",
    "package-info.json",
    "README.md",
    "LICENSE",
    "help/maxforge.sync.maxhelp",
    "help/managed_plan.json",
    "docs/maxforge.sync.maxref.xml",
  ]) {
    const destination = join(root, relative);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(relative), destination);
  }
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
