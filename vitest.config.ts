import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "bb-plugin-project-first-sidebar",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    maxWorkers: 1,
  },
});
