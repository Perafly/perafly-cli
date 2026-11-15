#!/usr/bin/env node
/**
 * `SHA256SUMS` (README §8): klasördeki yayımlanan ikililerin SHA-256 özetleri, GNU `sha256sum` biçiminde.
 * `sha256sum -c SHA256SUMS` ve `shasum -a 256 -c SHA256SUMS` ile doğrulanır; packaging/install.sh bu dosyayı okur.
 *
 *   node scripts/checksums.mjs [klasör=dist-bin]
 *
 * Yalnız `perafly-<os>-<arch>[.exe]` adlı dosyalar girer (scripts/lib/release.mjs `TARGETS`).
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatSha256Sums, isBinaryAsset } from "./lib/release.mjs";

const dir = resolve(process.argv[2] ?? "dist-bin");

const sha256 = (file) =>
    new Promise((ok, fail) => {
        const hash = createHash("sha256");
        createReadStream(file)
            .on("error", fail)
            .on("data", (chunk) => hash.update(chunk))
            .on("end", () => ok(hash.digest("hex")));
    });

const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    process.stderr.write(`checksums: cannot read ${dir}: ${error.message}\n`);
    process.exit(1);
});
const names = entries.filter((e) => e.isFile() && isBinaryAsset(e.name)).map((e) => e.name);
if (!names.length) {
    process.stderr.write(`checksums: no perafly-<os>-<arch> binaries in ${dir}. Run npm run build:binary first.\n`);
    process.exit(1);
}

const sums = formatSha256Sums(await Promise.all(names.map(async (name) => ({ name, sha256: await sha256(join(dir, name)) }))));
await writeFile(join(dir, "SHA256SUMS"), sums);
process.stdout.write(sums);
