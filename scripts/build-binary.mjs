#!/usr/bin/env node
/**
 * Geçerli platform için tek dosya ikili (README §8): `dist-bin/perafly-<os>-<arch>[.exe]`.
 *
 * Yöntem Node SEA'dır (single executable application; resmî): kaynak tek bir CommonJS dosyasına paketlenir (bütün
 * bağımlılıklar içinde), `node --experimental-sea-config` ile blob üretilir, Node ikilisinin kopyasına `postject` ile
 * gömülür. macOS'ta kopyanın imzası silinir, gömmeden sonra ad-hoc imzalanır (Apple Silicon imzasız ikiliyi çalıştırmaz).
 *
 * `@napi-rs/keyring` yerel modüldür ve ikiliye girmez: pakette yüklenince hata veren bir taslakla değiştirilir, ikili
 * kimliği `~/.perafly/credentials/` altındaki 0600 dosyaya yazar (src/auth/store.ts'in "modül yok" düşüş yolu;
 * `PERAFLY_CREDENTIAL_STORE=keyring` ikilide `credential_keyring_unavailable` verir). Dışarıda bırakılmaz: SEA'da dinamik
 * `import()` yalın adı blob'daki `main` yolundan (göreliyse çalışma klasöründen) çözer; ikili o zaman kullanıcının
 * bulunduğu klasördeki ya da derleme makinesinin yolundaki `node_modules`'tan yerel kod yükleyip kimliği ona verirdi.
 * Pakette yerleşik modül dışında bir `import()`/`require()` kalırsa derleme düşer.
 *
 *   node scripts/build-binary.mjs [--node <node ikilisi>] [--expect-target darwin-arm64] [--out-dir dist-bin]
 *
 * `--node` (ya da `PERAFLY_SEA_NODE`) gömülecek Node'dur; verilmezse bu betiği çalıştıran Node. Resmî derleme olmalıdır
 * (nodejs.org, nvm, actions/setup-node): paylaşımlı kütüphaneye bağlı Node (ör. Homebrew'unki) taşınabilir ikili vermez.
 */
import { spawnSync } from "node:child_process";
import { isBuiltin } from "node:module";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { binaryName, targetFor } from "./lib/release.mjs";

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fail = (message) => {
    process.stderr.write(`build:binary: ${message}\n`);
    process.exit(1);
};

const run = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
    if (r.error) fail(`${cmd} could not start: ${r.error.message}`);
    if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed (exit ${r.status})\n${r.stdout ?? ""}${r.stderr ?? ""}`);
    return r.stdout ?? "";
};

const { values } = parseArgs({
    options: {
        node: { type: "string" },
        "expect-target": { type: "string" },
        "out-dir": { type: "string", default: "dist-bin" }
    }
});

const target = (() => {
    try {
        return targetFor(process.platform, process.arch);
    } catch (error) {
        return fail(error.message);
    }
})();
if (values["expect-target"] && values["expect-target"] !== target) {
    fail(`expected ${values["expect-target"]}, but this machine builds ${target}`);
}

const nodeBin = resolve(values.node ?? process.env.PERAFLY_SEA_NODE ?? process.execPath);
const nodeInfo = JSON.parse(
    run(nodeBin, ["-p", "JSON.stringify({ version: process.versions.node, shared: Object.entries(process.config.variables).filter(([k, v]) => k.startsWith('node_shared') && v === true).map(([k]) => k) })"])
);
const nodeMajor = Number(nodeInfo.version.split(".")[0]);
if (nodeMajor < 22) fail(`Node ${nodeInfo.version} is too old; the binary embeds Node 22 or later`);
if (nodeInfo.shared.length) {
    process.stderr.write(`build:binary: warning: ${nodeBin} links shared libraries (${nodeInfo.shared.join(", ")}); the binary will not run on other machines. Use an official Node build.\n`);
}

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const outDir = resolve(root, values["out-dir"]);
const work = join(outDir, ".sea");
const output = join(outDir, binaryName(target));
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

// 1. Tek CommonJS dosya. SEA'nın ana betiği CommonJS olmalı ve yalnız yerleşik modülleri `require` edebilir: bütün
//    bağımlılıklar pakete girer; yerel modül (anahtar zinciri) yüklenince hata veren taslaktır.
const KEYRING_STUB = "The system keyring is not available in the single-file binary";
const keyringStub = {
    name: "perafly-keyring-stub",
    setup(b) {
        b.onResolve({ filter: /^@napi-rs\/keyring(?:\/.*)?$/ }, () => ({ path: "keyring", namespace: "perafly-binary" }));
        b.onLoad({ filter: /.*/, namespace: "perafly-binary" }, () => ({ contents: `throw new Error(${JSON.stringify(KEYRING_STUB)});\n`, loader: "js" }));
    }
};
const { build } = await import("tsup");
const skill = await readFile(join(root, "skills", "perafly", "SKILL.md"), "utf8");
await build({
    config: false,
    silent: true,
    entry: { perafly: join(root, "src", "cli.ts") },
    format: ["cjs"],
    platform: "node",
    target: `node${Math.min(nodeMajor, 22)}`,
    outDir: work,
    outExtension: () => ({ js: ".cjs" }),
    tsconfig: join(root, "tsconfig.json"),
    clean: false,
    dts: false,
    splitting: false,
    sourcemap: false,
    // `import.meta.url` CommonJS'te `__filename`'den (SEA'da ikilinin yolu) üretilir
    shims: true,
    noExternal: [/.*/],
    esbuildPlugins: [keyringStub],
    define: {
        __PERAFLY_VERSION__: JSON.stringify(pkg.version),
        __PERAFLY_BINARY__: "true",
        // `setup agent` becerisi paketten okunur; ikilide paket klasörü yoktur
        __PERAFLY_EMBEDDED_SKILL__: JSON.stringify(skill)
    }
});
const main = join(work, "perafly.cjs");
const bundle = await readFile(main, "utf8").catch(() => fail(`bundle not written: ${main}`));
// Yerleşik olmayan modül yüklemesi kalmamalı (SEA'da dışarıdan, çalışma klasörüne göre yüklenirdi). Dize içindeki
// eşleşme sayılmaz (ajv'nin bağımsız kod üretimi için tuttuğu `.code = 'require("ajv/…")'` metinleri).
const loads = [...bundle.matchAll(/(?<![\w$.'"`])(?:import|require)\(\s*(["'`])([^"'`]+)\1\s*\)/g)].map((m) => m[2]);
const foreign = [...new Set(loads.filter((id) => !isBuiltin(id)))];
if (foreign.length) fail(`the bundle still loads modules from disk: ${foreign.join(", ")}`);
if (!bundle.includes(KEYRING_STUB)) fail("the keyring stub is missing from the bundle");

// 2. SEA blob'u. Kod önbelleği gömülen Node'a özgüdür: blob'u aynı Node üretir. `main` göreli yazılır: blob derleme
//    makinesinin yolunu (kullanıcı adı) taşımasın.
const seaConfig = join(work, "sea-config.json");
const blob = join(work, "sea-prep.blob");
await writeFile(seaConfig, `${JSON.stringify({ main: "perafly.cjs", output: "sea-prep.blob", disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: true }, null, 2)}\n`);
run(nodeBin, ["--experimental-sea-config", "sea-config.json"], { cwd: work });

// 3. Node'un kopyası + blob
await rm(output, { force: true });
await copyFile(nodeBin, output);
await chmod(output, 0o755);
if (process.platform === "darwin") run("codesign", ["--remove-signature", output]);
const { default: postject } = await import("postject");
await postject.inject(output, "NODE_SEA_BLOB", await readFile(blob), {
    sentinelFuse: SEA_FUSE,
    ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {})
});
// Ad-hoc imza: yalnız çalışabilsin diye. Dağıtım imzası ve notarization ayrı iştir (README §8).
if (process.platform === "darwin") run("codesign", ["--sign", "-", "--force", output]);

const bytes = await readFile(output);
const sha256 = createHash("sha256").update(bytes).digest("hex");
process.stdout.write(
    `${relative(root, output)}  ${(bytes.length / 1024 / 1024).toFixed(1)} MB  node ${nodeInfo.version}  perafly ${pkg.version}\nsha256 ${sha256}\n`
);
