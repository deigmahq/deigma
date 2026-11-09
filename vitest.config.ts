import { defineConfig } from "vitest/config";

// Root runner: `pnpm test` executes every package's vitest project.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
