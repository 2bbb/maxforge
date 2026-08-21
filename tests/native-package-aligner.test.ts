import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL(
  "../skills/maxforge-mcp/scripts/align-native-package.mjs",
  import.meta.url
));
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "maxforge-aligner-test-"));
  temporaryRoots.push(root);
  return root;
}

function writePackage(root: string, version: string): string {
  const packageRoot = join(root, "maxforge");
  const files = new Map([
    ["package-info.json", JSON.stringify({ title: "maxforge", version })],
    ["externals/maxforge.sync.mxo/Contents/Info.plist", "plist"],
    ["externals/maxforge.sync.mxo/Contents/MacOS/maxforge.sync", "mach-o"],
    ["externals/maxforge.sync.mxe64", "pe"],
    ["help/maxforge.sync.maxhelp", "{}"],
    ["help/managed_plan.json", "{}"],
    ["docs/maxforge.sync.maxref.xml", "<c74object/>"],
  ]);
  for (const [relativePath, contents] of files) {
    const path = join(packageRoot, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return packageRoot;
}

function makeArchive(root: string, packageVersion: string, archiveVersion = packageVersion): {
  archive: string;
  checksum: string;
} {
  writePackage(root, packageVersion);
  const archiveName = `maxforge-v${archiveVersion}.zip`;
  const archive = join(root, archiveName);
  const python = spawnSync("python3", [
    "-c",
    [
      "import pathlib, sys, zipfile",
      "root = pathlib.Path(sys.argv[1])",
      "archive = pathlib.Path(sys.argv[2])",
      "with zipfile.ZipFile(archive, 'w') as output:",
      "  for path in sorted((root / 'maxforge').rglob('*')):",
      "    if path.is_file(): output.write(path, path.relative_to(root))",
    ].join("\n"),
    root,
    archive,
  ], { encoding: "utf8" });
  if (python.status !== 0) {
    throw new Error(`failed to create test archive: ${python.stderr}`);
  }
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const checksum = `${archive}.sha256`;
  writeFileSync(checksum, `${digest}  ${archiveName}\n`);
  return { archive, checksum };
}

function run(arguments_: string[]) {
  return spawnSync(process.execPath, [script, ...arguments_], {
    encoding: "utf8",
  });
}

describe("native Max package aligner", () => {
  it("verifies an exact-version local release artifact without installing it", () => {
    const root = temporaryRoot();
    const version = "1.2.3";
    const { archive, checksum } = makeArchive(root, version);

    const result = run([
      "--version", version,
      "--archive", archive,
      "--checksum", checksum,
      "--verify-only",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      installed: false,
      source: "local",
      verified: true,
      version,
    });
  });

  it("rejects a checksum entry for the old unversioned archive name", () => {
    const root = temporaryRoot();
    const version = "1.2.3";
    const { archive, checksum } = makeArchive(root, version);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(checksum, `${digest}  maxforge.zip\n`);

    const result = run([
      "--version", version,
      "--archive", archive,
      "--checksum", checksum,
      "--verify-only",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("maxforge-v1.2.3.zip");
  });

  it("rejects an archive whose Max package metadata has another version", () => {
    const root = temporaryRoot();
    const { archive, checksum } = makeArchive(root, "1.2.4", "1.2.3");

    const result = run([
      "--version", "1.2.3",
      "--archive", archive,
      "--checksum", checksum,
      "--verify-only",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("archive contains 1.2.4");
  });

  it("requires a concrete absolute maxforge package destination for installation", () => {
    const result = run(["--version", "1.2.3", "--destination", "Packages"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--destination must be an absolute path");
  });
});
