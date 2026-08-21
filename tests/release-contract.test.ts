import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

describe("native release contract", () => {
  it("publishes only versioned Max package assets", () => {
    const workflow = source(".github/workflows/build-max-package.yml");

    expect(workflow).toContain('archive="maxforge-v${version}.zip"');
    expect(workflow).toContain('archive="maxforge-ci-${GITHUB_SHA}.zip"');
    expect(workflow).toContain('artifact="maxforge-ci-${GITHUB_SHA}"');
    expect(workflow).toContain(
      'Release tag ${GITHUB_REF_NAME} does not match package version v${version}'
    );
    expect(workflow).toContain("dist/${{ steps.package-version.outputs.archive }}.sha256");
    expect(workflow).not.toContain("dist/maxforge.zip");
    expect(workflow).not.toContain("refs/tags/latest");
    expect(workflow).not.toContain("gh release create latest");
    expect(workflow).not.toContain("maxforge-latest");
  });

  it("documents the exact npm, tag, and native artifact relationship", () => {
    const releasing = source("docs/releasing.md");

    expect(releasing).toContain("maxforge-vX.Y.Z.zip");
    expect(releasing).toContain("one-to-one npm version, Git tag, and native package");
    expect(releasing).toContain("Only then publish npm");
  });

  it("does not contradict the signed and notarized release workflow", () => {
    const workflow = source(".github/workflows/build-max-package.yml");
    const publicGuidance = [
      source("README.md"),
      source("site/index.html"),
      source("site/docs/index.html"),
    ].join("\n");

    expect(workflow).toContain("Notarize and verify public archive");
    expect(publicGuidance).toContain("Developer ID signed and notarized");
    expect(publicGuidance.toLowerCase()).not.toContain("not notarized");
  });
});
