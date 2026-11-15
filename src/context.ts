/**
 * Komut bağlamı: genel bayraklar, çıktı, ayarlar, API istemcisi ve kimlik seçimi (README §3.3).
 *
 * Kimlik sırası: API anahtarı (`PERAFLY_TOKEN` → kayıtlı giriş → klasörün ajan anahtarı) → bu klasörün hesapsız
 * projesinin anahtarı (`PERAFLY_CLAIM_TOKEN` → `.perafly/state.json`). Hedef proje hesapsız projeyse onun anahtarı
 * kullanılır (takım anahtarı sahipsiz projeyi göremez).
 */
import { resolve } from "node:path";
import { ApiClient, type FetchLike } from "./api/client.js";
import { resolveApiKey, type ResolvedApiKey } from "./auth/token.js";
import { CliError } from "./errors.js";
import { Output } from "./output/index.js";
import { projectRefFromInput, resolveSettings, type Settings } from "./config/index.js";
import { resolveProjectKey, type ResolvedProjectKey } from "./publish/state.js";

export interface GlobalFlags {
    json?: boolean;
    project?: string;
    team?: string;
    apiUrl?: string;
    profile?: string;
    yes?: boolean;
    cwd?: string;
}

export interface ContextDeps {
    env?: NodeJS.ProcessEnv;
    fetch?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    stdout?: NodeJS.WritableStream & { isTTY?: boolean };
    stderr?: NodeJS.WritableStream & { isTTY?: boolean };
    stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
    /** Tarayıcı açıcı (test) */
    openUrl?: (url: string) => Promise<void>;
}

export type ProjectTarget =
    | { ref: string; source: "flag" | "link" | "single"; anonymous: false }
    | { ref: string; source: "anonymous"; anonymous: true; projectKey: ResolvedProjectKey };

export class Context {
    readonly flags: GlobalFlags;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly output: Output;
    readonly settings: Settings;
    readonly deps: ContextDeps;
    private apiKeyCache: ResolvedApiKey | null | undefined;
    private projectKeyCache: ResolvedProjectKey | null | undefined;

    private constructor(flags: GlobalFlags, settings: Settings, output: Output, deps: ContextDeps, cwd: string) {
        this.flags = flags;
        this.env = deps.env ?? process.env;
        this.cwd = cwd;
        this.output = output;
        this.settings = settings;
        this.deps = deps;
    }

    static async create(flags: GlobalFlags, deps: ContextDeps = {}): Promise<Context> {
        const env = deps.env ?? process.env;
        const output = new Output({ json: flags.json, env, stdout: deps.stdout, stderr: deps.stderr, stdin: deps.stdin });
        const cwd = resolve(flags.cwd ?? process.cwd());
        const settings = await resolveSettings({ profile: flags.profile, apiUrl: flags.apiUrl, cwd, env });
        return new Context(flags, settings, output, deps, cwd);
    }

    get apiUrl() {
        return this.settings.apiUrl;
    }

    client(token: string | null = null): ApiClient {
        return new ApiClient({ apiUrl: this.apiUrl, token, fetch: this.deps.fetch, sleep: this.deps.sleep });
    }

    async apiKey(): Promise<ResolvedApiKey | null> {
        if (this.apiKeyCache === undefined) this.apiKeyCache = await resolveApiKey({ profile: this.settings.profile, apiUrl: this.apiUrl, env: this.env, dir: this.cwd });
        return this.apiKeyCache;
    }

    async projectKey(): Promise<ResolvedProjectKey | null> {
        if (this.projectKeyCache === undefined) this.projectKeyCache = await resolveProjectKey({ dir: this.cwd, apiUrl: this.apiUrl, env: this.env });
        return this.projectKeyCache;
    }

    authRequired(): CliError {
        return new CliError("auth_required", "Sign in first: run perafly login (or set PERAFLY_TOKEN).", { exitCode: 10, recovery: "perafly login" });
    }

    /** Takım anahtarı gerektiren komutlar */
    async requireApiKey(): Promise<{ client: ApiClient; key: ResolvedApiKey }> {
        const key = await this.apiKey();
        if (!key) throw this.authRequired();
        return { client: this.client(key.token), key };
    }

    /**
     * Proje hedefi (README §3.3): --project / PERAFLY_PROJECT → bu klasörün hesapsız projesi (project.json başka
     * projeyi göstermiyorsa) → .perafly/project.json → hesapta tek proje. Bulunamazsa null (`publish` yeni proje açar).
     */
    async projectTarget(opts: { lookupSingle?: boolean } = {}): Promise<ProjectTarget | null> {
        const flag = this.flags.project || this.env.PERAFLY_PROJECT;
        if (flag) return { ref: projectRefFromInput(flag), source: "flag", anonymous: false };
        const pk = await this.projectKey();
        const link = this.settings.link;
        if (pk && (pk.source === "env" || !link || (pk.project && link.projectId === pk.project.projectId))) {
            const ref = pk.project?.projectId ?? (await this.projectIdForKey(pk.token));
            return { ref, source: "anonymous", anonymous: true, projectKey: pk };
        }
        if (link) return { ref: link.projectId, source: "link", anonymous: false };
        if (opts.lookupSingle) {
            const key = await this.apiKey();
            if (key) {
                const res = await this.client(key.token).get<{ data: { id: string; name: string }[] }>("/v1/projects", { operationId: "listProjects", query: { limit: 2 } });
                if (res.data.data.length === 1) return { ref: res.data.data[0]!.id, source: "single", anonymous: false };
                if (res.data.data.length > 1) {
                    throw new CliError("no_project_selected", "More than one project. Pass --project, or run perafly link in this folder.", { exitCode: 2, suggestions: res.data.data.map((p) => p.name), recovery: "perafly link <project>" });
                }
            }
        }
        return null;
    }

    async requireProjectTarget(): Promise<ProjectTarget> {
        const target = await this.projectTarget({ lookupSingle: true });
        if (target) return target;
        if (!(await this.apiKey())) throw this.authRequired();
        throw new CliError("no_project_selected", "No project selected. Pass --project, or run perafly link in this folder.", { exitCode: 2, recovery: "perafly link <project>" });
    }

    /** Hedefe uygun istemci: hesapsız projede `pfc_`, değilse API anahtarı (yoksa ortamdaki `pfc_`) */
    async clientFor(target: ProjectTarget): Promise<ApiClient> {
        if (target.anonymous) return this.client(target.projectKey.token);
        const key = await this.apiKey();
        if (key) return this.client(key.token);
        const pk = await this.projectKey();
        if (pk) return this.client(pk.token);
        throw this.authRequired();
    }

    private async projectIdForKey(token: string): Promise<string> {
        const me = await this.client(token).get<{ project?: { id: string } }>("/v1/me", { operationId: "getMe" });
        if (!me.data.project?.id) throw new CliError("invalid_response", "The project key did not resolve to a project", { exitCode: 1 });
        return me.data.project.id;
    }
}
