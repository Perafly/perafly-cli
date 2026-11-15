#!/usr/bin/env node
/**
 * Homebrew formülü (README §8): packaging/homebrew/perafly.rb şablonunu sürüm, depo (packaging/release.json) ve
 * SHA256SUMS ile doldurur. Formül tap deposuna (release.json `tap`) elle kopyalanır; bu betik hiçbir yere itmez.
 *
 *   node scripts/homebrew-formula.mjs [--sums dist-bin/SHA256SUMS] [--version <sürüm>] [--out dist-bin/perafly.rb]
 *
 * Sürüm verilmezse package.json'dan okunur.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fillFormula, parseSha256Sums, tapShortName, validateReleaseConfig } from "./lib/release.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
    options: {
        sums: { type: "string", default: "dist-bin/SHA256SUMS" },
        version: { type: "string" },
        out: { type: "string", default: "dist-bin/perafly.rb" }
    }
});

try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const config = validateReleaseConfig(JSON.parse(await readFile(join(root, "packaging", "release.json"), "utf8")));
    const template = await readFile(join(root, "packaging", "homebrew", "perafly.rb"), "utf8");
    const sums = parseSha256Sums(await readFile(resolve(values.sums), "utf8"));
    const version = (values.version ?? pkg.version).replace(/^v/, "");
    const formula = fillFormula(template, { version, repository: config.repository, sums });
    const out = resolve(values.out);
    await writeFile(out, formula);
    const shown = out.startsWith(process.cwd() + sep) ? relative(process.cwd(), out) : out;
    process.stdout.write(`${shown}: perafly ${version} from ${config.repository}. Copy it to Formula/perafly.rb in ${config.tap} (brew install ${tapShortName(config.tap)}/perafly).\n`);
} catch (error) {
    process.stderr.write(`homebrew:formula: ${error.message}\n`);
    process.exit(1);
}
