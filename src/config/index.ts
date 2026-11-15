/**
 * Yapılandırma ve hedef çözümleme (README §3.1–§3.3).
 *
 *   ~/.perafly/config.json   profiller (API adresi, takım), varsayılan profil; sır yok (anahtar auth/store'da)
 *   .perafly/project.json    klasörün bağlı olduğu proje (işlenir): { projectId, projectName, teamId, apiUrl }
 *
 * API adresi: --api-url → PERAFLY_API_URL → project.json → profil → https://api.perafly.com
 * Profil: --profile → PERAFLY_PROFILE → varsayılan profil → "default"
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CliError } from "../errors.js";
import { normalizeApiUrl, peraflyHome } from "../auth/store.js";

export const DEFAULT_API_URL = "https://api.perafly.com";

export interface ProfileConfig {
    apiUrl?: string;
    teamId?: string | null;
    teamName?: string | null;
}

export interface CliConfig {
    version: 1;
    defaultProfile: string;
    profiles: Record<string, ProfileConfig>;
}

export interface ProjectLink {
    projectId: string;
    projectName?: string | null;
    teamId?: string | null;
    apiUrl?: string | null;
}

const atomicWrite = async (file: string, text: string, mode = 0o600) => {
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, text, { mode, flag: "wx" });
    await rename(tmp, file);
};

export const configPath = () => join(peraflyHome(), "config.json");

export const readConfig = async (): Promise<CliConfig> => {
    try {
        const c = JSON.parse(await readFile(configPath(), "utf8"));
        return { version: 1, defaultProfile: typeof c?.defaultProfile === "string" ? c.defaultProfile : "default", profiles: c?.profiles && typeof c.profiles === "object" ? c.profiles : {} };
    } catch (error: any) {
        if (error?.code === "ENOENT") return { version: 1, defaultProfile: "default", profiles: {} };
        throw new CliError("validation_error", `${configPath()} is not valid JSON. Fix or delete it.`, { exitCode: 2 });
    }
};

export const writeConfig = async (config: CliConfig) => {
    await mkdir(peraflyHome(), { recursive: true, mode: 0o700 });
    await atomicWrite(configPath(), `${JSON.stringify(config, null, 2)}\n`);
};

export const updateProfile = async (profile: string, patch: ProfileConfig, makeDefault = false) => {
    const config = await readConfig();
    config.profiles[profile] = { ...(config.profiles[profile] ?? {}), ...patch };
    if (makeDefault) config.defaultProfile = profile;
    await writeConfig(config);
};

export const removeProfile = async (profile: string) => {
    const config = await readConfig();
    delete config.profiles[profile];
    if (config.defaultProfile === profile) config.defaultProfile = "default";
    await writeConfig(config);
};

/* ─── .perafly/project.json ─── */

export const projectLinkPath = (dir: string) => join(dir, ".perafly", "project.json");

export const readProjectLink = async (dir: string): Promise<ProjectLink | null> => {
    try {
        const j = JSON.parse(await readFile(projectLinkPath(dir), "utf8"));
        return j && typeof j.projectId === "string" ? (j as ProjectLink) : null;
    } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw new CliError("validation_error", ".perafly/project.json is not valid JSON. Fix it or run perafly unlink.", { exitCode: 2 });
    }
};

export const writeProjectLink = async (dir: string, link: ProjectLink) => {
    await mkdir(join(dir, ".perafly"), { recursive: true });
    await atomicWrite(projectLinkPath(dir), `${JSON.stringify(link, null, 2)}\n`, 0o644);
};

export const removeProjectLink = async (dir: string) => {
    const existed = (await readProjectLink(dir)) !== null;
    await rm(projectLinkPath(dir), { force: true });
    return existed;
};

/* ─── Ayarlar ─── */

export interface Settings {
    profile: string;
    apiUrl: string;
    profileConfig: ProfileConfig;
    link: ProjectLink | null;
}

export const resolveSettings = async (opts: { profile?: string; apiUrl?: string; cwd: string; env?: NodeJS.ProcessEnv }): Promise<Settings> => {
    const env = opts.env ?? process.env;
    const config = await readConfig();
    const profile = opts.profile || env.PERAFLY_PROFILE || config.defaultProfile || "default";
    const profileConfig = config.profiles[profile] ?? {};
    const link = await readProjectLink(opts.cwd);
    const raw = opts.apiUrl || env.PERAFLY_API_URL || link?.apiUrl || profileConfig.apiUrl || DEFAULT_API_URL;
    return { profile, apiUrl: normalizeApiUrl(raw), profileConfig, link };
};

/**
 * `--project` değeri: `prj_…`, ad ya da canlı adres (`https://ad.perafly.app`, `ad--v3.perafly.app`). Özel alan adı
 * Faz 8'dedir. Dönen değer API'nin kabul ettiği kimlik ya da addır.
 */
export const projectRefFromInput = (input: string): string => {
    const v = input.trim();
    if (/^prj_[0-9a-z]{24}$/.test(v) || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)) return v;
    try {
        const u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`);
        const label = u.hostname.split(".")[0] ?? "";
        const m = /^([a-z0-9]+(?:-[a-z0-9]+)*?)(?:--v\d+)?$/.exec(label);
        if (m?.[1]) return m[1];
    } catch {
        /* düşer */
    }
    throw new CliError("validation_error", `Not a project id, name or address: ${input}`, { exitCode: 2 });
};
