/**
 * Belirteç seçimi ve okuma (README §3.1, §3.3, §9). GÜVENLİK SINIRI.
 *
 * Belirteç asla komut argümanından alınmaz: API anahtarı `PERAFLY_TOKEN` ya da `login --token-stdin` ile, hesapsız
 * projenin anahtarı `PERAFLY_CLAIM_TOKEN` ya da `.perafly/state.json` ile gelir. Kayıtlı giriş yalnız verildiği API
 * adresinde kullanılır.
 */
import { CliError } from "../errors.js";
import { loadCredential, matchesApiUrl, type StoredCredential } from "./store.js";

export const API_KEY_RE = /^pfa_[0-9A-Za-z]{32}$/;
export const PROJECT_KEY_RE = /^pfc_[0-9A-Za-z]{32}$/;
export const HANDOFF_RE = /\bpfh_[0-9A-Za-z]{16,}\b/;

export const isApiKey = (v: unknown): v is string => typeof v === "string" && API_KEY_RE.test(v);
export const isProjectKey = (v: unknown): v is string => typeof v === "string" && PROJECT_KEY_RE.test(v);

export type ApiKeySource = "env" | "keyring" | "plaintext" | "folder";

export interface ResolvedApiKey {
    token: string;
    source: ApiKeySource;
    /** Kayıtlı girişte meta veri (takım, kullanıcı, profil, bitiş); ortam değişkeninde null */
    credential: StoredCredential | null;
}

/**
 * `PERAFLY_TOKEN` → kayıtlı giriş (aynı API adresi) → `dir` verilmişse klasörün ajan anahtarı (sahiplenmede
 * `--keep-publishing`; yalnız o projede geçerli) → null. Kişinin girişi klasör anahtarının önüne geçer.
 */
export const resolveApiKey = async (opts: { profile: string; apiUrl: string; env?: NodeJS.ProcessEnv; dir?: string }): Promise<ResolvedApiKey | null> => {
    const env = opts.env ?? process.env;
    const fromEnv = env.PERAFLY_TOKEN?.trim();
    if (fromEnv) {
        if (!isApiKey(fromEnv)) {
            throw new CliError("auth_required", isProjectKey(fromEnv) ? "PERAFLY_TOKEN holds a project key (pfc_…). Use PERAFLY_CLAIM_TOKEN for project keys." : "PERAFLY_TOKEN is not a Perafly API key (pfa_…).", { exitCode: 10 });
        }
        return { token: fromEnv, source: "env", credential: null };
    }
    const stored = await loadCredential(opts.profile);
    if (!stored || !matchesApiUrl(stored.credential, opts.apiUrl)) {
        if (!opts.dir) return null;
        const { resolveFolderApiKey } = await import("../publish/state.js");
        const folder = await resolveFolderApiKey({ dir: opts.dir, apiUrl: opts.apiUrl });
        return folder ? { token: folder.token, source: "folder", credential: null } : null;
    }
    if (stored.credential.expiresAt && Date.parse(stored.credential.expiresAt) <= Date.now()) {
        throw new CliError("credential_expired", "Your sign-in expired. Run perafly login.", { exitCode: 10, recovery: "perafly login" });
    }
    return { token: stored.credential.token, source: stored.backend, credential: stored.credential };
};

/** Komut argümanlarında sır var mı (yanlışlıkla `--token pfa_…` ya da devir bağlantısı): varsa komut çalışmadan düşer */
export const assertNoSecretInArgv = (argv: readonly string[]) => {
    for (const arg of argv) {
        if (HANDOFF_RE.test(arg)) throw new CliError("handoff_link_in_argv", "Handoff links are read from stdin, not from arguments: echo \"$LINK\" | perafly login --handoff", { exitCode: 2 });
        // Sır olan bütün belirteçler: API anahtarı, proje anahtarı, SFTP parolası, gizli veri anahtarı, kanca sırrı, OAuth
        // erişim ve yenileme belirteci, paylaşım bağlantısı, devir. Yayınlanabilir veri anahtarı (`pfp_`) sır değildir.
        if (/\bpf[acskworlh]_[0-9A-Za-z]{16,}\b/.test(arg)) {
            throw new CliError("validation_error", "Keys are never passed as arguments. Use PERAFLY_TOKEN, PERAFLY_CLAIM_TOKEN or perafly login --token-stdin.", { exitCode: 2 });
        }
    }
};

/**
 * stdin'den tek bir sır okur. Borudan gelirse sonuna kadar okur; terminalse yankısız sorar. Uzunluk sınırlıdır ve
 * çıktıya hiçbir şey yazılmaz (yalnız soru stderr'e).
 */
/**
 * `keepWhitespace`: borudan gelen değerin yalnız sondaki satır sonu atılır (ortam değişkeni değeri baştaki ve sondaki
 * boşluğunu korur); varsayılan bütün kenar boşluklarını atar (anahtar ve parola).
 */
export const readSecretFromStdin = async (opts: { prompt?: string; stdin?: NodeJS.ReadStream; stderr?: NodeJS.WriteStream; maxBytes?: number; keepWhitespace?: boolean } = {}): Promise<string> => {
    const stdin = opts.stdin ?? process.stdin;
    const stderr = opts.stderr ?? process.stderr;
    const max = opts.maxBytes ?? 4096;
    if (!stdin.isTTY) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stdin) {
            const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += b.length;
            if (size > max) throw new CliError("validation_error", "Input on stdin is too long", { exitCode: 2 });
            chunks.push(b);
        }
        const text = Buffer.concat(chunks).toString("utf8");
        return opts.keepWhitespace ? text.replace(/\r?\n$/, "") : text.trim();
    }
    return new Promise<string>((resolve, reject) => {
        let value = "";
        stderr.write(opts.prompt ?? "Token: ");
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        const done = (err: Error | null) => {
            stdin.setRawMode?.(false);
            stdin.pause();
            stdin.removeListener("data", onData);
            stderr.write("\n");
            if (err) reject(err);
            else resolve(opts.keepWhitespace ? value : value.trim());
        };
        const onData = (s: string) => {
            for (const ch of s) {
                if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(null);
                if (ch === "\u0003") return done(new CliError("cancelled", "Cancelled", { exitCode: 130 }));
                if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
                else if (value.length < max) value += ch;
            }
        };
        stdin.on("data", onData);
    });
};
