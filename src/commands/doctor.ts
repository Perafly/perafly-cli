/**
 * `perafly doctor` (README §2): yerel kurulumu denetler, her satır OK / WARN / FAIL ve öneri.
 *
 *   Node.js, CLI sürümü ve kurulum türü, API adresi ve erişilebilirliği (kimliksiz `GET /v1/plans`, süre), profil ve
 *   takım, kimlik deposu (anahtar zinciri / düz dosya ve izni), girişin geçerliliği (`GET /v1/me`), klasörün proje bağı
 *   (`GET /v1/projects/{id}`), `perafly.jsonc`, Git'te Perafly itme adresi ve kimlik yardımcısı, ajan istemcilerinde
 *   MCP yapılandırması ve beceri.
 *
 * Ağ isteği yalnız API'ye gider. Anahtarın değeri hiçbir satıra, `--json`'a ya da hataya yazılmaz (yalnız istemciye
 * verilir); metinler ayrıca `redact`'ten geçer. FAIL varsa rapordan sonra `doctor_check_failed` (çıkış 1, README §4.2).
 * Yapılandırma okunamazsa (bozuk `config.json` ya da `.perafly/project.json`) rapor yine yazılır.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../errors.js";
import { Context, type ContextDeps, type GlobalFlags } from "../context.js";
import { Output, table } from "../output/index.js";
import { redact } from "../auth/redact.js";
import { normalizeApiUrl, peraflyHome } from "../auth/store.js";
import type { ResolvedApiKey } from "../auth/token.js";
import { PERAFLY_JSONC, readPeraflyConfig, SCHEMA_URL } from "../config/jsonc.js";
import { readState } from "../publish/state.js";
import { isPeraflyTarget } from "../git/credential.js";
import { gitRoot, runGit, urlOrigin } from "../git/repo.js";
import { skillSource } from "../mcp/install.js";
import { VERSION } from "../version.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
    id: string;
    title: string;
    status: CheckStatus;
    message: string;
    hint: string | null;
}

const MIN_NODE = 22;
const TIMEOUT_MS = 10_000;

const check = (id: string, title: string, status: CheckStatus, message: string, hint: string | null = null): Check => ({ id, title, status, message: redact(message), hint: hint ? redact(hint) : null });

/** Tek dosya ikilide (scripts/build-binary.mjs) derlemede `true`; npm paketinde tanımsız */
declare const __PERAFLY_BINARY__: boolean | undefined;

export const installKind = (): { kind: "binary" | "npm" | "npx" | "local"; label: string; path: string } => {
    if (typeof __PERAFLY_BINARY__ === "boolean" && __PERAFLY_BINARY__) return { kind: "binary", label: "single-file binary", path: process.execPath };
    let self = "";
    try {
        self = fileURLToPath(import.meta.url);
    } catch {
        self = process.argv[1] ?? "";
    }
    if (/[\\/]_npx[\\/]/.test(self)) return { kind: "npx", label: "npx (temporary)", path: self };
    if (/[\\/]node_modules[\\/]perafly[\\/]/.test(self)) return { kind: "npm", label: "npm package", path: self };
    return { kind: "local", label: "local build", path: self };
};

const nodeCheck = (): Check => {
    const v = process.versions.node;
    const major = Number(v.split(".")[0]);
    return major >= MIN_NODE
        ? check("node", "Node.js", "ok", `${v}`)
        : check("node", "Node.js", "fail", `${v}: Perafly needs Node.js ${MIN_NODE} or later`, `Install Node.js ${MIN_NODE}+ (nodejs.org), or use the single-file binary`);
};

const cliCheck = (): Check => {
    const i = installKind();
    return check("cli", "CLI", "ok", `${VERSION}, ${i.label} (${i.path})`);
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `perafly` PATH'te mi (ajan istemcisi `perafly mcp`'yi adıyla başlatır); süreç çalıştırılmaz */
const onPath = (env: NodeJS.ProcessEnv, name = "perafly"): boolean => {
    const names = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];
    for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
        if (!dir || !isAbsolute(dir)) continue;
        for (const n of names) if (existsSync(join(dir, n))) return true;
    }
    return false;
};

/* ─── API ─── */

const apiCheck = async (ctx: Context): Promise<{ row: Check; reachable: boolean }> => {
    const started = Date.now();
    try {
        const res = await ctx.client(null).get<any>("/v1/plans", { operationId: "listPlans", signal: AbortSignal.timeout(TIMEOUT_MS) });
        const ms = Date.now() - started;
        if (!Array.isArray(res.data?.data)) return { row: check("api", "API", "warn", `${ctx.apiUrl} answered (${ms} ms), but not like the Perafly API`, "Check --api-url / PERAFLY_API_URL"), reachable: true };
        return { row: check("api", "API", "ok", `${ctx.apiUrl} reachable (${ms} ms)`), reachable: true };
    } catch (error) {
        if (error instanceof CliError && error.status) {
            if (error.status === 429) return { row: check("api", "API", "warn", `${ctx.apiUrl} is rate limiting this address (HTTP 429)`, "Try again in a minute"), reachable: true };
            const looksWrong = error.status === 404 || error.status === 405;
            return {
                row: check("api", "API", "fail", `${ctx.apiUrl} answered HTTP ${error.status}${looksWrong ? ": this doesn't look like the Perafly API" : ""}`, looksWrong ? "Check --api-url / PERAFLY_API_URL" : "Try again later; status: https://perafly.com/status"),
                reachable: error.status < 500
            };
        }
        return { row: check("api", "API", "fail", `Can't reach ${ctx.apiUrl}`, "Check your network, proxy or --api-url / PERAFLY_API_URL"), reachable: false };
    }
};

/* ─── Kimlik ─── */

const octal = (mode: number) => `0${(mode & 0o777).toString(8)}`;

interface CredentialOutcome {
    store: Check;
    key: ResolvedApiKey | null;
    keyError: unknown;
}

const credentialCheck = async (ctx: Context): Promise<CredentialOutcome> => {
    // Düz dosyanın izni okunmadan önce alınır: depo okurken geniş izni 0600'e daraltır (src/auth/store.ts)
    const file = join(peraflyHome(), "credentials", `${ctx.settings.profile}.json`);
    const before = process.platform === "win32" ? null : await stat(file).catch(() => null);
    let key: ResolvedApiKey | null = null;
    let keyError: unknown = null;
    try {
        key = await ctx.apiKey();
    } catch (error) {
        keyError = error;
    }
    const title = "Credential store";
    if (keyError instanceof CliError && keyError.code === "credential_keyring_unavailable") {
        return { store: check("store", title, "fail", keyError.message, "Unlock the system keyring, or set PERAFLY_CREDENTIAL_STORE=plaintext and run perafly login"), key, keyError };
    }
    if (keyError) {
        return { store: check("store", title, "ok", ctx.env.PERAFLY_TOKEN ? "PERAFLY_TOKEN (environment variable)" : before ? `credentials file ${file}` : "a saved sign-in"), key, keyError };
    }
    if (!key) return { store: check("store", title, "ok", "nothing saved"), key, keyError };
    if (key.source === "env") return { store: check("store", title, "ok", "PERAFLY_TOKEN (environment variable)"), key, keyError };
    if (key.source === "keyring") return { store: check("store", title, "ok", "system keyring"), key, keyError };
    if (key.source === "folder") return { store: check("store", title, "ok", "this folder's agent key (.perafly/state.json)"), key, keyError };
    if (process.platform === "win32") return { store: check("store", title, "ok", `credentials file ${file}`), key, keyError };
    const after = await stat(file).catch(() => null);
    if (after && after.mode & 0o077) {
        return { store: check("store", title, "fail", `credentials file ${file} is readable by others (${octal(after.mode)})`, `chmod 600 ${file}`), key, keyError };
    }
    if (before && before.mode & 0o077) {
        return { store: check("store", title, "warn", `credentials file ${file} was readable by others (${octal(before.mode)}); perafly changed it to ${after ? octal(after.mode) : "0600"}`, "If others use this computer, run perafly logout and perafly login"), key, keyError };
    }
    return { store: check("store", title, "ok", `credentials file ${file} (${after ? octal(after.mode) : "0600"})`), key, keyError };
};

interface SignIn {
    row: Check;
    me: any | null;
    token: string | null;
}

const signInCheck = async (ctx: Context, cred: CredentialOutcome, apiReachable: boolean): Promise<SignIn> => {
    const title = "Sign-in";
    if (cred.keyError) {
        const e = cred.keyError;
        return { row: check("signin", title, "fail", errorMessage(e), e instanceof CliError && e.recovery ? e.recovery : "perafly login"), me: null, token: null };
    }
    if (!cred.key) {
        const pk = await ctx.projectKey().catch(() => null);
        if (!pk) return { row: check("signin", title, "warn", "not signed in", "perafly login (or set PERAFLY_TOKEN)"), me: null, token: null };
        if (!apiReachable) return { row: check("signin", title, "warn", "not signed in; this folder has a project key (not checked: the API is unreachable)"), me: null, token: pk.token };
        try {
            const me = (await ctx.client(pk.token).get<any>("/v1/me", { operationId: "getMe", signal: AbortSignal.timeout(TIMEOUT_MS) })).data;
            return { row: check("signin", title, "ok", `not signed in; this folder publishes to ${me?.project?.name ?? "a project"} without an account`, "perafly projects claim keeps it in your team"), me, token: pk.token };
        } catch (error) {
            if (error instanceof CliError && error.status === 401) return { row: check("signin", title, "warn", "not signed in; this folder's project key no longer works (claimed, expired or deleted)", "perafly login"), me: null, token: null };
            return { row: check("signin", title, "warn", `not signed in; could not check this folder's project key: ${errorMessage(error)}`), me: null, token: pk.token };
        }
    }
    const key = cred.key;
    if (!apiReachable) return { row: check("signin", title, "warn", "signed in (not checked: the API is unreachable)"), me: null, token: key.token };
    try {
        const me = (await ctx.client(key.token).get<any>("/v1/me", { operationId: "getMe", signal: AbortSignal.timeout(TIMEOUT_MS) })).data;
        const who = me?.user ? `${me.user.name ?? "?"}${me.user.email ? ` <${me.user.email}>` : ""}` : "key";
        const parts = [who, me?.team?.name ? `team ${me.team.name}` : null, me?.key?.access ? `${me.key.access} access` : null, key.credential?.expiresAt ? `expires ${key.credential.expiresAt}` : null, me?.project ? `limited to ${me.project.name}` : null];
        return { row: check("signin", title, "ok", `valid: ${parts.filter(Boolean).join(", ")}`), me, token: key.token };
    } catch (error) {
        if (error instanceof CliError && error.status === 401) return { row: check("signin", title, "fail", "the API rejected the key (revoked, expired or its team membership ended)", "perafly login"), me: null, token: null };
        return { row: check("signin", title, "warn", `could not check the key: ${errorMessage(error)}`), me: null, token: key.token };
    }
};

const profileCheck = (ctx: Context, cred: CredentialOutcome, me: any | null): Check => {
    const team = me?.team?.name ?? cred.key?.credential?.team?.name ?? ctx.settings.profileConfig.teamName ?? null;
    return check("profile", "Profile", "ok", `${ctx.settings.profile}${team ? `, team ${team}` : ""} (${peraflyHome()})`);
};

/* ─── Klasör ─── */

const projectCheck = async (ctx: Context, signIn: SignIn, apiReachable: boolean): Promise<Check> => {
    const title = "Project link";
    const link = ctx.settings.link;
    if (!link) {
        const state = await readState(ctx.cwd).catch(() => null);
        if (state?.anonymous) return check("project", title, "ok", `not linked; this folder has a project without an account (${state.anonymous.projectName ?? state.anonymous.projectId})`, "perafly projects claim");
        return check("project", title, "ok", "this folder is not linked", "perafly link <project> (perafly publish creates a project)");
    }
    const label = `${link.projectName ?? link.projectId} (${link.projectId})`;
    if (link.apiUrl) {
        let linkApi = link.apiUrl;
        try {
            linkApi = normalizeApiUrl(link.apiUrl);
        } catch {
            /* olduğu gibi */
        }
        if (linkApi !== ctx.apiUrl) return check("project", title, "warn", `${label} was linked on ${link.apiUrl}, but this run uses ${ctx.apiUrl}`, "Drop --api-url / PERAFLY_API_URL, or run perafly link again");
    }
    if (!signIn.token || !apiReachable || signIn.me?.kind === "projectKey") return check("project", title, "ok", `${label} (not checked)`);
    try {
        const p = (await ctx.client(signIn.token).get<any>(`/v1/projects/${encodeURIComponent(link.projectId)}`, { operationId: "getProject", signal: AbortSignal.timeout(TIMEOUT_MS) })).data;
        return check("project", title, "ok", `${p?.name ?? label}${p?.urls?.live ? `  ${p.urls.live}` : ""}`);
    } catch (error) {
        if (error instanceof CliError && error.status === 404) return check("project", title, "fail", `${label} doesn't exist, or this sign-in can't see it`, "perafly link <project>, or perafly unlink");
        return check("project", title, "warn", `${label}: could not check (${errorMessage(error)})`);
    }
};

const configCheck = async (ctx: Context): Promise<Check> => {
    try {
        const config = await readPeraflyConfig(ctx.cwd);
        if (!config) return check("config", PERAFLY_JSONC, "ok", "none (optional)", null);
        return check("config", PERAFLY_JSONC, "ok", "valid");
    } catch (error) {
        const pointer = error instanceof CliError && error.pointer ? ` (at ${error.pointer})` : "";
        return check("config", PERAFLY_JSONC, "fail", `${errorMessage(error)}${pointer}`, `Fix it; the schema is ${SCHEMA_URL}`);
    }
};

/* ─── Git ─── */

/** Kimlik yardımcısı satırı: `!<perafly> [--api-url …] [--profile …] git credential` (src/git/repo.ts helperCommand) */
const helperProgram = (helper: string): string | null => {
    const m = /^!\s*(?:'((?:[^']|'\\'')*)'|(\S+))/.exec(helper);
    if (!m) return null;
    return m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2] ?? null;
};

const gitCheck = async (ctx: Context): Promise<Check> => {
    const title = "Git remote";
    try {
        await gitRoot(ctx.cwd);
    } catch (error) {
        if (error instanceof CliError && error.code === "not_a_git_repository") return check("git", title, "ok", "not a Git repository");
        if (error instanceof CliError && error.code === "git_not_found") return check("git", title, "ok", "Git is not installed");
        return check("git", title, "warn", `could not read the repository: ${errorMessage(error)}`);
    }
    const remotes = await runGit(["remote", "-v"], ctx.cwd, 5000).catch(() => null);
    const found: { name: string; url: URL }[] = [];
    for (const line of (remotes?.stdout ?? "").split(/\r?\n/)) {
        const m = /^(\S+)\s+(\S+)\s+\(push\)$/.exec(line.trim());
        if (!m) continue;
        let u: URL;
        try {
            u = new URL(m[2]!);
        } catch {
            continue;
        }
        if (isPeraflyTarget({ protocol: u.protocol.replace(/:$/, ""), host: u.host }, ctx.apiUrl)) found.push({ name: m[1]!, url: u });
    }
    if (!found.length) return check("git", title, "ok", "no Perafly push remote in this repository", ctx.settings.link ? "perafly git remote (push without GitHub)" : null);
    const r = found[0]!;
    // Adresteki kullanıcı adı ve parola hiç yazılmaz
    const shown = `${r.url.protocol}//${r.url.host}${r.url.pathname}`;
    const origin = urlOrigin(r.url.href);
    const cfg = await runGit(["config", "--get-all", `credential.${origin}.helper`], ctx.cwd, 5000).catch(() => null);
    const helpers = (cfg?.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const helper = helpers.find((h) => h.startsWith("!") && /\sgit credential\s*$/.test(h));
    if (!helper) return check("git", title, "warn", `${r.name} → ${shown} has no Perafly credential helper: git push will ask for a password`, `perafly git remote --name ${r.name}`);
    const program = helperProgram(helper);
    if (program && isAbsolute(program) && !existsSync(program)) {
        return check("git", title, "warn", `${r.name} → ${shown}: the credential helper points to ${program}, which no longer exists`, `perafly git remote --name ${r.name}`);
    }
    return check("git", title, "ok", `${r.name} → ${shown}, credential helper set${found.length > 1 ? ` (+${found.length - 1} more remote)` : ""}`);
};

/* ─── Ajan istemcileri ─── */

const readJson = async (file: string): Promise<any | null> => {
    try {
        return JSON.parse(await readFile(file, "utf8"));
    } catch {
        return null;
    }
};

const hasServer = (j: any) => !!(j && typeof j === "object" && j.mcpServers && typeof j.mcpServers === "object" && j.mcpServers.perafly);

export const agentsCheck = async (opts: { home: string; cwd: string; env: NodeJS.ProcessEnv }): Promise<Check> => {
    const title = "Agent clients";
    const { home, cwd } = opts;
    const notes: string[] = [];
    const missing: string[] = [];
    let warn: { message: string; hint: string } | null = null;
    let usesCommand = false;

    // Claude Code: ~/.claude.json (kullanıcı ve yerel kapsam), .mcp.json (proje), beceri ~/.claude/skills ya da .claude/skills
    if (existsSync(join(home, ".claude")) || existsSync(join(home, ".claude.json"))) {
        const user = await readJson(join(home, ".claude.json"));
        const project = await readJson(join(cwd, ".mcp.json"));
        const scopes = [hasServer(user) ? "user" : null, hasServer(user?.projects?.[cwd]) ? "local" : null, hasServer(project) ? "project" : null].filter(Boolean);
        const entry = (hasServer(user) && user.mcpServers.perafly) || (hasServer(user?.projects?.[cwd]) && user.projects[cwd].mcpServers.perafly) || (hasServer(project) && project.mcpServers.perafly) || null;
        if (entry?.command) usesCommand = true;
        let skill = "no skill";
        for (const file of [join(cwd, ".claude", "skills", "perafly", "SKILL.md"), join(home, ".claude", "skills", "perafly", "SKILL.md")]) {
            const installed = await readFile(file, "utf8").catch(() => null);
            if (installed === null) continue;
            const current = await skillSource().catch(() => null);
            if (current !== null && installed !== current) {
                skill = "skill differs from this CLI";
                warn ??= { message: `the perafly skill in ${file} differs from this CLI's version (older, or edited)`, hint: "perafly setup agent --agent claude-code --force (replaces local edits)" };
            } else skill = "skill current";
            break;
        }
        if (scopes.length || skill !== "no skill") notes.push(`claude-code: ${scopes.length ? `MCP (${scopes.join(", ")})` : "no MCP"}, ${skill}`);
        else missing.push("claude-code");
    }
    // Cursor: ~/.cursor/mcp.json ya da .cursor/mcp.json
    if (existsSync(join(home, ".cursor"))) {
        const user = await readJson(join(home, ".cursor", "mcp.json"));
        const project = await readJson(join(cwd, ".cursor", "mcp.json"));
        const scopes = [hasServer(user) ? "user" : null, hasServer(project) ? "project" : null].filter(Boolean);
        if ((hasServer(user) && user.mcpServers.perafly.command) || (hasServer(project) && project.mcpServers.perafly.command)) usesCommand = true;
        if (scopes.length) notes.push(`cursor: MCP (${scopes.join(", ")})`);
        else missing.push("cursor");
    }
    // Codex: ~/.codex/config.toml içinde [mcp_servers.perafly]
    if (existsSync(join(home, ".codex"))) {
        const toml = await readFile(join(home, ".codex", "config.toml"), "utf8").catch(() => "");
        const section = /^\s*\[mcp_servers\.perafly\]\s*$/m.exec(toml);
        if (section) {
            const body = toml.slice(section.index).split(/\n\s*\[/)[0] ?? "";
            if (/^\s*command\s*=/m.test(body)) usesCommand = true;
            notes.push("codex: MCP");
        } else missing.push("codex");
    }

    if (!notes.length && !missing.length) return check("agents", title, "ok", "no agent clients found (Claude Code, Cursor, Codex)", "perafly setup agent --agent <client> after installing one");
    if (!notes.length) return check("agents", title, "warn", `Perafly is not set up in ${missing.join(", ")}`, "perafly setup agent");
    const message = [...notes, ...missing.map((m) => `${m}: not set up`)].join("; ");
    if (usesCommand && !onPath(opts.env)) {
        return check("agents", title, "warn", `${message}. perafly is not on PATH, so the client can't start perafly mcp`, "Install perafly globally (npm install -g perafly, Homebrew or the binary)");
    }
    if (warn) return check("agents", title, "warn", `${message}. ${warn.message}`, warn.hint);
    return check("agents", title, "ok", message, missing.length ? `perafly setup agent --agent ${missing[0]}` : null);
};

/* ─── Rapor ─── */

const LABEL: Record<CheckStatus, string> = { ok: "OK", warn: "WARN", fail: "FAIL" };

const render = (output: Output, checks: Check[]): string => {
    const color = { ok: "green", warn: "yellow", fail: "red" } as const;
    const rows = checks.map((c) => [output.paint(color[c.status], LABEL[c.status].padEnd(4)), c.title, c.message]);
    const lines: string[] = [];
    const t = table(rows).split("\n");
    // Öneri, ileti sütununun altına (durum 4 + başlık + iki boşluklu ayraçlar)
    const indent = " ".repeat(2 + 4 + 2 + Math.max(...checks.map((c) => c.title.length)) + 2);
    checks.forEach((c, i) => {
        lines.push(`  ${t[i]}`);
        if (c.hint && c.status !== "ok") lines.push(`${indent}→ ${c.hint}`);
    });
    const fail = checks.filter((c) => c.status === "fail").length;
    const warn = checks.filter((c) => c.status === "warn").length;
    lines.push("", fail ? `${fail} check(s) failed${warn ? `, ${warn} warning(s)` : ""}.` : warn ? `No failures, ${warn} warning(s).` : "All checks passed.");
    return lines.join("\n");
};

export interface DoctorOptions {
    /** Ajan istemcilerinin aranacağı ev klasörü (test); varsayılan HOME */
    home?: string;
}

export const doctor = async (flags: GlobalFlags, deps: ContextDeps = {}, opts: DoctorOptions = {}) => {
    const env = deps.env ?? process.env;
    const checks: Check[] = [nodeCheck(), cliCheck()];
    let ctx: Context | null = null;
    try {
        ctx = await Context.create(flags, deps);
    } catch (error) {
        checks.push(check("settings", "Settings", "fail", errorMessage(error), error instanceof CliError && error.recovery ? error.recovery : "Fix or delete the file named above"));
    }
    const output = ctx?.output ?? new Output({ json: flags.json, env, stdout: deps.stdout, stderr: deps.stderr, stdin: deps.stdin });
    if (ctx) {
        const api = await apiCheck(ctx);
        const cred = await credentialCheck(ctx);
        const signIn = await signInCheck(ctx, cred, api.reachable);
        checks.push(api.row, profileCheck(ctx, cred, signIn.me), cred.store, signIn.row);
        checks.push(await projectCheck(ctx, signIn, api.reachable));
        checks.push(await configCheck(ctx));
        checks.push(await gitCheck(ctx).catch((error) => check("git", "Git remote", "warn", `could not check: ${errorMessage(error)}`)));
        const home = opts.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
        checks.push(await agentsCheck({ home, cwd: ctx.cwd, env }).catch((error) => check("agents", "Agent clients", "warn", `could not check: ${errorMessage(error)}`)));
    }
    const summary = { ok: 0, warn: 0, fail: 0 };
    for (const c of checks) summary[c.status]++;
    output.success({ ok: summary.fail === 0, summary, checks }, () => render(output, checks));
    if (summary.fail) {
        const failed = checks.filter((c) => c.status === "fail").map((c) => c.title);
        throw new CliError("doctor_check_failed", `${failed.length} check(s) failed: ${failed.join(", ")}.`, { exitCode: 1 });
    }
};
