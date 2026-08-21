import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function frontmatterField(markdown: string, field: string): string {
  const match = markdown.match(
    new RegExp(`^${field}:\\s*(.+)$`, "m")
  );
  if (!match) throw new Error(`missing ${field} frontmatter field`);
  return match[1].trim();
}

function yamlString(yaml: string, field: string): string {
  const match = yaml.match(
    new RegExp(`^\\s*${field}:\\s*["']([^"']+)["']\\s*$`, "m")
  );
  if (!match) throw new Error(`missing quoted ${field} field`);
  return match[1];
}

describe("agent skills", () => {
  for (const skillName of ["maxforge", "maxforge-mcp"]) {
    it(`${skillName} has valid invocation metadata`, () => {
      const markdown = source(`skills/${skillName}/SKILL.md`);
      const metadata = source(`skills/${skillName}/agents/openai.yaml`);

      expect(markdown).toMatch(/^---\n[\s\S]+?\n---\n/);
      expect(frontmatterField(markdown, "name")).toBe(skillName);
      expect(frontmatterField(markdown, "description").length).toBeGreaterThan(0);

      const shortDescription = yamlString(metadata, "short_description");
      expect(shortDescription.length).toBeGreaterThanOrEqual(25);
      expect(shortDescription.length).toBeLessThanOrEqual(64);
      expect(yamlString(metadata, "default_prompt")).toContain(`$${skillName}`);
    });
  }

  it("keeps the live-control skill tool inventory aligned with the MCP server", () => {
    const server = source("src/mcp/mcp-server.ts");
    const skill = source("skills/maxforge-mcp/SKILL.md");
    const registered = [...server.matchAll(
      /server\.registerTool\(\s*["'](maxforge_[a-z_]+)["']/g
    )].map((match) => match[1]);
    const requiredSection = skill
      .split("## Tool availability and setup")[1]
      ?.split("\n## ")[0];
    if (!requiredSection) throw new Error("missing required MCP tool section");
    const documented = [...requiredSection.matchAll(
      /^- `(maxforge_[a-z_]+)`$/gm
    )]
      .map((match) => match[1]);

    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.sort()).toEqual(registered.sort());
  });

  it("keeps live-control version guidance release-independent", () => {
    const skill = source("skills/maxforge-mcp/SKILL.md");
    const alignment = source(
      "skills/maxforge-mcp/references/native-version-alignment.md"
    );

    expect(skill).toContain("--package=maxforge@X.Y.Z");
    expect(skill).not.toContain("--package=maxforge@latest");
    expect(skill).toContain("starts with `v0.5.0`");
    expect(skill).not.toMatch(/maxforge@\d+\.\d+\.\d+/);
    expect(skill).toContain("never copy a version number from this skill");
    expect(skill).toContain("maxforge broker status");
    expect(skill).toContain("maxforge broker restart");
    expect(skill).toContain("references/native-version-alignment.md");
    expect(skill).toContain("references/update-workflow.md");
    expect(alignment).toContain("maxforge-vX.Y.Z.zip");
    expect(alignment).toContain("Do not fall back");
    expect(alignment).toContain("versionCompatible: true");
  });

  it("keeps skill commands off the moving npm latest tag", () => {
    const offlineSkill = readFileSync("skills/maxforge/SKILL.md", "utf8");
    const liveSkill = readFileSync("skills/maxforge-mcp/SKILL.md", "utf8");
    const alignment = readFileSync(
      "skills/maxforge-mcp/references/native-version-alignment.md",
      "utf8"
    );

    expect(offlineSkill).not.toMatch(/npx[^\n]*maxforge@latest/);
    expect(offlineSkill).toContain("maxforge@X.Y.Z");
    expect(liveSkill).toMatch(/Releases\s+through `v0\.4\.4`/);
    expect(alignment).toContain("available from release `v0.5.0`");
    expect(alignment).toContain("never use `maxforge@latest`");
  });

  it("requires a bounded once-per-session version preflight", () => {
    for (const skillName of ["maxforge", "maxforge-mcp"]) {
      const skill = source(`skills/${skillName}/SKILL.md`);
      const description = frontmatterField(skill, "description");

      expect(description).toContain("first maxforge-related task in a session");
      expect(description).toContain("unrelated general Max/MSP questions");
      expect(skill).toContain("scripts/refresh-skills.mjs --json");
      expect(skill).toContain("scripts/check-version.mjs --json");
      expect(skill).toContain("24 hours");
      expect(skill).toMatch(/A check does not\s+authorize replacement/);

      expect(source(`skills/${skillName}/scripts/check-version.mjs`)).toContain(
        "MAXFORGE_VERSION_CHECK_NO_HOME_DISCOVERY"
      );
      expect(source(`skills/${skillName}/scripts/refresh-skills.mjs`)).toContain(
        "SKILL_UPDATE_CHECK_FAILED"
      );
    }
  });

  it("documents the complete authorized update order and restart conditions", () => {
    const skill = source("skills/maxforge-mcp/SKILL.md");
    const workflow = source("skills/maxforge-mcp/references/update-workflow.md");

    expect(skill).toContain("Never omit the broker");
    expect(workflow).toContain("Refresh Agent instructions first");
    expect(workflow).toContain("Rewrite only the Codex MCP pin");
    expect(workflow).toContain("Replace the broker deliberately");
    expect(workflow).toContain("Replace the complete Max package");
    expect(workflow).toContain("Max was running before the update");
    expect(workflow).toContain("no Max restart is needed");
    expect(workflow).toContain("versionCompatible: true");
  });

  it("rejects known fabricated Max signal object names in agent guidance", () => {
    const guidance = [
      source("skills/maxforge/SKILL.md"),
      source("skills/maxforge-mcp/SKILL.md"),
    ].join("\n");

    expect(guidance).not.toMatch(/`(?:s~|r~)`/);
    expect(guidance).toContain("never invent `inlet~` or `outlet~`");
  });

  it("requires context-derived semantic identities in agent guidance", () => {
    const offline = source("skills/maxforge/SKILL.md");
    const live = source("skills/maxforge-mcp/SKILL.md");

    expect(offline).toContain("semantic DSL names");
    expect(offline).toContain("Max box ID");
    expect(live).toContain("managed varname");
    expect(live).toContain("inspect the surrounding patch context before naming it");
    expect(live).toContain("Do not silently claim an unmanaged human-created box");
  });
});
