/**
 * Ortam değişkenleri (backend docs/API.md §20.5). Proje `--project` ya da bağlı klasörden; yalnız takım projesinde.
 *
 *   perafly env ls                 değişkenler; gizli değerler hiçbir yanıtta görünmez, sistem değişkenleri işaretli
 *   perafly env set <AD> [--plain] değer stdin'den ya da yankısız sorudan; ASLA komut argümanından. Boşluk korunur
 *                                  (borudan gelende yalnız sondaki satır sonu atılır). `--plain` değeri görünür kılar
 *                                  (`sensitive: false`)
 *   perafly env rm <AD>            onay ister
 *
 * Değişiklik bir sonraki sürümde geçerlidir (barındırıcıya dağıtımdan hemen önce eşitlenir). Ajan profili yazamaz (403).
 */
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { requireConfirmation, table } from "../output/index.js";
import { readSecretFromStdin } from "../auth/token.js";
import { enc, safeText, teamProject, when } from "./shared.js";

const WHAT = "Environment variables";
const KEY_RE = /^[A-Z_][A-Z0-9_]{0,255}$/;
const NEXT = "Changes apply from the next version: publish again to use them.";

const checkKey = (key: string) => {
    if (key.includes("=")) throw new CliError("validation_error", "Pass only the name. The value is read from stdin or a hidden prompt, never from arguments: printf %s \"$VALUE\" | perafly env set NAME", { exitCode: 2 });
    if (!KEY_RE.test(key)) throw new CliError("validation_error", `${key} is not a valid name: use A–Z, 0–9 and _, not starting with a digit.`, { exitCode: 2 });
};

export const ls = async (ctx: Context) => {
    const { ref, client } = await teamProject(ctx, WHAT);
    const res = (await client.get<any>(`/v1/projects/${enc(ref)}/env`, { operationId: "listEnvVars" })).data;
    const rows: any[] = res.data ?? [];
    ctx.output.success(rows, () => (rows.length
        ? `${table(rows.map((v) => [v.key, v.value == null ? (v.sensitive ? "(hidden)" : "—") : safeText(v.value, 48), [v.system ? "system" : "", v.sensitive ? "sensitive" : "plain"].filter(Boolean).join(", "), v.system ? "—" : `${when(v.updatedAt)}${v.updatedBy?.name ? ` by ${safeText(v.updatedBy.name, 32)}` : ""}`]), ["NAME", "VALUE", "KIND", "UPDATED"])}\n\n${NEXT}`
        : "No environment variables. Add one: perafly env set NAME (the value is read from stdin)"), { appliesTo: res.appliesTo ?? "next-version" });
};

export const set = async (ctx: Context, key: string, opts: { plain?: boolean }) => {
    checkKey(key);
    const { ref, client } = await teamProject(ctx, WHAT);
    const value = await readSecretFromStdin({
        prompt: `Value for ${key}${opts.plain ? "" : " (hidden)"}: `,
        stdin: ctx.deps.stdin as NodeJS.ReadStream | undefined,
        stderr: ctx.deps.stderr as NodeJS.WriteStream | undefined,
        maxBytes: 64 * 1024,
        keepWhitespace: true
    });
    if (!value) throw new CliError("validation_error", `No value for ${key}. Pipe it on stdin or type it at the prompt.`, { exitCode: 2 });
    const v = (await client.put<any>(`/v1/projects/${enc(ref)}/env/${enc(key)}`, { operationId: "setEnvVar", body: { value, sensitive: !opts.plain } })).data;
    // Değer insan çıktısına hiç yazılmaz; `--plain` değişkenin değeri `--json`'da sunucunun yanıtındaki gibi görünür
    ctx.output.success(v, () => `Saved ${key}${opts.plain ? " (plain: the value is visible to your team)" : " (sensitive: the value is never shown again)"}.\n${NEXT}`, { appliesTo: "next-version" });
};

export const rm = async (ctx: Context, key: string, opts: { yes?: boolean }) => {
    checkKey(key);
    const { ref, client } = await teamProject(ctx, WHAT);
    await requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.env }, `Remove ${key}? The next version runs without it`, `perafly env rm ${key} --project ${ref} --yes`);
    await client.delete(`/v1/projects/${enc(ref)}/env/${enc(key)}`, { operationId: "deleteEnvVar" });
    ctx.output.success({ key, removed: true }, () => `Removed ${key}.\n${NEXT}`, { appliesTo: "next-version" });
};
