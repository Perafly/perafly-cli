/**
 * Arşivden yayın (README §2.1): `.zip`, `.tar.gz`, `.tgz` geçici klasöre açılır, sonra klasör gibi toplanır.
 * GÜVENLİK SINIRI (arşiv yol kaçışı ve sıkıştırma bombası):
 *   - mutlak yol, `..`, sürücü harfi, ters eğik çizgi ve denetim karakteri içeren giriş reddedilir; yazılan her yolun
 *     geçici kökün içinde kaldığı ayrıca denetlenir
 *   - sembolik ve sabit bağlar, aygıt dosyaları atlanır (yalnız düzenli dosya ve klasör)
 *   - toplam açılmış bayt ve giriş sayısı sınırlıdır; zip'te bildirilen boyut gerçek boyutla doğrulanır
 *   - şifreli zip girdisi reddedilir
 * Arşivin tek bir üst klasörü varsa kök odur (`site.zip` → `site/…`).
 */
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import yauzl from "yauzl";
import * as tar from "tar";
import { CliError } from "../errors.js";
import type { SkippedEntry } from "./collect.js";
import { invalidPathReason } from "./exclude.js";

export const isArchivePath = (p: string) => /\.(zip|tar\.gz|tgz)$/i.test(p);

export interface ExtractOptions {
    maxBytes?: number;
    maxEntries?: number;
}

export interface Extracted {
    root: string;
    skipped: SkippedEntry[];
    cleanup: () => Promise<void>;
}

const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 20_000;

const sizeText = (n: number) => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${n} bytes`);
const tooLarge = (limit: number) => new CliError("validation_error", `The archive expands to more than ${sizeText(limit)}`, { exitCode: 2 });

/** Arşiv içi yol → güvenli göreli yol ya da null (reddedilir) */
export const safeEntryPath = (raw: string): string | null => {
    if (!raw || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
    let p = raw.normalize("NFC");
    while (p.startsWith("./")) p = p.slice(2);
    p = p.replace(/\/+$/, "");
    if (!p) return null;
    return invalidPathReason(p) ? null : p;
};

const inside = (root: string, target: string) => {
    const r = resolve(root);
    const t = resolve(target);
    return t === r || t.startsWith(r + sep);
};

export const extractArchive = async (file: string, options: ExtractOptions = {}): Promise<Extracted> => {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxEntries = Math.min(options.maxEntries ?? DEFAULT_MAX_ENTRIES, DEFAULT_MAX_ENTRIES * 10);
    const dir = await mkdtemp(join(tmpdir(), "perafly-archive-"));
    const cleanup = () => rm(dir, { recursive: true, force: true });
    try {
        const skipped = /\.zip$/i.test(file) ? await extractZip(file, dir, maxBytes, maxEntries) : await extractTarGz(file, dir, maxBytes, maxEntries);
        return { root: await singleTopFolder(dir), skipped, cleanup };
    } catch (error) {
        await cleanup();
        if (error instanceof CliError) throw error;
        throw new CliError("validation_error", `Could not read the archive: ${(error as Error)?.message || "invalid archive"}`.slice(0, 300), { exitCode: 2 });
    }
};

const singleTopFolder = async (dir: string): Promise<string> => {
    const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.name !== "__MACOSX");
    if (entries.length === 1 && entries[0]!.isDirectory()) return join(dir, entries[0]!.name);
    return dir;
};

/** Akan baytları sayar; sınır aşılınca akışı keser */
const counter = (state: { bytes: number }, limit: number) =>
    new Transform({
        transform(chunk, _enc, cb) {
            state.bytes += chunk.length;
            if (state.bytes > limit) return cb(tooLarge(limit));
            cb(null, chunk);
        }
    });

const openZip = (file: string) =>
    new Promise<yauzl.ZipFile>((res, rej) =>
        yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true } as yauzl.Options, (err, zf) => (err || !zf ? rej(err ?? new Error("invalid zip")) : res(zf)))
    );

const extractZip = async (file: string, dir: string, maxBytes: number, maxEntries: number): Promise<SkippedEntry[]> => {
    const zip = await openZip(file);
    const skipped: SkippedEntry[] = [];
    const state = { bytes: 0 };
    let count = 0;
    await new Promise<void>((resolveAll, rejectAll) => {
        const fail = (e: unknown) => {
            zip.close();
            rejectAll(e);
        };
        zip.on("error", fail);
        zip.on("end", () => resolveAll());
        zip.on("entry", async (entry: yauzl.Entry) => {
            try {
                if (++count > maxEntries) throw new CliError("validation_error", `The archive has more than ${maxEntries} entries`, { exitCode: 2 });
                const name = entry.fileName;
                if (name.startsWith("__MACOSX/")) return zip.readEntry();
                const isDir = name.endsWith("/");
                const rel = safeEntryPath(name);
                if (!rel) {
                    skipped.push({ path: name.slice(0, 200), reason: "unsafe path in archive" });
                    return zip.readEntry();
                }
                const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
                if (unixMode && unixMode !== 0o100000 && unixMode !== 0o040000) {
                    skipped.push({ path: rel, reason: unixMode === 0o120000 ? "symbolic link" : "not a regular file" });
                    return zip.readEntry();
                }
                if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new CliError("validation_error", "Encrypted zip archives are not supported", { exitCode: 2 });
                const target = join(dir, rel);
                if (!inside(dir, target)) {
                    skipped.push({ path: rel, reason: "unsafe path in archive" });
                    return zip.readEntry();
                }
                if (isDir || unixMode === 0o040000) {
                    await mkdir(target, { recursive: true });
                    return zip.readEntry();
                }
                if (state.bytes + entry.uncompressedSize > maxBytes) throw tooLarge(maxBytes);
                await mkdir(dirname(target), { recursive: true });
                const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (err, s) => (err || !s ? rej(err ?? new Error("read failed")) : res(s))));
                await pipeline(stream, counter(state, maxBytes), createWriteStream(target, { flags: "wx", mode: 0o600 }));
                zip.readEntry();
            } catch (error) {
                fail(error);
            }
        });
        zip.readEntry();
    });
    return skipped;
};

const extractTarGz = async (file: string, dir: string, maxBytes: number, maxEntries: number): Promise<SkippedEntry[]> => {
    const skipped: SkippedEntry[] = [];
    // Önce liste: tür, yol ve toplam boyut denetlenir; açma yalnız onaylanan girişleri yazar
    let count = 0;
    let total = 0;
    // Geri çağrıdan atılan hata ayrıştırıcının dışına taşar (yakalanmaz); bu yüzden kaydedilir, liste bitince atılır
    let failure: CliError | null = null;
    const allowed = new Set<string>();
    await tar.t({
        file,
        strict: true,
        onReadEntry: (entry) => {
            if (failure) return;
            count++;
            if (count > maxEntries) {
                failure = new CliError("validation_error", `The archive has more than ${maxEntries} entries`, { exitCode: 2 });
                return;
            }
            const rel = safeEntryPath(entry.path);
            if (!rel || rel.startsWith("__MACOSX/") || rel === "__MACOSX") {
                if (!rel) skipped.push({ path: String(entry.path).slice(0, 200), reason: "unsafe path in archive" });
                return;
            }
            if (entry.type !== "File" && entry.type !== "OldFile" && entry.type !== "Directory") {
                skipped.push({ path: rel, reason: entry.type === "SymbolicLink" ? "symbolic link" : entry.type === "Link" ? "hard link" : "not a regular file" });
                return;
            }
            total += entry.size || 0;
            if (total > maxBytes) {
                failure = tooLarge(maxBytes);
                return;
            }
            allowed.add(entry.path);
        }
    });
    if (failure) throw failure;
    const state = { bytes: 0 };
    await tar.x({
        file,
        cwd: dir,
        strict: true,
        preservePaths: false,
        noChmod: true,
        preserveOwner: false,
        filter: (path, entry: any) => {
            if (!allowed.has(path)) return false;
            const rel = safeEntryPath(path);
            if (!rel || !inside(dir, join(dir, rel))) return false;
            if (entry?.type !== "Directory") {
                state.bytes += entry?.size || 0;
                // Liste aşamasıyla aynı sınır; arşiv iki okuma arasında değiştiyse fazlası yazılmaz
                if (state.bytes > maxBytes) return false;
            }
            return true;
        }
    });
    if (state.bytes > maxBytes) throw tooLarge(maxBytes);
    // Son güvence: açılan ağaçta bağ kalmadığını doğrula (tar sürümleri arası davranış farkına karşı)
    await assertNoLinks(dir);
    return skipped;
};

const assertNoLinks = async (dir: string) => {
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop()!;
        for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            const st = await lstat(p);
            if (st.isSymbolicLink()) await rm(p, { force: true });
            else if (st.isDirectory()) stack.push(p);
        }
    }
};
