/**
 * `api-keys ls|create|revoke` (README §2; backend docs/API.md §15.11). Yalnız tam profilli kişi girişi: ajan kimliği
 * anahtar üretemez (sunucu 403). Sır bir kez gösterilir: etkileşimli terminalde ekrana, değilse yalnız `--out`
 * dosyasına (0600); `--json` çıktısında asla yoktur.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { requireConfirmation, table } from "../output/index.js";

export const ls = async (ctx: Context) => {
    const { client } = await ctx.requireApiKey();
    const res = (await client.get<any>("/v1/api-keys", { operationId: "listApiKeys" })).data;
    ctx.output.success(res.data, () => (res.data.length ? table(res.data.map((k: any) => [k.name, k.id, `${k.prefix}…`, k.lastUsedAt ?? "never used"]), ["NAME", "ID", "PREFIX", "LAST USED"]) : "No API keys."), { pagination: { nextCursor: null } });
};

export const create = async (ctx: Context, name: string, opts: { out?: string }) => {
    if (!opts.out && !ctx.output.interactive) {
        throw new CliError("validation_error", "The secret is shown only once. Run in a terminal, or pass --out <file> to store it.", { exitCode: 2 });
    }
    const { client } = await ctx.requireApiKey();
    const res = (await client.post<any>("/v1/api-keys", { operationId: "createApiKey", body: { name } })).data;
    let file: string | null = null;
    if (opts.out) {
        file = resolve(ctx.cwd, opts.out);
        await writeFile(file, `${res.secret}\n`, { mode: 0o600, flag: "wx" }).catch((error: any) => {
            throw new CliError("validation_error", error?.code === "EEXIST" ? `${opts.out} already exists.` : `Could not write ${opts.out}.`, { exitCode: 2 });
        });
    }
    ctx.output.success({ key: res.key, secretFile: file }, () => {
        if (file) return `Created ${res.key.name} (${res.key.id}). The secret is in ${file}.`;
        return `Created ${res.key.name} (${res.key.id}).`;
    });
    if (!file) ctx.output.raw(`\n  ${res.secret}\n\nCopy it now: it won't be shown again. Store it in your CI's secret store as PERAFLY_TOKEN.`);
};

export const revoke = async (ctx: Context, id: string, opts: { yes?: boolean }) => {
    if (!/^key_[0-9a-z]{24}$/.test(id)) throw new CliError("validation_error", "Pass a key id (key_…).", { exitCode: 2 });
    const { client } = await ctx.requireApiKey();
    await requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.env }, `Revoke ${id}? Anything using it stops working`, `perafly api-keys revoke ${id} --yes`);
    await client.delete(`/v1/api-keys/${encodeURIComponent(id)}`, { operationId: "revokeApiKey" });
    ctx.output.success({ id, revoked: true }, () => `Revoked ${id}.`);
};
