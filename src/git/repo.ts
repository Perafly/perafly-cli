/**
 * Yerel Git deposu işleri (backend docs/API.md §21.5). Git'i `execFile` ile çağırır (kabuk yok); argümanda ve git
 * yapılandırmasında belirteç bulunmaz.
 *
 *   gitRoot(cwd)                         deponun kökü; depo değilse `not_a_git_repository`, git yoksa `git_not_found`
 *   configureRemote(cwd, ad, adres, yardımcı)
 *                                        uzak adresi ekler ya da günceller; yalnız o adresin kökü için kimlik yardımcısı
 *   helperCommand(…)                     Git'in çalıştıracağı `!… git credential` satırı
 *   commitInfo(cwd, sha)                 işlemenin ilk satırı ve yazar adı (CI'da ileti ve yazar ortamda yoksa)
 *
 * Kimlik yardımcısı yalnız `credential.<köken>.helper` olarak, depo yapılandırmasına (`--local`) yazılır. Önce boş değer
 * yazılır: Git bu adres için daha önce tanımlanmış yardımcıları (ör. genel `osxkeychain`) sıfırlar; böylece anahtar
 * başka bir yardımcıya ne sorulur ne de onda saklanır (git docs: gitcredentials, `credential.helper` boş değer).
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError } from "../errors.js";

export interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
}

export const runGit = async (args: readonly string[], cwd: string, timeoutMs = 15_000): Promise<GitResult> => {
    // Olmayan klasörde de `spawn` ENOENT verir: "git yok" denmeden önce klasör denetlenir
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new CliError("validation_error", `Not a folder: ${cwd}`, { exitCode: 2 });
    return new Promise((done, fail) => {
        execFile("git", [...args], { cwd, timeout: timeoutMs, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 4 * 1024 * 1024 }, (error: any, stdout, stderr) => {
            if (error?.code === "ENOENT") {
                fail(new CliError("git_not_found", "Git is not installed or not on PATH.", { exitCode: 1 }));
                return;
            }
            done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        });
    });
};

const must = async (args: readonly string[], cwd: string): Promise<string> => {
    const r = await runGit(args, cwd);
    if (r.code !== 0) throw new CliError("git_command_failed", `git ${args[0]} failed: ${r.stderr.trim().split("\n").pop() || `exit ${r.code}`}`, { exitCode: 1 });
    return r.stdout;
};

/** Çalışma klasörü bir Git deposunda mı; değilse açık bir hata */
export const gitRoot = async (cwd: string): Promise<string> => {
    const r = await runGit(["rev-parse", "--absolute-git-dir"], cwd);
    if (r.code !== 0) {
        throw new CliError("not_a_git_repository", `${cwd} is not in a Git repository. Run this inside your repository (or git init first).`, { exitCode: 2, recovery: "git init" });
    }
    return r.stdout.trim();
};

/** `https://git.perafly.com/acme.git` → `https://git.perafly.com` */
export const urlOrigin = (url: string): string => new URL(url).origin;

const quote = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * Git'in çalıştıracağı satır (Git sona `get|store|erase` ekler; kabukla çalıştırır). Kurulu ikili (`…/bin/perafly`)
 * mutlak yoluyla; `node …/cli.js` ile çalışıyorsa Node ve dosya yoluyla; npx önbelleği geçici olduğundan ya da yol
 * bilinmiyorsa PATH'teki `perafly`. Varsayılan dışı API adresi ve açıkça seçilen profil sabitlenir: yardımcı, uzak
 * adresi kuranla aynı kimliği kullanır. Satırda belirteç yoktur.
 */
export const helperCommand = (opts: { argv1?: string; execPath?: string; apiUrl?: string | null; profile?: string | null } = {}): string => {
    const argv1 = opts.argv1 ?? process.argv[1] ?? "";
    const execPath = opts.execPath ?? process.execPath;
    let bin = "perafly";
    const base = argv1.split(/[\\/]/).pop() ?? "";
    const ephemeral = /[\\/]_npx[\\/]/.test(argv1);
    if (argv1 && !ephemeral && /^(perafly|pf)(\.cmd|\.exe)?$/i.test(base)) bin = quote(resolve(argv1));
    else if (argv1 && !ephemeral && base === "cli.js") bin = `${quote(execPath)} ${quote(resolve(argv1))}`;
    const flags = [opts.apiUrl ? `--api-url ${quote(opts.apiUrl)}` : "", opts.profile ? `--profile ${quote(opts.profile)}` : ""].filter(Boolean).join(" ");
    return `!${bin}${flags ? ` ${flags}` : ""} git credential`;
};

export interface RemoteResult {
    remote: string;
    url: string;
    origin: string;
    action: "added" | "updated" | "unchanged";
}

export const configureRemote = async (cwd: string, name: string, url: string, helper: string): Promise<RemoteResult> => {
    await gitRoot(cwd);
    const names = (await must(["remote"], cwd)).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    let action: RemoteResult["action"] = "added";
    if (names.includes(name)) {
        const current = (await must(["remote", "get-url", name], cwd)).trim();
        action = current === url ? "unchanged" : "updated";
        if (action === "updated") await must(["remote", "set-url", name, url], cwd);
    } else {
        await must(["remote", "add", name, url], cwd);
    }
    const origin = urlOrigin(url);
    const key = `credential.${origin}.helper`;
    // Var olan değerler silinir (yoksa çıkış 5): yeniden çalıştırmak aynı iki satırı bırakır
    const unset = await runGit(["config", "--local", "--unset-all", key], cwd);
    if (unset.code !== 0 && unset.code !== 5) throw new CliError("git_command_failed", `git config failed: ${unset.stderr.trim() || `exit ${unset.code}`}`, { exitCode: 1 });
    await must(["config", "--local", "--add", key, ""], cwd);
    await must(["config", "--local", "--add", key, helper], cwd);
    return { remote: name, url, origin, action };
};

/** İşlemenin ilk satırı ve yazar adı; depo yoksa ya da işleme bulunamazsa boş */
export const commitInfo = async (cwd: string, sha: string): Promise<{ message: string | null; author: string | null }> => {
    try {
        const r = await runGit(["log", "-1", "--format=%s%x1f%an", sha, "--"], cwd, 3000);
        if (r.code !== 0) return { message: null, author: null };
        const [message, author] = r.stdout.replace(/\r?\n$/, "").split("\x1f");
        return { message: message?.trim() || null, author: author?.trim() || null };
    } catch {
        return { message: null, author: null };
    }
};
