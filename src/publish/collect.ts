/**
 * Yayınlanacak dosyaları toplar (README §2.1, §9). GÜVENLİK SINIRI.
 *
 *   collect(input, options) → { root, files, skipped, cleanup }
 *
 * Girdi: klasör, tek HTML dosyası (`index.html` olarak yayınlanır) ya da `.zip` / `.tar.gz` / `.tgz` arşivi (geçici
 * klasöre güvenle açılır, bkz. archive.ts). Kurallar:
 *   - sembolik bağ izlenmez ve atlanır; düzenli olmayan dosya atlanır; kökün dışına hiçbir yoldan çıkılmaz
 *   - dışlama kuralları (exclude.ts) her zaman; `.gitignore` kuralları `respectGitignore` ile (kaynak yayını)
 *   - ev klasörü ya da dosya sistemi kökü yayınlanmaz (yanlışlıkla bütün belgeleri yayınlamaya karşı)
 *   - gezinme `maxEntries` girdiyle sınırlıdır
 */
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { CliError } from "../errors.js";
import { excludedDirReason, excludedFileReason, invalidPathReason } from "./exclude.js";
import { extractArchive, isArchivePath } from "./archive.js";

export interface CollectedFile {
    /** Bildirimdeki yol: `/` ayraçlı, NFC */
    path: string;
    absPath: string;
    size: number;
}

export interface SkippedEntry {
    path: string;
    reason: string;
}

export interface CollectResult {
    /** Gezilen kök (arşivde geçici klasör) */
    root: string;
    kind: "directory" | "file" | "archive";
    files: CollectedFile[];
    skipped: SkippedEntry[];
    totalBytes: number;
    /** Arşivden açılan geçici klasörü siler; diğerlerinde işlem yapmaz. Her durumda çağrılmalı. */
    cleanup: () => Promise<void>;
}

export interface CollectOptions {
    respectGitignore?: boolean;
    maxEntries?: number;
    /** Arşiv açarken toplam bayt sınırı */
    maxArchiveBytes?: number;
}

const HTML_RE = /\.html?$/i;
const noop = async () => undefined;

const isDangerousRoot = async (root: string): Promise<boolean> => {
    const real = await realpath(root).catch(() => root);
    const home = await realpath(homedir()).catch(() => homedir());
    return real === home || real === resolve("/") || /^[A-Za-z]:\\?$/.test(real);
};

export const collect = async (input: string, options: CollectOptions = {}): Promise<CollectResult> => {
    const abs = resolve(input);
    let st;
    try {
        st = await lstat(abs);
    } catch {
        throw new CliError("validation_error", `Not found: ${input}`, { exitCode: 2 });
    }
    if (st.isSymbolicLink()) throw new CliError("validation_error", `${input} is a symbolic link. Pass the real folder.`, { exitCode: 2 });

    if (st.isFile()) {
        if (HTML_RE.test(abs)) {
            const reason = excludedFileReason(basename(abs));
            if (reason) throw new CliError("validation_error", `${basename(abs)} is never published (${reason})`, { exitCode: 2 });
            return { root: abs, kind: "file", files: [{ path: "index.html", absPath: abs, size: st.size }], skipped: [], totalBytes: st.size, cleanup: noop };
        }
        if (isArchivePath(abs)) {
            const extracted = await extractArchive(abs, { maxBytes: options.maxArchiveBytes, maxEntries: options.maxEntries });
            try {
                const walked = await walk(extracted.root, { ...options, respectGitignore: false });
                return { ...walked, kind: "archive", skipped: [...extracted.skipped, ...walked.skipped], cleanup: extracted.cleanup };
            } catch (error) {
                await extracted.cleanup();
                throw error;
            }
        }
        throw new CliError("validation_error", `${input} is not a folder, an HTML file or a .zip / .tar.gz archive`, { exitCode: 2 });
    }
    if (!st.isDirectory()) throw new CliError("validation_error", `${input} is not a folder`, { exitCode: 2 });
    if (await isDangerousRoot(abs)) {
        throw new CliError("validation_error", "Refusing to publish your home folder or the file system root. Pass the build output folder, e.g. ./dist", { exitCode: 2 });
    }
    return { ...(await walk(abs, options)), kind: "directory", cleanup: noop };
};

interface Frame { abs: string; rel: string; rules: { base: string; ig: Ignore }[] }

const walk = async (root: string, options: CollectOptions): Promise<Omit<CollectResult, "kind" | "cleanup">> => {
    const maxEntries = options.maxEntries ?? 200_000;
    const files: CollectedFile[] = [];
    const skipped: SkippedEntry[] = [];
    let seen = 0;
    const stack: Frame[] = [{ abs: root, rel: "", rules: [] }];
    while (stack.length) {
        const frame = stack.pop()!;
        let rules = frame.rules;
        if (options.respectGitignore) {
            const gi = await readFile(join(frame.abs, ".gitignore"), "utf8").catch(() => null);
            if (gi !== null) rules = [...rules, { base: frame.rel, ig: ignore().add(gi) }];
        }
        const entries = await readdir(frame.abs, { withFileTypes: true });
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            if (++seen > maxEntries) {
                throw new CliError("validation_error", `More than ${maxEntries} entries in the folder. Publish the build output folder, not the whole project.`, { exitCode: 2 });
            }
            const name = entry.name.normalize("NFC");
            const rel = frame.rel ? `${frame.rel}/${name}` : name;
            const abs = join(frame.abs, entry.name);
            const invalid = invalidPathReason(rel);
            if (invalid) {
                skipped.push({ path: rel, reason: invalid });
                continue;
            }
            if (entry.isSymbolicLink()) {
                skipped.push({ path: rel, reason: "symbolic link" });
                continue;
            }
            if (entry.isDirectory()) {
                const reason = excludedDirReason(name);
                if (reason) {
                    skipped.push({ path: `${rel}/`, reason });
                    continue;
                }
                if (ignoredBy(rules, rel, true)) {
                    skipped.push({ path: `${rel}/`, reason: "gitignore" });
                    continue;
                }
                stack.push({ abs, rel, rules });
                continue;
            }
            if (!entry.isFile()) {
                skipped.push({ path: rel, reason: "not a regular file" });
                continue;
            }
            const reason = excludedFileReason(rel);
            if (reason) {
                skipped.push({ path: rel, reason });
                continue;
            }
            if (ignoredBy(rules, rel, false)) {
                skipped.push({ path: rel, reason: "gitignore" });
                continue;
            }
            // readdir ile lstat arasında yer değiştirmeye karşı yeniden denetim: bağa dönüşen giriş atlanır
            const st = await lstat(abs);
            if (!st.isFile()) {
                skipped.push({ path: rel, reason: "not a regular file" });
                continue;
            }
            if (!abs.startsWith(root.endsWith(sep) ? root : root + sep)) {
                skipped.push({ path: rel, reason: "outside the folder" });
                continue;
            }
            files.push({ path: rel, absPath: abs, size: st.size });
        }
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { root, files, skipped, totalBytes: files.reduce((n, f) => n + f.size, 0) };
};

/** Git kuralı: en derindeki `.gitignore` önce gelir; olumsuzlama (`!yol`) üst kuralı geçersiz kılar */
const ignoredBy = (rules: Frame["rules"], rel: string, isDir: boolean): boolean => {
    for (let i = rules.length - 1; i >= 0; i--) {
        const { base, ig } = rules[i]!;
        const local = base ? rel.slice(base.length + 1) : rel;
        if (!local) continue;
        const r = ig.test(isDir ? `${local}/` : local);
        if (r.unignored) return false;
        if (r.ignored) return true;
    }
    return false;
};
