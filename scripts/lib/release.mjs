/**
 * Yayın betiklerinin saf parçaları (README §8): platform adı, ikili adı, SHA256SUMS biçimi, Homebrew formülü ve
 * `packaging/release.json` doğrulaması. Dosya sistemi, ağ ve süreç yok; test/release.test.ts sınar.
 */

/** Yayımlanan ikililer: GitHub Actions matrisi (.github/workflows/release.yml) bununla aynıdır */
export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"];

/** Homebrew formülünün istediği ikililer (Windows yok) */
export const FORMULA_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

const OS = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCH = { x64: "x64", arm64: "arm64" };

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const ASSET_RE = /^[A-Za-z0-9._-]+$/;

/** `process.platform` + `process.arch` → `darwin-arm64`; yayımlanmayan birleşimde hata */
export const targetFor = (platform, arch) => {
    const os = OS[platform];
    const cpu = ARCH[arch];
    const target = os && cpu ? `${os}-${cpu}` : null;
    if (!target || !TARGETS.includes(target)) {
        throw new Error(`Unsupported platform ${platform}-${arch}. Binaries exist for ${TARGETS.join(", ")}.`);
    }
    return target;
};

/** `windows-x64` → `perafly-windows-x64.exe`, `darwin-arm64` → `perafly-darwin-arm64` */
export const binaryName = (target) => {
    if (!TARGETS.includes(target)) throw new Error(`Unknown target: ${target}`);
    return `perafly-${target}${target.startsWith("windows-") ? ".exe" : ""}`;
};

/** Yayımlanan ikili adlarından biri mi (SHA256SUMS'a yalnız bunlar girer) */
export const isBinaryAsset = (name) => TARGETS.some((t) => binaryName(t) === name);

/** `{ name, sha256 }` listesi → GNU `sha256sum` biçimi (iki boşluk), ada göre sıralı, sonda satır sonu */
export const formatSha256Sums = (entries) => {
    const seen = new Set();
    const lines = [...entries]
        .map(({ name, sha256 }) => {
            const hex = String(sha256).toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Not a SHA-256 digest for ${name}`);
            if (!ASSET_RE.test(name)) throw new Error(`Invalid file name in SHA256SUMS: ${name}`);
            if (seen.has(name)) throw new Error(`Duplicate file in SHA256SUMS: ${name}`);
            seen.add(name);
            return { name, hex };
        })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(({ name, hex }) => `${hex}  ${name}`);
    return lines.length ? `${lines.join("\n")}\n` : "";
};

/**
 * SHA256SUMS → `Map<ad, özet>`. Hem metin (`özet  ad`) hem ikili kip (`özet *ad`) satırı okunur; boş satır atlanır.
 * Bozuk satır, yol içeren ad ve yinelenen ad hata verir: özet dosyası sessizce yarım okunmaz.
 */
export const parseSha256Sums = (text) => {
    const sums = new Map();
    String(text)
        .split("\n")
        .forEach((raw, index) => {
            const line = raw.replace(/\r$/, "");
            if (!line.trim()) return;
            const m = /^([0-9A-Fa-f]{64}) [ *](.+)$/.exec(line);
            if (!m) throw new Error(`SHA256SUMS line ${index + 1} is malformed`);
            const name = m[2];
            if (!ASSET_RE.test(name)) throw new Error(`SHA256SUMS line ${index + 1}: invalid file name`);
            if (sums.has(name)) throw new Error(`SHA256SUMS lists ${name} twice`);
            sums.set(name, m[1].toLowerCase());
        });
    return sums;
};

/** `packaging/release.json` doğrulaması: `{ repository: "sahip/ad", tap: "sahip/homebrew-ad" }` */
export const validateReleaseConfig = (config) => {
    if (!config || typeof config !== "object") throw new Error("release.json must be an object");
    const { repository, tap } = config;
    if (typeof repository !== "string" || !REPOSITORY_RE.test(repository)) throw new Error("release.json: repository must be owner/name");
    if (typeof tap !== "string" || !REPOSITORY_RE.test(tap) || !/\/homebrew-[A-Za-z0-9._-]+$/.test(tap)) {
        throw new Error("release.json: tap must be owner/homebrew-name");
    }
    return { repository, tap };
};

/** `perafly/homebrew-tap` → `perafly/tap` (`brew install perafly/tap/perafly`) */
export const tapShortName = (tap) => tap.replace(/\/homebrew-/, "/");

/** Bir sürümün indirme kökü (GitHub Releases); sonuna `/<dosya>` eklenir */
export const downloadBase = (repository, version) => `https://github.com/${repository}/releases/download/v${version}`;

/**
 * Homebrew formülü şablonunu doldurur (`packaging/homebrew/perafly.rb`). `sums` SHA256SUMS'tan gelen `Map`'tir;
 * formülün dört ikilisinden biri eksikse ya da şablonda doldurulmamış yer tutucu kalırsa hata verir.
 */
export const fillFormula = (template, { version, repository, sums }) => {
    if (!VERSION_RE.test(String(version))) throw new Error(`Invalid version: ${version}`);
    if (!REPOSITORY_RE.test(String(repository))) throw new Error(`Invalid repository: ${repository}`);
    const values = { VERSION: version, REPOSITORY: repository, DOWNLOAD_BASE: downloadBase(repository, version) };
    for (const target of FORMULA_TARGETS) {
        const name = binaryName(target);
        const sha = sums.get(name);
        if (!sha) throw new Error(`SHA256SUMS has no entry for ${name}`);
        values[`SHA256_${target.toUpperCase().replace("-", "_")}`] = sha;
    }
    const out = String(template).replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, key) => {
        if (!(key in values)) throw new Error(`Unknown placeholder in formula template: ${whole}`);
        return values[key];
    });
    return out;
};
