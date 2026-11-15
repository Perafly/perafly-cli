/**
 * Yerel durum dosyası `.perafly/state.json` (README §3.2). GÜVENLİK SINIRI: hesapsız projenin anahtarı (`pfc_…`) yalnız
 * burada durur. Dosya 0600 izinle atomik yazılır ve klasörün `.gitignore`'una eklenir; hiçbir yoldan yüklenmez
 * (collect `.perafly/`'ı atlar, sunucu da reddeder). `PERAFLY_CLAIM_TOKEN` dosyanın önüne geçer.
 */
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CliError } from "../errors.js";
import { isApiKey, isProjectKey } from "../auth/token.js";
import { matchesApiUrl } from "../auth/store.js";

export interface AnonymousProjectState {
    projectId: string;
    projectName: string | null;
    projectKey: string;
    apiUrl: string;
    liveUrl: string | null;
    expiresAt: string | null;
    claimDeadline: string | null;
    createdAt: string;
}

/** Sahiplenmede `--keep-publishing` ile verilen, yalnız bu projeye yetkili ajan anahtarı (`pfa_…`) */
export interface FolderApiKeyState {
    token: string;
    projectId: string;
    apiUrl: string;
    createdAt: string;
}

export interface LocalState {
    version: 1;
    anonymous?: AnonymousProjectState;
    projectApiKey?: FolderApiKeyState;
    /** Komutların önbelleği (sır içermez) */
    cache?: Record<string, unknown>;
}

export const STATE_REL = ".perafly/state.json";
export const statePath = (dir: string) => join(dir, ".perafly", "state.json");

export const readState = async (dir: string): Promise<LocalState> => {
    let raw: string;
    try {
        raw = await readFile(statePath(dir), "utf8");
    } catch (error: any) {
        if (error?.code === "ENOENT") return { version: 1 };
        throw error;
    }
    try {
        const s = JSON.parse(raw);
        const state: LocalState = { version: 1, cache: s?.cache && typeof s.cache === "object" ? s.cache : undefined };
        const a = s?.anonymous;
        if (a && isProjectKey(a.projectKey) && typeof a.projectId === "string" && typeof a.apiUrl === "string") state.anonymous = a;
        const k = s?.projectApiKey;
        if (k && isApiKey(k.token) && typeof k.projectId === "string" && typeof k.apiUrl === "string") state.projectApiKey = k;
        return state;
    } catch {
        throw new CliError("validation_error", `${STATE_REL} is not valid JSON. Fix or delete it.`, { exitCode: 2 });
    }
};

export const writeState = async (dir: string, state: LocalState): Promise<void> => {
    await mkdir(join(dir, ".perafly"), { recursive: true });
    await ensureGitignored(dir);
    const file = statePath(dir);
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
    await chmod(file, 0o600).catch(() => undefined);
};

export const saveAnonymousProject = async (dir: string, project: Omit<AnonymousProjectState, "createdAt"> & { createdAt?: string }) => {
    if (!isProjectKey(project.projectKey)) throw new CliError("invalid_response", "The API returned an unexpected project key", { exitCode: 1 });
    const state = await readState(dir);
    state.anonymous = { ...project, createdAt: project.createdAt ?? new Date().toISOString() };
    await writeState(dir, state);
};

export const clearAnonymousProject = async (dir: string) => {
    const state = await readState(dir);
    if (!state.anonymous) return false;
    delete state.anonymous;
    await writeState(dir, state);
    return true;
};

/**
 * Sahiplenme sonucu: proje anahtarı silinir; ajan anahtarı verildiyse aynı dosyada (0600, işlenmez) saklanır. Anahtar
 * ekrana ve `--json`'a yazılmaz; bu klasörde giriş yapılmamışsa belirteç seçimi onu kullanır (auth/token.ts).
 */
export const saveClaimResult = async (dir: string, result: { projectId: string; apiUrl: string; agentKey?: string | null }) => {
    const state = await readState(dir);
    delete state.anonymous;
    if (result.agentKey) {
        if (!isApiKey(result.agentKey)) throw new CliError("invalid_response", "The API returned an unexpected agent key", { exitCode: 1 });
        state.projectApiKey = { token: result.agentKey, projectId: result.projectId, apiUrl: result.apiUrl, createdAt: new Date().toISOString() };
    }
    await writeState(dir, state);
};

/** Devir bağlantısından gelen, projeye bağlı ajan anahtarı (`login --handoff`): bu klasöre saklanır */
export const saveFolderApiKey = async (dir: string, key: { token: string; projectId: string; apiUrl: string }) => {
    if (!isApiKey(key.token)) throw new CliError("invalid_response", "The API returned an unexpected key", { exitCode: 1 });
    const state = await readState(dir);
    state.projectApiKey = { token: key.token, projectId: key.projectId, apiUrl: key.apiUrl, createdAt: new Date().toISOString() };
    await writeState(dir, state);
};

/** Bu klasörün ajan anahtarı (aynı API adresi) ya da null */
export const resolveFolderApiKey = async (opts: { dir: string; apiUrl: string }): Promise<FolderApiKeyState | null> => {
    const state = await readState(opts.dir);
    return state.projectApiKey && matchesApiUrl(state.projectApiKey, opts.apiUrl) ? state.projectApiKey : null;
};

export interface ResolvedProjectKey {
    token: string;
    source: "env" | "state";
    /** Durum dosyasındaysa proje bilgisi; ortam değişkeninde null (sunucu `GET /v1/me` ile söyler) */
    project: AnonymousProjectState | null;
}

/** `PERAFLY_CLAIM_TOKEN` → bu klasörün `.perafly/state.json`'u (aynı API adresi) → null */
export const resolveProjectKey = async (opts: { dir: string; apiUrl: string; env?: NodeJS.ProcessEnv }): Promise<ResolvedProjectKey | null> => {
    const env = opts.env ?? process.env;
    const fromEnv = env.PERAFLY_CLAIM_TOKEN?.trim();
    if (fromEnv) {
        if (!isProjectKey(fromEnv)) throw new CliError("auth_required", "PERAFLY_CLAIM_TOKEN is not a project key (pfc_…).", { exitCode: 10 });
        return { token: fromEnv, source: "env", project: null };
    }
    const state = await readState(opts.dir);
    if (!state.anonymous || !matchesApiUrl(state.anonymous, opts.apiUrl)) return null;
    return { token: state.anonymous.projectKey, source: "state", project: state.anonymous };
};

/** `.perafly/state.json`'u klasörün `.gitignore`'una ekler (zaten kapsanıyorsa dokunmaz) */
export const ensureGitignored = async (dir: string): Promise<boolean> => {
    const file = join(dir, ".gitignore");
    let current = "";
    try {
        current = await readFile(file, "utf8");
    } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
    }
    const lines = current.split(/\r?\n/).map((l) => l.trim());
    const covered = lines.some((l) => [".perafly/state.json", "/.perafly/state.json", ".perafly", ".perafly/", "/.perafly", "/.perafly/", ".perafly/*"].includes(l));
    if (covered) return false;
    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    await writeFile(file, `${current}${prefix}# Perafly: local state holds the project key; never commit it\n${STATE_REL}\n`);
    return true;
};
