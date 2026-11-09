import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // Times are shown in the local zone. Pin UTC, so the expected clock times
    // in the tests hold anywhere.
    env: { TZ: "UTC" },
    environmentMatchGlobs: [["test/**/*.test.tsx", "jsdom"]],
  },
});
