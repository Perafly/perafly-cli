/**
 * Git kimlik yardımcısı (backend docs/API.md §21.5; git docs: gitcredentials, git-credential "helper protocol").
 *
 *   perafly git credential get      stdin'den `anahtar=değer` satırları; yalnız Perafly'ın itme adresi sorulursa stdout'a
 *                                   tam iki satır: `username=perafly`, `password=<pfa_…>`. Başka hiçbir şey yazılmaz.
 *   perafly git credential store    yok sayılır (anahtar CLI'ın kendi deposundadır; Git'e saklatılmaz)
 *   perafly git credential erase    yok sayılır (girişi silmek `perafly logout`'un işidir)
 *
 * GÜVENLİK: anahtar yalnız yapılandırılmış API'nin ana bilgisayarına (yerelde itme `<API>/git/…`) ve onun `git.`
 * kardeşine (`api.perafly.com` → `git.perafly.com`) verilir; protokol de uymalıdır. Anahtar yoksa ya da çözülemezse
 * stdout boş kalır ve çıkış 0'dır: Git sıradaki yolu dener. Tanılama (`PERAFLY_DEBUG`) ve ipucu stderr'e, karartılarak.
 */
import { redact } from "../auth/redact.js";
import type { Context } from "../context.js";

const MAX_INPUT = 64 * 1024;

export interface CredentialTarget {
    protocol: string;
    host: string;
}

/** Git'in gönderdiği girdi: boş satıra ya da sona dek `anahtar=değer`; dizi alanları (`wwwauth[]`, `capability[]`) atlanır */
export const parseCredentialInput = (text: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        if (!line) break;
        const i = line.indexOf("=");
        if (i <= 0) continue;
        const key = line.slice(0, i);
        if (key.endsWith("[]")) continue;
        out[key] = line.slice(i + 1);
    }
    return out;
};

/** Anahtarın verilebileceği adresler: API'nin kendisi ve `api.` ile başlıyorsa `git.` kardeşi (https) */
export const credentialTargets = (apiUrl: string): CredentialTarget[] => {
    const u = new URL(apiUrl);
    const targets: CredentialTarget[] = [{ protocol: u.protocol.replace(/:$/, ""), host: u.host.toLowerCase() }];
    const hostname = u.hostname.toLowerCase();
    if (hostname.startsWith("api.") && hostname.length > 4) targets.push({ protocol: "https", host: `git.${hostname.slice(4)}` });
    return targets;
};

export const isPeraflyTarget = (input: Record<string, string>, apiUrl: string): boolean => {
    const protocol = (input.protocol ?? "").toLowerCase();
    const host = (input.host ?? "").toLowerCase();
    if (!protocol || !host) return false;
    return credentialTargets(apiUrl).some((t) => t.protocol === protocol && t.host === host);
};

const readInput = async (stdin: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string> => {
    // Elle terminalden çalıştırılırsa beklemez
    if (stdin.isTTY) return "";
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stdin as AsyncIterable<Buffer | string>) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += b.length;
        if (size > MAX_INPUT) break;
        chunks.push(b);
    }
    return Buffer.concat(chunks).toString("utf8");
};

/**
 * Yardımcının gövdesi. Hata atmaz: Git yardımcının çıkış kodunu yok sayar; kullanıcıya yalnız stderr'de kısa bir ipucu
 * kalır. stdout'a yalnız yanıtın iki satırı yazılır.
 */
export const credentialHelper = async (ctx: Context, action: string | undefined): Promise<void> => {
    const stdout = (ctx.deps.stdout ?? process.stdout) as NodeJS.WritableStream;
    const stderr = (ctx.deps.stderr ?? process.stderr) as NodeJS.WritableStream;
    const debug = ctx.env.PERAFLY_DEBUG ? (line: string) => stderr.write(`[perafly] ${redact(line)}\n`) : () => undefined;
    const input = await readInput((ctx.deps.stdin ?? process.stdin) as NodeJS.ReadableStream & { isTTY?: boolean });
    if (action !== "get") {
        debug(`git credential ${action ?? "(none)"}: nothing to do`);
        return;
    }
    const fields = parseCredentialInput(input);
    if (!isPeraflyTarget(fields, ctx.apiUrl)) {
        debug(`git credential get: ${fields.protocol ?? "?"}://${fields.host ?? "?"} is not a Perafly push address for ${ctx.apiUrl}; no answer`);
        return;
    }
    let key: Awaited<ReturnType<Context["apiKey"]>>;
    try {
        key = await ctx.apiKey();
    } catch (error) {
        stderr.write(`perafly: ${redact(error instanceof Error ? error.message : String(error))}\n`);
        return;
    }
    if (!key) {
        stderr.write("perafly: not signed in. Run perafly login, or set PERAFLY_TOKEN.\n");
        return;
    }
    stdout.write(`username=perafly\npassword=${key.token}\n`);
    debug(`git credential get: answered for ${fields.protocol}://${fields.host} with the key from ${key.source}`);
};
