/**
 * Kimlik bilgisi deposu (README §3.2, §9). GÜVENLİK SINIRI.
 *
 * Önce işletim sisteminin anahtar zinciri (macOS Keychain, Linux Secret Service, Windows Credential Manager;
 * `@napi-rs/keyring`), yoksa `~/.perafly/credentials/<profil>.json` (dosya 0600, klasör 0700). `PERAFLY_CREDENTIAL_STORE`
 * `keyring` ya da `plaintext` ile zorlanır; `keyring` zorlanmışken zincir açılamazsa `credential_keyring_unavailable`.
 *
 * Kayıt profile ve API adresine bağlıdır: anahtar yalnız verildiği API adresine gönderilir (`matchesApiUrl`).
 */
import { mkdir, readFile, rename, rm, stat, chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CliError } from "../errors.js";

export type AccessProfile = "full" | "agent" | "read";

export interface StoredCredential {
    /** `pfa_…` */
    token: string;
    /** Anahtarın verildiği API kökü (normalleştirilmiş) */
    apiUrl: string;
    keyId?: string | null;
    access?: AccessProfile | null;
    expiresAt?: string | null;
    team?: { id: string; name: string; slug?: string | null } | null;
    user?: { id: string; name: string; email?: string | null } | null;
    createdAt: string;
}

export type CredentialBackend = "keyring" | "plaintext";

const SERVICE = "perafly";
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const API_KEY_RE = /^pfa_[0-9A-Za-z]{32}$/;

export const peraflyHome = (): string => process.env.PERAFLY_HOME || join(homedir(), ".perafly");

/** `https://API.perafly.com/` → `https://api.perafly.com`. Yalnız http(s); yol korunur, sondaki eğik çizgi atılır. */
export const normalizeApiUrl = (raw: string): string => {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new CliError("validation_error", `Invalid API URL: ${raw}`, { exitCode: 2 });
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new CliError("validation_error", "The API URL must use https", { exitCode: 2 });
    if (u.username || u.password) throw new CliError("validation_error", "The API URL must not contain credentials", { exitCode: 2 });
    if (u.protocol === "http:" && !isLoopback(u.hostname)) throw new CliError("validation_error", "Plain http is allowed only for localhost", { exitCode: 2 });
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
};

const isLoopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

export const matchesApiUrl = (credential: Pick<StoredCredential, "apiUrl">, apiUrl: string): boolean => {
    try {
        return normalizeApiUrl(credential.apiUrl) === normalizeApiUrl(apiUrl);
    } catch {
        return false;
    }
};

const checkProfile = (profile: string) => {
    if (!PROFILE_RE.test(profile)) throw new CliError("validation_error", `Invalid profile name: ${profile}`, { exitCode: 2 });
};

const credentialFile = (profile: string) => join(peraflyHome(), "credentials", `${profile}.json`);
const account = (profile: string) => `profile:${profile}`;

type KeyringModule = { Entry: new (service: string, user: string) => { setPassword(p: string): void; getPassword(): string | null; deletePassword(): boolean } };
let keyringLoad: Promise<KeyringModule | null> | null = null;
/** Testler gerçek anahtar zincirine dokunmasın diye değiştirilebilir */
export const setKeyringLoaderForTests = (loader: (() => Promise<KeyringModule | null>) | null) => {
    keyringLoad = loader ? loader() : null;
};
const loadKeyring = (): Promise<KeyringModule | null> => {
    if (!keyringLoad) keyringLoad = import("@napi-rs/keyring").then((m: any) => (m?.Entry ? (m as KeyringModule) : m?.default?.Entry ? (m.default as KeyringModule) : null)).catch(() => null);
    return keyringLoad;
};

const mode = (): "keyring" | "plaintext" | "auto" => {
    const v = (process.env.PERAFLY_CREDENTIAL_STORE || "").toLowerCase();
    if (v === "keyring" || v === "plaintext") return v;
    if (v) throw new CliError("validation_error", "PERAFLY_CREDENTIAL_STORE must be keyring or plaintext", { exitCode: 2 });
    return "auto";
};

const keyringUnavailable = () =>
    new CliError("credential_keyring_unavailable", "The system keyring is locked or unavailable. Unlock it, or set PERAFLY_CREDENTIAL_STORE=plaintext.", { exitCode: 10 });

const parse = (raw: string | null): StoredCredential | null => {
    if (!raw) return null;
    try {
        const c = JSON.parse(raw);
        if (!c || typeof c !== "object" || typeof c.token !== "string" || !API_KEY_RE.test(c.token) || typeof c.apiUrl !== "string") return null;
        return c as StoredCredential;
    } catch {
        return null;
    }
};

const writePlaintext = async (profile: string, credential: StoredCredential) => {
    const dir = join(peraflyHome(), "credentials");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
    const file = credentialFile(profile);
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    // Önce 0600 ile yazılır, sonra yerine taşınır: dosya hiçbir an geniş izinle diskte durmaz
    await writeFile(tmp, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
    await chmod(file, 0o600).catch(() => undefined);
};

const readPlaintext = async (profile: string): Promise<StoredCredential | null> => {
    const file = credentialFile(profile);
    let raw: string;
    try {
        raw = await readFile(file, "utf8");
    } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
    if (process.platform !== "win32") {
        const s = await stat(file);
        // Başkasının okuyabildiği dosya daraltılır (ssh'nin aksine reddetmiyoruz: kullanıcı kilitlenmesin)
        if (s.mode & 0o077) await chmod(file, 0o600).catch(() => undefined);
    }
    return parse(raw);
};

/** Kaydeder; kullanılan depoyu döner. Anahtar zincirine yazılınca eski düz dosya silinir. */
export const saveCredential = async (profile: string, credential: StoredCredential): Promise<CredentialBackend> => {
    checkProfile(profile);
    if (!API_KEY_RE.test(credential.token)) throw new CliError("validation_error", "Not a Perafly API key", { exitCode: 2 });
    const m = mode();
    if (m !== "plaintext") {
        const kr = await loadKeyring();
        if (kr) {
            try {
                new kr.Entry(SERVICE, account(profile)).setPassword(JSON.stringify(credential));
                await rm(credentialFile(profile), { force: true });
                return "keyring";
            } catch {
                if (m === "keyring") throw keyringUnavailable();
            }
        } else if (m === "keyring") {
            throw keyringUnavailable();
        }
    }
    await writePlaintext(profile, credential);
    return "plaintext";
};

export const loadCredential = async (profile: string): Promise<{ credential: StoredCredential; backend: CredentialBackend } | null> => {
    checkProfile(profile);
    const m = mode();
    if (m !== "plaintext") {
        const kr = await loadKeyring();
        if (kr) {
            try {
                const c = parse(new kr.Entry(SERVICE, account(profile)).getPassword());
                if (c) return { credential: c, backend: "keyring" };
            } catch {
                if (m === "keyring") throw keyringUnavailable();
            }
        } else if (m === "keyring") {
            throw keyringUnavailable();
        }
    }
    const c = await readPlaintext(profile);
    return c ? { credential: c, backend: "plaintext" } : null;
};

/** İki depodan da siler; bir şey silindiyse true */
export const deleteCredential = async (profile: string): Promise<boolean> => {
    checkProfile(profile);
    let removed = false;
    if (mode() !== "plaintext") {
        const kr = await loadKeyring();
        if (kr) {
            try {
                removed = new kr.Entry(SERVICE, account(profile)).deletePassword() || removed;
            } catch {
                /* kayıt yok ya da zincir kilitli: düz dosya yine silinir */
            }
        }
    }
    try {
        await stat(credentialFile(profile));
        await rm(credentialFile(profile), { force: true });
        removed = true;
    } catch {
        /* yok */
    }
    return removed;
};
