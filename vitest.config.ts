import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The live e2e suite hits the real Cronvello API and is opt-in via CRONVELLO_E2E=1.
    exclude: process.env.CRONVELLO_E2E ? [] : ["test/e2e/**"],
    environment: "node",
    clearMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        // Barrel/entry files are re-exports only — nothing to cover.
        "src/index.ts",
        "src/express.ts",
        "src/next.ts",
        "src/dev.ts",
        // Declaration-only modules (interfaces/types) — no runtime code to exercise.
        "src/internal/wire.ts",
        "src/registry/types.ts",
        "src/registry/dispatch-handler.ts",
        // The dashboard UI is a single static HTML/CSS/JS string — no server-side logic to cover.
        "src/dev/dashboard-assets.ts",
        // CLI command glue is integration-tested via the built binary (see test/cli + live verify).
        "src/cli/index.ts",
      ],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
