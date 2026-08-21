import {
  existsSync,
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
  "../skills/maxforge/scripts/refresh-skills.mjs",
  import.meta.url
));
const mcpScript = fileURLToPath(new URL(
  "../skills/maxforge-mcp/scripts/refresh-skills.mjs",
  import.meta.url
));
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "maxforge-skill-refresh-test-"));
  temporaryRoots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeLock(path: string, hashes: {
  maxforge?: string;
  "maxforge-mcp"?: string;
}, source = "bbb-max-externals/maxforge"): void {
  const skills: Record<string, unknown> = {};
  for (const [name, hash] of Object.entries(hashes)) {
    skills[name] = {
      source,
      sourceType: "github",
      sourceUrl: `https://github.com/${source}.git`,
      skillPath: `skills/${name}/SKILL.md`,
      skillFolderHash: hash,
    };
  }
  writeJson(path, { version: 3, skills, dismissed: {} });
}

function writeFixtureCli(root: string, behavior: "current" | "update" | "false-success"): string {
  const path = join(root, "fake-skills-cli.mjs");
  writeFileSync(path, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const lockPath = process.env.MAXFORGE_SKILL_REFRESH_LOCK;',
    `const behavior = ${JSON.stringify(behavior)};`,
    'if (behavior === "false-success") {',
    '  console.log("✗ Failed to fetch tree for bbb-max-externals/maxforge");',
    '  process.exit(0);',
    '}',
    'if (behavior === "update") {',
    '  const lock = JSON.parse(readFileSync(lockPath, "utf8"));',
    '  for (const entry of Object.values(lock.skills)) entry.skillFolderHash += "-new";',
    '  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\\n");',
    '  console.log("Updated maxforge skills");',
    '} else {',
    '  console.log("All global skills are up to date");',
    '}',
  ].join("\n"));
  return path;
}

function run(root: string, lock: string, cli: string | undefined, arguments_: string[] = [],
  now = "2026-08-21T00:00:00.000Z") {
  const result = spawnSync(process.execPath, [
    script,
    "--json",
    "--lock", lock,
    "--cache", join(root, "cache.json"),
    ...arguments_,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      MAXFORGE_SKILL_REFRESH_NOW: now,
      ...(cli ? { MAXFORGE_SKILLS_CLI_FIXTURE: cli } : {}),
    },
  });
  return {
    ...result,
    json: result.status === 0 ? JSON.parse(result.stdout) : undefined,
  };
}

describe("maxforge skill refresh", () => {
  it("checks tracked skill hashes and reuses only a matching successful cache", () => {
    const root = temporaryRoot();
    const lock = join(root, "skill-lock.json");
    writeLock(lock, { maxforge: "offline-hash", "maxforge-mcp": "mcp-hash" });
    const cli = writeFixtureCli(root, "current");

    const first = run(root, lock, cli, ["--force"]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.json).toMatchObject({
      status: "current",
      checked: true,
      cached: false,
      reloadRequired: false,
      updatedSkills: [],
    });

    const second = run(root, lock, undefined, ["--offline"]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.json).toMatchObject({ status: "current", checked: true, cached: true });
  });

  it("reports updated hashes and requires the caller to reload skill instructions", () => {
    const root = temporaryRoot();
    const lock = join(root, "skill-lock.json");
    writeLock(lock, { maxforge: "old-a", "maxforge-mcp": "old-b" });

    const result = run(root, lock, writeFixtureCli(root, "update"), ["--force"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      status: "updated",
      checked: true,
      reloadRequired: true,
      updatedSkills: ["maxforge", "maxforge-mcp"],
      lock: {
        hashes: { maxforge: "old-a-new", "maxforge-mcp": "old-b-new" },
      },
    });
  });

  it("does not cache a Skills CLI false-success after an upstream failure", () => {
    const root = temporaryRoot();
    const lock = join(root, "skill-lock.json");
    writeLock(lock, { maxforge: "a", "maxforge-mcp": "b" });

    const result = run(root, lock, writeFixtureCli(root, "false-success"), ["--force"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({ status: "unknown", checked: false });
    expect(result.json.issues).toContainEqual(expect.objectContaining({
      code: "SKILL_UPDATE_CHECK_FAILED",
    }));
    expect(existsSync(join(root, "cache.json"))).toBe(false);
  });

  it("refuses an unexpected lock source before invoking an updater", () => {
    const root = temporaryRoot();
    const lock = join(root, "skill-lock.json");
    const marker = join(root, "invoked");
    writeLock(lock, { maxforge: "a" }, "attacker/maxforge");
    const cli = join(root, "must-not-run.mjs");
    writeFileSync(cli, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x");`);

    const result = run(root, lock, cli, ["--force"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json.status).toBe("blocked");
    expect(result.json.issues).toContainEqual(expect.objectContaining({
      code: "UNTRUSTED_SKILL_SOURCE",
    }));
    expect(existsSync(marker)).toBe(false);
  });

  it("does not call a stale cache current when offline", () => {
    const root = temporaryRoot();
    const lock = join(root, "skill-lock.json");
    writeLock(lock, { maxforge: "a" });
    const first = run(root, lock, writeFixtureCli(root, "current"), ["--force"]);
    expect(first.status, first.stderr).toBe(0);

    const stale = run(
      root,
      lock,
      undefined,
      ["--offline"],
      "2026-08-23T00:00:00.000Z"
    );
    expect(stale.status, stale.stderr).toBe(0);
    expect(stale.json.status).toBe("unknown");
    expect(stale.json.issues).toContainEqual(expect.objectContaining({
      code: "SKILL_UPDATE_UNCHECKED",
    }));
  });

  it("ships the same self-contained refresher in both skills", () => {
    expect(readFileSync(mcpScript, "utf8")).toBe(readFileSync(script, "utf8"));
  });
});
