import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node22",
    platform: "node",
    outDir: "dist",
    clean: true,
    sourcemap: false,
    splitting: false,
    // Yerel ikili modül: paketlenmez, kurulu değilse CLI düz dosyaya düşer (auth/store.ts)
    external: ["@napi-rs/keyring"],
    banner: { js: "#!/usr/bin/env node" },
    define: { __PERAFLY_VERSION__: JSON.stringify(pkg.version) }
});
