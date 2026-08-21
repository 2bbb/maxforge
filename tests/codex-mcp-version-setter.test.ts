import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL(
  "../skills/maxforge-mcp/scripts/set-codex-mcp-version.mjs",
  import.meta.url
));
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "maxforge-codex-mcp-setter-test-"));
  temporaryRoots.push(root);
  return root;
}

function setup(root: string, contents: string): { backupRoot: string; config: string } {
  const config = join(root, "codex", "config.toml");
  const backupRoot = join(root, "maxforge", "backups");
  mkdirSync(join(config, ".."), { recursive: true });
  writeFileSync(config, contents);
  return { backupRoot, config };
}

function run(config: string, backupRoot: string, version: string, extra: string[] = []) {
  const result = spawnSync(process.execPath, [
    script,
    "--json",
    "--config", config,
    "--backup-root", backupRoot,
    "--version", version,
    ...extra,
  ], { encoding: "utf8" });
  return {
    ...result,
    json: result.status === 0 ? JSON.parse(result.stdout) : undefined,
  };
}

describe("Codex maxforge MCP version setter", () => {
  it("rewrites only the exact package pin and backs up the complete config", () => {
    const root = temporaryRoot();
    const original = [
      '[mcp_servers.maxforge]',
      'command = "npx"',
      'args = ["-y", "--package=maxforge@0.4.4", "maxforge-mcp"]',
      'env = { MAXFORGE_WS_TOKEN = "private-token" }',
      '',
      '[mcp_servers.other]',
      'command = "leave-maxforge@9.9.9-alone"',
      '',
    ].join("\n");
    const { backupRoot, config } = setup(root, original);

    const result = run(config, backupRoot, "0.5.0");

    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      changed: true,
      previousVersion: "0.4.4",
      targetVersion: "0.5.0",
      codexRestartRequired: true,
    });
    const updated = readFileSync(config, "utf8");
    expect(updated).toContain("--package=maxforge@0.5.0");
    expect(updated).toContain('MAXFORGE_WS_TOKEN = "private-token"');
    expect(updated).toContain('command = "leave-maxforge@9.9.9-alone"');
    expect(result.stdout).not.toContain("private-token");
    expect(readFileSync(result.json.backup, "utf8")).toBe(original);
    expect(readdirSync(backupRoot)).toHaveLength(1);
  });

  it("handles a quoted table and multiline args without changing commented pins", () => {
    const root = temporaryRoot();
    const original = [
      '[mcp_servers."maxforge"]',
      '# old example: --package=maxforge@0.1.0',
      'command = "npx"',
      'args = [',
      '  "-y",',
      '  "--package=maxforge@latest", # replace this one',
      '  "maxforge-mcp",',
      ']',
      '',
    ].join("\n");
    const { backupRoot, config } = setup(root, original);

    const result = run(config, backupRoot, "1.0.0");

    expect(result.status, result.stderr).toBe(0);
    const updated = readFileSync(config, "utf8");
    expect(updated).toContain("# old example: --package=maxforge@0.1.0");
    expect(updated).toContain('"--package=maxforge@1.0.0", # replace this one');
  });

  it("does not create a backup or require restart when already pinned", () => {
    const root = temporaryRoot();
    const { backupRoot, config } = setup(root, [
      "[mcp_servers.maxforge]",
      'command = "npx"',
      'args = ["-y", "--package=maxforge@2.0.0", "maxforge-mcp"]',
      "",
    ].join("\n"));

    const result = run(config, backupRoot, "2.0.0");

    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      changed: false,
      backup: null,
      codexRestartRequired: false,
    });
    expect(existsSync(backupRoot)).toBe(false);
  });

  it("validates a dry run without writing or backing up", () => {
    const root = temporaryRoot();
    const original = [
      "[mcp_servers.maxforge]",
      'args = ["--package=maxforge@2.0.0", "maxforge-mcp"]',
      "",
    ].join("\n");
    const { backupRoot, config } = setup(root, original);

    const result = run(config, backupRoot, "2.1.0", ["--dry-run"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      changed: true,
      dryRun: true,
      backup: null,
      codexRestartRequired: false,
    });
    expect(readFileSync(config, "utf8")).toBe(original);
    expect(existsSync(backupRoot)).toBe(false);
  });

  it("fails closed for missing or duplicate package specifiers", () => {
    const root = temporaryRoot();
    const missing = setup(root, [
      "[mcp_servers.maxforge]",
      'args = ["maxforge-mcp"]',
      "",
    ].join("\n"));
    const missingResult = run(missing.config, missing.backupRoot, "3.0.0");
    expect(missingResult.status).toBe(1);
    expect(missingResult.stderr).toContain("do not contain a maxforge@<version>");

    const duplicateRoot = temporaryRoot();
    const duplicate = setup(duplicateRoot, [
      "[mcp_servers.maxforge]",
      'args = ["maxforge@2.0.0", "maxforge@2.1.0", "maxforge-mcp"]',
      "",
    ].join("\n"));
    const duplicateResult = run(duplicate.config, duplicate.backupRoot, "3.0.0");
    expect(duplicateResult.status).toBe(1);
    expect(duplicateResult.stderr).toContain("multiple maxforge package specifiers");
  });
});
