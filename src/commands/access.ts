/**
 * Erişim, paylaşım ve alan adları (backend docs/API.md §19.6). Proje `--project` ya da bağlı klasörden; yalnız tam
 * profilli takım anahtarı yazabilir (ajan profili siteyi açamaz ya da paylaşamaz).
 *
 *   perafly share                       erişim durumu: mod, bağlantı, parola, kişiler, bekleyen istekler
 *   perafly share public|private        modu değiştirir (herkese açmak onay ister)
 *   perafly share link [--revoke]       yeni paylaşım bağlantısı (bir kez gösterilir) ya da kapatma
 *   perafly share password [--clear]    ziyaretçi parolası stdin'den (argüman olarak alınmaz)
 *   perafly share add|rm <e-posta>      kişiyle paylaşır ya da paylaşımı kaldırır
 *   perafly domains ls|add|check|rm     özel alan adları ve kurulacak DNS kayıtları
 *
 * Paylaşım bağlantısı sırdır: insan çıktısında bilerek gösterilir, `--json`'da ve loglarda karartılır.
 */
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { requireConfirmation, table } from "../output/index.js";
import { readSecretFromStdin } from "../auth/token.js";

const enc = encodeURIComponent;

const target = async (ctx: Context) => {
    const t = await ctx.requireProjectTarget();
    if (t.anonymous) throw new CliError("validation_error", "Sharing and domains are for team projects. Claim this project first.", { exitCode: 2, recovery: "perafly projects claim" });
    const { client } = await ctx.requireApiKey();
    return { ref: t.ref, client };
};

const accessText = (a: any): string => {
    const rows = [
        ["Access", a.mode === "private" ? "Private: team, shared people, link or password" : "Public: anyone with the address"],
        ["Share link", a.link?.active ? `On (${a.link.prefix}…)` : "Off"],
        ["Password", a.password?.set ? "Set" : "Off"],
        ["People", a.people?.length ? a.people.map((p: any) => p.email).join(", ") : "—"]
    ];
    const pending = (a.requests ?? []).length;
    return `${table(rows)}${pending ? `\n\n${pending} access request${pending === 1 ? "" : "s"} waiting. Answer them in the Perafly panel.` : ""}`;
};

export const shareStatus = async (ctx: Context) => {
    const { ref, client } = await target(ctx);
    const a = (await client.get<any>(`/v1/projects/${enc(ref)}/access`, { operationId: "getProjectAccess" })).data;
    ctx.output.success(a, () => accessText(a));
};

export const shareMode = async (ctx: Context, mode: "public" | "private", opts: { yes?: boolean }) => {
    const { ref, client } = await target(ctx);
    if (mode === "public") {
        await requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.env }, `Make ${ref} public? Anyone with the address can open it`, `perafly share public --project ${ref} --yes`);
    }
    const a = (await client.put<any>(`/v1/projects/${enc(ref)}/access`, { operationId: "setProjectAccess", body: { mode } })).data;
    ctx.output.success(a, () => (mode === "public" ? `${ref} is public.` : `${ref} is private. Visitors sign in, use the share link or the password.`));
};

export const shareLink = async (ctx: Context, opts: { revoke?: boolean }) => {
    const { ref, client } = await target(ctx);
    if (opts.revoke) {
        const a = (await client.delete<any>(`/v1/projects/${enc(ref)}/access/link`, { operationId: "revokeShareLink" })).data;
        return ctx.output.success(a, () => "Share link turned off.");
    }
    const out = (await client.post<any>(`/v1/projects/${enc(ref)}/access/link`, { operationId: "createShareLink" })).data;
    ctx.output.success(out, () => "Share link created. It replaces any earlier link and is shown only now:");
    // Bilerek gösterilen tek yer (insan çıktısı); `--json`'da karartılır
    ctx.output.raw(out.url);
};

export const sharePassword = async (ctx: Context, opts: { clear?: boolean }) => {
    const { ref, client } = await target(ctx);
    if (opts.clear) {
        const a = (await client.delete<any>(`/v1/projects/${enc(ref)}/access/password`, { operationId: "clearSharePassword" })).data;
        return ctx.output.success(a, () => "Password removed.");
    }
    const password = await readSecretFromStdin({ prompt: "Visitor password (8–72 characters): ", stdin: ctx.deps.stdin as NodeJS.ReadStream | undefined });
    if (password.length < 8 || password.length > 72) throw new CliError("validation_error", "The password must be 8 to 72 characters.", { exitCode: 2 });
    const a = (await client.put<any>(`/v1/projects/${enc(ref)}/access/password`, { operationId: "setSharePassword", body: { password } })).data;
    ctx.output.success(a, () => "Password set. Visitors can open the site with it.");
};

export const shareAdd = async (ctx: Context, email: string) => {
    const { ref, client } = await target(ctx);
    const a = (await client.post<any>(`/v1/projects/${enc(ref)}/access/people`, { operationId: "addProjectShare", body: { email } })).data;
    ctx.output.success(a, () => `Shared with ${email.trim().toLowerCase()}. They sign in to Perafly with that address.`);
};

export const shareRemove = async (ctx: Context, who: string) => {
    const { ref, client } = await target(ctx);
    let id = who;
    if (!/^shr_[0-9a-z]{24}$/.test(who)) {
        const a = (await client.get<any>(`/v1/projects/${enc(ref)}/access`, { operationId: "getProjectAccess" })).data;
        const found = (a.people ?? []).find((p: any) => p.email === who.trim().toLowerCase());
        if (!found) throw new CliError("share_not_found", `Not shared with ${who}.`, { exitCode: 20 });
        id = found.id;
    }
    const a = (await client.delete<any>(`/v1/projects/${enc(ref)}/access/people/${enc(id)}`, { operationId: "removeProjectShare" })).data;
    ctx.output.success(a, () => "Removed. Their open session ends now.");
};

/* ─── Alan adları ─── */

const STATUS: Record<string, string> = { active: "Active", pending: "Waiting for DNS", failed: "Not verified in 7 days" };

export const domainSetup = (d: any): string => {
    const lines: string[] = [];
    if (d.status === "active") return `${d.name} is active and serves the live version.`;
    const records = (d.dns?.records ?? []) as any[];
    if (records.length) lines.push("Add this record at your DNS provider:", table(records.map((r) => [r.type, r.name, r.value]), ["TYPE", "NAME", "VALUE"]));
    const verification = (d.verification ?? []) as any[];
    if (verification.length) lines.push("", "The domain is used elsewhere. Prove it's yours with:", table(verification.map((v) => [v.type, v.domain, v.value]), ["TYPE", "NAME", "VALUE"]));
    lines.push("", `Then check it: perafly domains check ${d.name}`);
    return lines.join("\n");
};

export const domainsLs = async (ctx: Context) => {
    const { ref, client } = await target(ctx);
    const rows: any[] = (await client.get<any>(`/v1/projects/${enc(ref)}/domains`, { operationId: "listProjectDomains" })).data.data ?? [];
    ctx.output.success(rows, () => (rows.length ? table(rows.map((d) => [d.name, STATUS[d.status] ?? d.status, (d.dns?.records ?? []).map((r: any) => `${r.type} ${r.name} → ${r.value}`).join(", ")]), ["DOMAIN", "STATUS", "DNS"]) : "No custom domains. Add one: perafly domains add www.example.com"));
};

export const domainsAdd = async (ctx: Context, name: string) => {
    const { ref, client } = await target(ctx);
    const d = (await client.post<any>(`/v1/projects/${enc(ref)}/domains`, { operationId: "addProjectDomain", body: { name } })).data;
    ctx.output.success(d, () => `Added ${d.name}.\n\n${domainSetup(d)}`);
};

export const domainsCheck = async (ctx: Context, name: string) => {
    const { ref, client } = await target(ctx);
    const d = (await client.post<any>(`/v1/projects/${enc(ref)}/domains/${enc(name)}/check`, { operationId: "checkProjectDomain" })).data;
    ctx.output.success(d, () => `${d.name}: ${STATUS[d.status] ?? d.status}\n\n${domainSetup(d)}`);
};

export const domainsRm = async (ctx: Context, name: string, opts: { yes?: boolean }) => {
    const { ref, client } = await target(ctx);
    await requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.env }, `Disconnect ${name}? It stops serving the site`, `perafly domains rm ${name} --project ${ref} --yes`);
    await client.delete<any>(`/v1/projects/${enc(ref)}/domains/${enc(name)}`, { operationId: "removeProjectDomain" });
    ctx.output.success({ removed: name }, () => `Disconnected ${name}.`);
};
