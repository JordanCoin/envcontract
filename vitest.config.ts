import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "tests/fixtures/**"],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
