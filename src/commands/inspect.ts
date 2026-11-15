/**
 * `perafly inspect <adres>` (README §2; backend docs/API.md §15.3 `GET /v1/lookup?url=`, operationId `lookupUrl`): bir
 * Perafly adresinin türü (canlı, sürüm, dal önizlemesi, özel alan adı, depolama dosyası), projesi, canlı sürümü ve
 * adres bir sürümü gösteriyorsa o sürüm. Yalnız bu kimliğin göreceği proje döner; başkası ve bilinmeyen adres 404.
 *
 * Kimlik: takım anahtarı, yoksa bu klasörün hesapsız projesinin anahtarı (`pfc_`). Sunucu metni terminale `safeText`
 * ile yazılır.
 */
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { table } from "../output/index.js";
import { safeText } from "./shared.js";

const KIND: Record<string, string> = {
    live: "live URL",
    version: "version URL",
    branch: "branch preview",
    domain: "custom domain",
    storage: "storage file"
};

const versionLabel = (v: any) => (v ? `${v.number ? `v${v.number}` : safeText(v.id, 40)}${v.state ? ` (${safeText(v.state, 20)}${v.live ? ", live" : ""})` : ""}` : "—");

export const describeLookup = (r: any): string => {
    const p = r?.project ?? {};
    const live = p.liveVersion ? `v${p.liveVersion.number ?? "?"}${p.urls?.live ? `  ${safeText(p.urls.live, 200)}` : ""}` : "nothing live yet";
    const rows: string[][] = [
        ["Kind", KIND[r?.kind] ?? safeText(r?.kind, 20)],
        ["Project", `${safeText(p.name, 80)} (${safeText(p.id, 40)})`],
        ...(p.title ? [["Title", safeText(p.title, 120)]] : []),
        ["Live", live]
    ];
    if (r?.version) rows.push(["Version", `${versionLabel(r.version)}${r.version.url ? `  ${safeText(r.version.url, 200)}` : ""}`]);
    if (r?.branch) rows.push(["Branch", safeText(r.branch, 120)]);
    if (p.anonymous) rows.push(["Without account", `expires ${safeText(p.anonymous.expiresAt, 40)}`]);
    if (p.takenDown) rows.push(["Status", "taken down by Perafly"]);
    return table(rows);
};

export const inspect = async (ctx: Context, address: string) => {
    const url = (address ?? "").trim();
    if (!url) throw new CliError("validation_error", "Pass a Perafly address, for example perafly inspect my-site--v3.perafly.app", { exitCode: 2 });
    if (url.length > 2000) throw new CliError("validation_error", "The address is longer than 2000 characters.", { exitCode: 2 });
    const key = await ctx.apiKey();
    const token = key?.token ?? (await ctx.projectKey())?.token;
    if (!token) throw ctx.authRequired();
    let res: any;
    try {
        res = (await ctx.client(token).get<any>("/v1/lookup", { operationId: "lookupUrl", query: { url } })).data;
    } catch (error) {
        // Sunucu başka takımın projesini, bilinmeyen adresi ve olmayan sürümü aynı 404 ile ayırt etmeden döner
        if (error instanceof CliError && error.status === 404) {
            throw new CliError(error.code, `${url} is not a Perafly project (or version) this sign-in can see.`, { status: 404, type: error.type, title: error.title, requestId: error.requestId, details: error.details });
        }
        if (error instanceof CliError && error.status === 400) {
            throw new CliError(error.code, `Not a Perafly address: ${url}. Pass a live, version, branch preview, custom domain or storage file URL.`, { status: 400, exitCode: 2, type: error.type, title: error.title, requestId: error.requestId, details: error.details });
        }
        throw error;
    }
    ctx.output.success(res, () => describeLookup(res));
};
