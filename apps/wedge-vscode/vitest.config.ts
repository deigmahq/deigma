import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // `vscode` exists only inside the extension host. The fake lets `activate()` run in tests, so
  // the wiring of the commands is asserted, not only the modules behind it (RD-16b).
  resolve: { alias: { vscode: fileURLToPath(new URL("./test/helpers/fake-vscode.ts", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"] },
});
