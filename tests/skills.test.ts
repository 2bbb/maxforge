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

    expect(skill).toContain("--package=maxforge@latest");
    expect(skill).toContain("--package=maxforge@X.Y.Z");
    expect(skill).not.toMatch(/maxforge@\d+\.\d+\.\d+/);
    expect(skill).toContain("never copy a version number from this skill");
    expect(skill).toContain("maxforge broker status");
    expect(skill).toContain("maxforge broker restart");
  });

  it("rejects known fabricated Max signal object names in agent guidance", () => {
    const guidance = [
      source("skills/maxforge/SKILL.md"),
      source("skills/maxforge-mcp/SKILL.md"),
    ].join("\n");

    expect(guidance).not.toMatch(/`(?:s~|r~)`/);
    expect(guidance).toContain("never invent `inlet~` or `outlet~`");
  });
});
