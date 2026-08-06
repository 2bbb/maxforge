import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli/**"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 82,
        branches: 72,
        functions: 88,
        lines: 84,
      },
    },
  },
});
