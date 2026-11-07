import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Route handlers import through the @/ alias of tsconfig.json; the bench loads them.
  resolve: { alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }] },
  test: {
    include: ["lib/**/*.test.ts", "bench/**/*.test.ts", "app/**/*.test.ts"],
    environment: "node",
  },
});
