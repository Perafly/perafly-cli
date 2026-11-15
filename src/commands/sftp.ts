/**
 * Proje depolamasının SFTP hesapları (backend docs/API.md §20.7). Proje `--project` ya da bağlı klasörden; yalnız
 * takım projesinde. Hesap açmak ve iptal etmek kişinin işidir: ajan ve salt okunur profil 403 alır.
 *
 *   perafly sftp ls                                         hesaplar, bağlanılacak sunucu ve port, plan SFTP içeriyor mu
 *   perafly sftp add <etiket> (--key <dosya.pub> | --password) [--readonly] [--folder <public/…>] [--ip <cidr>]… [--expires <ISO tarih>]
 *   perafly sftp rm <sfa_…|etiket>                          onay ister
 *
 * `--key` yalnız açık anahtar dosyasını (`.pub`) okur; özel anahtar okunmaz ve gönderilmez. `--password` ile üretilen
 * `pfs_` parolası yalnız insan çıktısında bir kez gösterilir: `--json` (ve ajan kipi) ile `--password` istek atılmadan
 * reddedilir (`api-keys create` gibi). CLI SFTP istemcisi değildir: bağlantı `sftp`, FileZilla, Cyberduck ya da WinSCP
 * ile kurulur.
 */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { requireConfirmation, table } from "../output/index.js";
import { enc, safeText, storagePath, teamProject, when } from "./shared.js";

const WHAT = "SFTP accounts";
const ID_RE = /^sfa_[0-9A-Za-z]+$/;
const PUBLIC_KEY_RE = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/;

const base = (ref: string) => `/v1/projects/${enc(ref)}/sftp`;

const scopeText = (s: any) => (s?.mode === "readonly" ? "Read only, all storage" : s?.mode === "folder" ? `Read and write, ${s.folder ?? "?"} only` : "Read and write, all storage");
const STATUS: Record<string, string> = { active: "Active", suspended: "Suspended (plan)", expired: "Expired" };

/** Açık anahtar: `.pub` dosyası, tek satır OpenSSH biçimi. Özel anahtar dosyası açılmadan reddedilir */
const readPublicKey = async (ctx: Context, file: string): Promise<string> => {
    if (!file.toLowerCase().endsWith(".pub")) {
        throw new CliError("validation_error", `Pass the public key file (.pub), e.g. ~/.ssh/id_ed25519.pub. The private key never leaves your computer.`, { exitCode: 2 });
    }
    const abs = resolve(ctx.cwd, file);
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) throw new CliError("validation_error", `Not found: ${file}`, { exitCode: 2 });
    if (st.size > 16 * 1024) throw new CliError("validation_error", `${file} is too large to be a public key.`, { exitCode: 2 });
    const text = await readFile(abs, "utf8");
    if (/PRIVATE KEY/.test(text)) throw new CliError("validation_error", `${file} holds a private key. Pass the public key; the private key stays on your computer.`, { exitCode: 2 });
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (lines.length !== 1 || !PUBLIC_KEY_RE.test(lines[0]!)) throw new CliError("validation_error", `${file} is not one OpenSSH public key (ssh-ed25519 …, ecdsa-sha2-… or ssh-rsa …).`, { exitCode: 2 });
    return lines[0]!;
};

const connectText = (conn: any, username: string) => (conn?.host ? `Connect: sftp${conn.port && conn.port !== 22 ? ` -P ${conn.port}` : ""} ${username}@${conn.host}` : "");

export const ls = async (ctx: Context) => {
    const { ref, client } = await teamProject(ctx, WHAT);
    const res = (await client.get<any>(base(ref), { operationId: "listSftpAccounts" })).data;
    const rows: any[] = res.data ?? [];
    ctx.output.success(rows, () => {
        const lines: string[] = [];
        if (res.available === false) lines.push("SFTP is not included in your plan. A team admin can change the plan in Perafly.", "");
        if (res.connection?.host) lines.push(`Server: ${res.connection.host}, port ${res.connection.port ?? 22}`, "");
        lines.push(rows.length
            ? table(rows.map((a) => [safeText(a.label, 32), a.id, a.username, a.auth === "publicKey" ? `key ${safeText(a.fingerprint ?? "", 24)}`.trim() : "password", scopeText(a.scope), STATUS[a.status] ?? a.status, a.expiresAt ? when(a.expiresAt) : "never", when(a.lastLoginAt)]), ["LABEL", "ID", "USERNAME", "AUTH", "ACCESS", "STATUS", "EXPIRES", "LAST LOGIN"])
            : "No SFTP accounts. Create one: perafly sftp add <label> --key ~/.ssh/id_ed25519.pub");
        return lines.join("\n");
    }, { connection: res.connection ?? null, available: res.available ?? null, pagination: { nextCursor: null } });
};

export const add = async (ctx: Context, label: string, opts: { key?: string; password?: boolean; readonly?: boolean; folder?: string; ip?: string[]; expires?: string }) => {
    if (!!opts.key === !!opts.password) throw new CliError("validation_error", "Pass --key <file.pub> (recommended) or --password: one of them.", { exitCode: 2 });
    if (opts.password && ctx.output.json) {
        throw new CliError("validation_error", "The password is shown only once and never in --json output. Run without --json in a terminal, or use --key <file.pub>.", { exitCode: 2 });
    }
    if (opts.readonly && opts.folder) throw new CliError("validation_error", "Pass --readonly or --folder, not both: a folder account reads and writes only that folder.", { exitCode: 2 });
    let expiresAt: string | undefined;
    if (opts.expires) {
        const t = Date.parse(opts.expires);
        if (!Number.isFinite(t)) throw new CliError("validation_error", "--expires takes an ISO date, e.g. 2026-12-31 or 2026-12-31T18:00:00Z.", { exitCode: 2 });
        expiresAt = new Date(t).toISOString();
    }
    const folder = opts.folder ? storagePath(opts.folder, "folder").replace(/\/+$/, "") : undefined;
    const publicKey = opts.key ? await readPublicKey(ctx, opts.key) : undefined;
    const { ref, client } = await teamProject(ctx, WHAT);
    const body = {
        label,
        ...(publicKey ? { publicKey } : { password: true }),
        ...(opts.readonly ? { scope: { mode: "readonly" } } : folder ? { scope: { mode: "folder", folder } } : {}),
        ...(opts.ip?.length ? { allowedIps: opts.ip } : {}),
        ...(expiresAt ? { expiresAt } : {})
    };
    // Idempotency-Key yok: uç tanımıyor; POST yinelenmez (iki hesap açılmasın)
    const out = (await client.post<any>(base(ref), { operationId: "createSftpAccount", body })).data;
    const conn = out.connection ?? null;
    const a = out.account ?? {};
    ctx.output.success(out, () => {
        const lines = [
            `Created SFTP account ${safeText(a.label, 64)} (${a.id}).`,
            table([
                ["Host", conn?.host ?? "—"],
                ["Port", conn?.port ? String(conn.port) : "—"],
                ["Username", a.username ?? "—"],
                ["Sign-in", a.auth === "publicKey" ? `SSH key ${a.fingerprint ?? ""}`.trim() : "password"],
                ["Access", scopeText(a.scope)],
                ...(a.allowedIps?.length ? [["From", a.allowedIps.join(", ")]] : []),
                ["Expires", a.expiresAt ? when(a.expiresAt) : "never"]
            ])
        ];
        if (conn?.host) lines.push(connectText(conn, a.username ?? ""));
        if (out.password) lines.push("", "Password (shown only now):");
        return lines.join("\n");
    });
    // Bilerek gösterilen tek yer (insan çıktısı); `--json`'a hiç ulaşmaz (yukarıda reddedilir), ulaşsa da karartılır
    if (out.password) ctx.output.raw(`\n  ${out.password}\n\nCopy it now: it won't be shown again.`);
};

export const rm = async (ctx: Context, who: string, opts: { yes?: boolean }) => {
    const { ref, client } = await teamProject(ctx, WHAT);
    let id = who;
    let label = who;
    if (!ID_RE.test(who)) {
        const rows: any[] = (await client.get<any>(base(ref), { operationId: "listSftpAccounts" })).data.data ?? [];
        const found = rows.filter((a) => a.label === who || a.username === who);
        if (!found.length) throw new CliError("sftp_account_not_found", `No SFTP account named ${who}.`, { exitCode: 20, recovery: `perafly sftp ls --project ${ref}` });
        if (found.length > 1) throw new CliError("validation_error", `More than one SFTP account is named ${who}. Pass its id (sfa_…).`, { exitCode: 2, suggestions: found.map((a) => a.id) });
        id = found[0].id;
        label = found[0].label ?? who;
    }
    await requireConfirmation(ctx.output, { yes: opts.yes, env: ctx.env }, `Revoke SFTP account ${label}? Open sessions end and it can't sign in again`, `perafly sftp rm ${id} --project ${ref} --yes`);
    await client.delete(`${base(ref)}/${enc(id)}`, { operationId: "revokeSftpAccount" });
    ctx.output.success({ id, revoked: true }, () => `Revoked ${label === id ? id : `${label} (${id})`}.`);
};
