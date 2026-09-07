import { defineConfig } from "tsup";

import { version } from "./package.json";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    express: "src/express.ts",
    next: "src/next.ts",
    dev: "src/dev.ts",
    cli: "src/cli/index.ts",
  },
  format: ["esm", "cjs"],
  // The CLI ships only as ESM (it's the `bin`); no .d.ts needed for it.
  dts: { entry: { index: "src/index.ts", express: "src/express.ts", next: "src/next.ts", dev: "src/dev.ts" } },
  // Der Faehigkeitsbericht nennt seine eigene Version. Zur Bauzeit ersetzt, damit kein
  // package.json zur Laufzeit gelesen werden muss (das Paket hat bewusst keine Abhaengigkeiten).
  define: { __CRONVELLO_SDK_VERSION__: JSON.stringify(version) },
  clean: true,
  sourcemap: true,
  treeshake: true,
  splitting: false,
  // Zero runtime dependencies: nothing to bundle from node_modules. Node 20+ globals
  // (fetch, WebCrypto `crypto`) are used directly. Keep the published surface tiny.
  target: "node20",
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
