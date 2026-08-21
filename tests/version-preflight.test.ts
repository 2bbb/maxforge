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
  "../skills/maxforge/scripts/check-version.mjs",
  import.meta.url
));
const mcpScript = fileURLToPath(new URL(
  "../skills/maxforge-mcp/scripts/check-version.mjs",
  import.meta.url
));
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "maxforge-version-preflight-test-"));
  temporaryRoots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function writeRemoteFixtures(root: string, version: string, options: {
  assetsComplete?: boolean;
  npmVersion?: string;
} = {}): { github: string; npm: string } {
  const github = join(root, "github.json");
  const npm = join(root, "npm.json");
  const archive = `maxforge-v${version}.zip`;
  writeJson(github, {
    tag_name: `v${version}`,
    html_url: `https://example.invalid/releases/v${version}`,
    assets: options.assetsComplete === false
      ? [{ name: archive }]
      : [{ name: archive }, { name: `${archive}.sha256` }],
  });
  writeJson(npm, { version: options.npmVersion ?? version });
  return { github, npm };
}

function writeCodexConfig(path: string, version: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, [
    "[mcp_servers.maxforge]",
    'command = "npx"',
    `args = ["-y", "--package=maxforge@${version}", "maxforge-mcp"]`,
    "",
    "[mcp_servers.unrelated]",
    'command = "contains-maxforge@99.0.0-but-must-not-be-read"',
    "",
  ].join("\n"));
}

function writeMaxPackage(root: string, version: string): void {
  writeJson(join(root, "package-info.json"), { title: "maxforge", version });
}

function run(root: string, arguments_: string[], fixtures?: {
  github: string;
  npm: string;
}, now = "2026-08-21T00:00:00.000Z") {
  const result = spawnSync(process.execPath, [
    script,
    "--json",
    "--cache", join(root, "cache.json"),
    "--project-root", root,
    ...arguments_,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      MAXFORGE_VERSION_CHECK_NOW: now,
      MAXFORGE_VERSION_CHECK_NO_HOME_DISCOVERY: "1",
      ...(fixtures ? {
        MAXFORGE_VERSION_CHECK_GITHUB_FIXTURE: fixtures.github,
        MAXFORGE_VERSION_CHECK_NPM_FIXTURE: fixtures.npm,
      } : {}),
    },
  });
  return {
    ...result,
    json: result.status === 0 ? JSON.parse(result.stdout) : undefined,
  };
}

describe("maxforge version preflight", () => {
  it("reports one coherent update across an exact MCP pin and Max package", () => {
    const root = temporaryRoot();
    const config = join(root, "config.toml");
    const maxPackage = join(root, "installed", "maxforge");
    const fixtures = writeRemoteFixtures(root, "1.3.0");
    writeCodexConfig(config, "1.2.0");
    writeMaxPackage(maxPackage, "1.2.0");

    const result = run(root, [
      "--force",
      "--codex-config", config,
      "--max-package", maxPackage,
    ], fixtures);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      status: "update-available",
      latest: "1.3.0",
      remote: { cached: false, stale: false },
      local: {
        mcp: { mode: "npx-exact", version: "1.2.0" },
        maxPackages: [{ version: "1.2.0" }],
      },
    });
    expect(result.json.issues.map((entry: { code: string }) => entry.code)).toEqual([
      "MCP_OUTDATED",
      "NATIVE_OUTDATED",
    ]);
  });

  it("caches only remote metadata and re-reads changed local versions", () => {
    const root = temporaryRoot();
    const config = join(root, "config.toml");
    const maxPackage = join(root, "installed", "maxforge");
    const fixtures = writeRemoteFixtures(root, "2.0.0");
    writeCodexConfig(config, "1.9.0");
    writeMaxPackage(maxPackage, "1.9.0");

    const first = run(root, [
      "--force",
      "--codex-config", config,
      "--max-package", maxPackage,
    ], fixtures);
    expect(first.status, first.stderr).toBe(0);

    writeCodexConfig(config, "2.0.0");
    writeMaxPackage(maxPackage, "2.0.0");
    const second = run(root, [
      "--offline",
      "--codex-config", config,
      "--max-package", maxPackage,
    ]);

    expect(second.status, second.stderr).toBe(0);
    expect(second.json).toMatchObject({
      status: "current",
      latest: "2.0.0",
      remote: { cached: true, stale: false },
      local: {
        mcp: { version: "2.0.0" },
        maxPackages: [{ version: "2.0.0" }],
      },
      issues: [],
    });
  });

  it("fails closed when GitHub and npm do not publish one version set", () => {
    const root = temporaryRoot();
    const fixtures = writeRemoteFixtures(root, "3.0.0", { npmVersion: "2.9.0" });

    const result = run(root, ["--force"], fixtures);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json.status).toBe("blocked");
    expect(result.json.latest).toBeNull();
    expect(result.json.issues).toContainEqual(expect.objectContaining({
      code: "PUBLISHED_VERSION_MISMATCH",
      severity: "error",
    }));
  });

  it("rejects a release without the exact Max package checksum asset", () => {
    const root = temporaryRoot();
    const fixtures = writeRemoteFixtures(root, "3.1.0", { assetsComplete: false });

    const result = run(root, ["--force"], fixtures);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json.status).toBe("blocked");
    expect(result.json.issues).toContainEqual(expect.objectContaining({
      code: "RELEASE_ASSETS_INCOMPLETE",
      severity: "error",
    }));
  });

  it("detects a moving MCP tag without reading unrelated TOML sections", () => {
    const root = temporaryRoot();
    const config = join(root, "config.toml");
    const fixtures = writeRemoteFixtures(root, "4.0.0");
    writeCodexConfig(config, "latest");

    const result = run(root, [
      "--force",
      "--codex-config", config,
    ], fixtures);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json.local.mcp).toMatchObject({ mode: "npx-moving", version: null });
    expect(result.json.issues).toContainEqual(expect.objectContaining({
      code: "MCP_MOVING_VERSION",
    }));
    expect(JSON.stringify(result.json)).not.toContain("99.0.0");
  });

  it("reads a quoted multiline MCP table without treating comments as pins", () => {
    const root = temporaryRoot();
    const config = join(root, "config.toml");
    const fixtures = writeRemoteFixtures(root, "4.1.0");
    writeFileSync(config, [
      '[mcp_servers."maxforge"]',
      '# args = ["--package=maxforge@0.1.0"]',
      'command = "npx"',
      "args = [",
      '  "-y",',
      '  "--package=maxforge@4.1.0", # current exact pin',
      '  "maxforge-mcp",',
      "]",
      "# maxforge@0.2.0 is historical text, not configuration",
      "",
    ].join("\n"));

    const result = run(root, [
      "--force",
      "--codex-config", config,
    ], fixtures);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json.local.mcp).toMatchObject({
      mode: "npx-exact",
      version: "4.1.0",
    });
    expect(result.json.status).toBe("current");
  });

  it("uses stale cache as non-blocking evidence when offline", () => {
    const root = temporaryRoot();
    const fixtures = writeRemoteFixtures(root, "5.0.0");
    const first = run(root, ["--force"], fixtures);
    expect(first.status, first.stderr).toBe(0);

    const second = run(
      root,
      ["--offline"],
      undefined,
      "2026-08-23T00:00:00.000Z"
    );

    expect(second.status, second.stderr).toBe(0);
    expect(second.json).toMatchObject({
      status: "stale",
      latest: "5.0.0",
      remote: { cached: true, stale: true },
    });
  });

  it("does not block local work when offline without a cache", () => {
    const root = temporaryRoot();

    const result = run(root, ["--offline"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json.status).toBe("unknown");
    expect(result.json.issues).toContainEqual(expect.objectContaining({
      code: "REMOTE_UNAVAILABLE",
      severity: "warning",
    }));
  });

  it("ships the same self-contained checker in both independently installable skills", () => {
    expect(readFileSync(mcpScript, "utf8")).toBe(readFileSync(script, "utf8"));
  });
});
