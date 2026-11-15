/**
 * Kimlik ve hesap komutları (README §2): login, logout, whoami, teams ls, profiles, switch.
 * operationId: startDeviceAuthorization, pollDeviceAuthorization, logout, getMe.
 */
import { hostname } from "node:os";
import { CliError } from "../errors.js";
import type { Context } from "../context.js";
import { deleteCredential, loadCredential, saveCredential, type AccessProfile } from "../auth/store.js";
import { isApiKey, readSecretFromStdin } from "../auth/token.js";
import { startDeviceLogin, waitForDeviceToken } from "../auth/device.js";
import { readConfig, updateProfile, writeConfig, writeProjectLink } from "../config/index.js";
import { saveFolderApiKey } from "../publish/state.js";
import { openUrl } from "../open.js";
import { table } from "../output/index.js";

const ACCESS: readonly AccessProfile[] = ["full", "agent", "read"];

export interface LoginOptions {
    access?: string;
    tokenStdin?: boolean;
    browser?: boolean;
    handoff?: boolean;
}

/**
 * `login --handoff`: devir bağlantısı (`pfh_…`) stdin'den okunur, projeye bağlı ajan anahtarına çevrilir ve bu klasöre
 * (`.perafly/state.json`, 0600) saklanır; klasör projeye bağlanır. Kişinin profil girişine dokunulmaz.
 */
const loginWithHandoff = async (ctx: Context) => {
    const raw = await readSecretFromStdin({ prompt: "Handoff link: ", stdin: ctx.deps.stdin as NodeJS.ReadStream | undefined });
    const token = /pfh_[0-9A-Za-z]{32}/.exec(raw)?.[0];
    if (!token) throw new CliError("validation_error", "That is not a Perafly handoff link (…#pfh_…).", { exitCode: 2 });
    const out = (await ctx.client(null).post<any>("/v1/auth/handoff", { operationId: "exchangeHandoff", body: { token } })).data;
    await saveFolderApiKey(ctx.cwd, { token: out.token, projectId: out.project.id, apiUrl: ctx.apiUrl });
    await writeProjectLink(ctx.cwd, { projectId: out.project.id, projectName: out.project.name, teamId: out.team?.id ?? null, apiUrl: ctx.apiUrl });
    ctx.output.success({ project: out.project, team: out.team, access: out.access, expiresAt: out.expiresAt, store: "folder" }, () => `This folder can now publish to ${out.project.name} (team ${out.team?.name ?? "?"}) with agent access. The key is stored in .perafly/state.json and works only for this project.`);
};

export const login = async (ctx: Context, opts: LoginOptions) => {
    const out = ctx.output;
    if (opts.access !== undefined && !ACCESS.includes(opts.access as AccessProfile)) throw new CliError("validation_error", "--access must be full, agent or read", { exitCode: 2 });
    const access = (opts.access as AccessProfile | undefined) ?? (out.agent ? "agent" : "full");
    if (opts.handoff) return loginWithHandoff(ctx);
    let credential;
    if (opts.tokenStdin) {
        const token = await readSecretFromStdin({ prompt: "Perafly API key: ", stdin: ctx.deps.stdin as NodeJS.ReadStream | undefined });
        if (!isApiKey(token)) throw new CliError("validation_error", "That is not a Perafly API key (pfa_…).", { exitCode: 2 });
        const me = await ctx.client(token).get<any>("/v1/me", { operationId: "getMe" });
        if (me.data.kind !== "apiKey") throw new CliError("validation_error", "That key is not a team API key.", { exitCode: 2 });
        credential = {
            token, apiUrl: ctx.apiUrl, keyId: me.data.key?.id ?? null, access: (me.data.key?.access as AccessProfile) ?? null, expiresAt: null,
            team: me.data.team ? { id: me.data.team.id, name: me.data.team.name, slug: me.data.team.slug ?? null } : null,
            user: me.data.user ? { id: me.data.user.id, name: me.data.user.name, email: me.data.user.email ?? null } : null,
            createdAt: new Date().toISOString()
        };
    } else {
        const start = await startDeviceLogin(ctx.apiUrl, { clientName: `Perafly CLI on ${hostname()}`.slice(0, 80), access }, { fetch: ctx.deps.fetch });
        out.notice(`To sign in, open ${start.verificationUri} and enter the code ${start.userCode}`);
        out.notice("Check that the browser shows the same code. Waiting for approval…");
        if (out.interactive && opts.browser !== false) await (ctx.deps.openUrl ?? openUrl)(start.verificationUriComplete);
        const token = await waitForDeviceToken(ctx.apiUrl, start, { fetch: ctx.deps.fetch, sleep: ctx.deps.sleep });
        credential = { token: token.token, apiUrl: ctx.apiUrl, keyId: token.key?.id ?? null, access: token.access, expiresAt: token.expiresAt, team: token.team, user: token.user, createdAt: new Date().toISOString() };
    }
    const store = await saveCredential(ctx.settings.profile, credential);
    await updateProfile(ctx.settings.profile, { apiUrl: ctx.apiUrl, teamId: credential.team?.id ?? null, teamName: credential.team?.name ?? null });
    const data = { profile: ctx.settings.profile, store, access: credential.access, expiresAt: credential.expiresAt, team: credential.team, user: credential.user ? { id: credential.user.id, name: credential.user.name, email: credential.user.email } : null };
    out.success(data, () => `Logged in${credential.user?.email ? ` as ${credential.user.email}` : ""}${credential.team ? ` (team ${credential.team.name})` : ""}. Access: ${credential.access ?? "full"}. Stored in the ${store === "keyring" ? "system keyring" : "credentials file"}.`);
};

export const logout = async (ctx: Context) => {
    const stored = await loadCredential(ctx.settings.profile);
    let revoked = false;
    if (stored) {
        try {
            await ctx.client(stored.credential.token).post("/v1/auth/logout", { operationId: "logout" });
            revoked = true;
        } catch (error) {
            // Süresi dolmuş ya da iptal edilmiş anahtar: yerel kayıt yine silinir
            if (!(error instanceof CliError) || (error.status !== 401 && error.status !== 403)) ctx.output.warn(`The key could not be revoked on the server (${(error as Error).message}). It is removed locally.`);
        }
    }
    const removed = await deleteCredential(ctx.settings.profile);
    if (ctx.env.PERAFLY_TOKEN) ctx.output.warn("PERAFLY_TOKEN is set in the environment and was not revoked. Unset it, or revoke the key in team settings.");
    ctx.output.success({ profile: ctx.settings.profile, removed, revoked }, () => (removed ? `Logged out of profile ${ctx.settings.profile}.` : `Profile ${ctx.settings.profile} was not logged in.`));
};

export const whoami = async (ctx: Context) => {
    const key = await ctx.apiKey();
    if (!key) {
        const pk = await ctx.projectKey();
        if (!pk) throw ctx.authRequired();
        const me = await ctx.client(pk.token).get<any>("/v1/me", { operationId: "getMe" });
        ctx.output.success({ ...me.data, source: pk.source }, () => `Project key for ${me.data.project?.name} (${me.data.project?.id}). Not signed in.`);
        return;
    }
    const me = await ctx.client(key.token).get<any>("/v1/me", { operationId: "getMe" });
    const d = me.data;
    ctx.output.success({ ...d, profile: ctx.settings.profile, source: key.source, expiresAt: key.credential?.expiresAt ?? null }, () =>
        table([
            ["User", d.user ? `${d.user.name}${d.user.email ? ` <${d.user.email}>` : ""}` : "—"],
            ["Team", d.team ? `${d.team.name} (${d.team.id})` : "—"],
            ["Role", d.role ?? "—"],
            ["Access", d.key?.access ?? "—"],
            ["Key", d.key ? `${d.key.name} (${d.key.prefix}…, ${d.key.kind})` : "—"],
            ...(d.project ? [["Project", `${d.project.name} (${d.project.id})`]] : []),
            ["Profile", `${ctx.settings.profile} (${key.source})`],
            ["API", ctx.apiUrl]
        ])
    );
};

export const teamsLs = async (ctx: Context) => {
    const config = await readConfig();
    const key = await ctx.apiKey();
    const current = key ? (await ctx.client(key.token).get<any>("/v1/me", { operationId: "getMe" })).data.team : null;
    const rows = Object.entries(config.profiles)
        .filter(([, p]) => p.teamId)
        .map(([name, p]) => ({ id: p.teamId!, name: p.teamName ?? "", profile: name, current: name === ctx.settings.profile }));
    if (current && !rows.some((r) => r.id === current.id)) rows.unshift({ id: current.id, name: current.name, profile: ctx.settings.profile, current: true });
    ctx.output.success(rows, () => (rows.length ? `${table(rows.map((r) => [r.current ? "*" : " ", r.name, r.id, r.profile]), [" ", "TEAM", "ID", "PROFILE"])}\n\nA CLI key belongs to one team. Use perafly login --profile <name> for another team.` : "No teams. Run perafly login."));
};

export const profilesLs = async (ctx: Context) => {
    const config = await readConfig();
    const rows = Object.entries(config.profiles).map(([name, p]) => ({ name, apiUrl: p.apiUrl ?? null, teamId: p.teamId ?? null, teamName: p.teamName ?? null, default: name === config.defaultProfile }));
    ctx.output.success(rows, () => (rows.length ? table(rows.map((r) => [r.default ? "*" : " ", r.name, r.teamName ?? "—", r.apiUrl ?? "—"]), [" ", "PROFILE", "TEAM", "API"]) : "No profiles. Run perafly login."));
};

export const switchTeam = async (ctx: Context, team?: string) => {
    const config = await readConfig();
    const entries = Object.entries(config.profiles);
    if (!team) {
        await profilesLs(ctx);
        return;
    }
    const match = entries.find(([name, p]) => name === team || p.teamId === team || p.teamName?.toLowerCase() === team.toLowerCase());
    if (!match) {
        throw new CliError("no_team_selected", `No profile is signed in to ${team}.`, { exitCode: 2, recovery: `perafly login --profile ${team.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 32) || "team"}`, suggestions: entries.map(([, p]) => p.teamName ?? "").filter(Boolean) });
    }
    config.defaultProfile = match[0];
    await writeConfig(config);
    ctx.output.success({ profile: match[0], teamId: match[1].teamId ?? null, teamName: match[1].teamName ?? null }, () => `Default profile is now ${match[0]}${match[1].teamName ? ` (${match[1].teamName})` : ""}.`);
};
