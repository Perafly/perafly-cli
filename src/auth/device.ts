/**
 * Cihazla giriş istemcisi (RFC 8628; backend docs/API.md §15.7). GÜVENLİK SINIRI.
 *
 *   startDeviceLogin(apiUrl, { clientName, access })  → kod çifti (cihaz kodu yalnız bellekte durur)
 *   waitForDeviceToken(apiUrl, start)                 → onaylanınca `pfa_` CLI anahtarı ve meta veri
 *
 * Yoklama aralığına uyulur; `slow_down` aralığı 5 sn uzatır. Reddedilen istek `access_denied`, süresi dolan
 * `expired_token` ile düşer (çıkış 10). Cihaz kodu ve anahtar hiçbir hata iletisine girmez.
 */
import { CliError, problemToError } from "../errors.js";
import { isApiKey } from "./token.js";
import type { AccessProfile } from "./store.js";

export interface DeviceStart {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
}

export interface DeviceToken {
    token: string;
    expiresAt: string | null;
    access: AccessProfile;
    key: { id: string; name: string; prefix: string } | null;
    team: { id: string; name: string; slug?: string | null } | null;
    user: { id: string; name: string; email?: string | null } | null;
}

type FetchLike = typeof fetch;

export interface DeviceDeps {
    fetch?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    signal?: AbortSignal;
    userAgent?: string;
}

const post = async (deps: DeviceDeps, url: string, body: unknown) => {
    const f = deps.fetch ?? fetch;
    let res: Response;
    try {
        res = await f(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, application/problem+json", ...(deps.userAgent ? { "User-Agent": deps.userAgent } : {}) },
            body: JSON.stringify(body),
            signal: deps.signal
        });
    } catch (error: any) {
        if (error?.name === "AbortError") throw new CliError("cancelled", "Cancelled", { exitCode: 130 });
        throw new CliError("network_error", "Could not reach the Perafly API", { exitCode: 40, retryable: true });
    }
    const text = await res.text();
    let json: any = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    return { status: res.status, json };
};

const PROFILES: readonly AccessProfile[] = ["full", "agent", "read"];

export const startDeviceLogin = async (apiUrl: string, input: { clientName?: string; access?: AccessProfile }, deps: DeviceDeps = {}): Promise<DeviceStart> => {
    if (input.access !== undefined && !PROFILES.includes(input.access)) throw new CliError("validation_error", "--access must be full, agent or read", { exitCode: 2 });
    const r = await post(deps, `${apiUrl}/v1/auth/device`, { clientName: input.clientName, access: input.access });
    if (r.status !== 201) throw problemToError(r.status, r.json, "Could not start sign-in");
    const j = r.json ?? {};
    if (typeof j.deviceCode !== "string" || typeof j.userCode !== "string" || typeof j.verificationUri !== "string") {
        throw new CliError("invalid_response", "The API returned an unexpected sign-in response", { exitCode: 1 });
    }
    const verificationUri = safeHttpsUrl(j.verificationUri, apiUrl);
    const verificationUriComplete = typeof j.verificationUriComplete === "string" ? safeHttpsUrl(j.verificationUriComplete, apiUrl) : verificationUri;
    return {
        deviceCode: j.deviceCode,
        userCode: j.userCode,
        verificationUri,
        verificationUriComplete,
        expiresIn: clampInt(j.expiresIn, 60, 1800, 600),
        interval: clampInt(j.interval, 1, 60, 5)
    };
};

const clampInt = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : fallback);

/**
 * Tarayıcıda açılacak adres yalnız https olabilir (yerel geliştirmede http://localhost); `javascript:` ya da dosya
 * adresi asla açılmaz.
 */
const safeHttpsUrl = (raw: string, apiUrl: string): string => {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new CliError("invalid_response", "The API returned an invalid verification URL", { exitCode: 1 });
    }
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname.endsWith(".localhost");
    const apiLocal = /^http:\/\/(localhost|127\.0\.0\.1)/.test(apiUrl);
    if (u.protocol === "https:" || (u.protocol === "http:" && local && apiLocal)) return u.toString();
    throw new CliError("invalid_response", "The API returned an insecure verification URL", { exitCode: 1 });
};

export const waitForDeviceToken = async (apiUrl: string, start: DeviceStart, deps: DeviceDeps = {}): Promise<DeviceToken> => {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = deps.now ?? Date.now;
    const deadline = now() + start.expiresIn * 1000;
    let interval = start.interval;
    for (;;) {
        if (deps.signal?.aborted) throw new CliError("cancelled", "Cancelled", { exitCode: 130 });
        await sleep(interval * 1000);
        if (now() > deadline) throw new CliError("expired_token", "The sign-in code expired. Run perafly login again.", { exitCode: 10, recovery: "perafly login" });
        const r = await post(deps, `${apiUrl}/v1/auth/device/token`, { deviceCode: start.deviceCode });
        if (r.status === 200) {
            const j = r.json ?? {};
            if (!isApiKey(j.token)) throw new CliError("invalid_response", "The API returned an unexpected token", { exitCode: 1 });
            return {
                token: j.token,
                expiresAt: typeof j.expiresAt === "string" ? j.expiresAt : null,
                access: PROFILES.includes(j.access) ? j.access : "read",
                key: j.key && typeof j.key.id === "string" ? { id: j.key.id, name: String(j.key.name ?? ""), prefix: String(j.key.prefix ?? "") } : null,
                team: j.team && typeof j.team.id === "string" ? { id: j.team.id, name: String(j.team.name ?? ""), slug: j.team.slug ?? null } : null,
                user: j.user && typeof j.user.id === "string" ? { id: j.user.id, name: String(j.user.name ?? ""), email: j.user.email ?? null } : null
            };
        }
        const code = r.json?.code;
        if (r.status === 400 && code === "authorization_pending") continue;
        if (r.status === 400 && code === "slow_down") {
            interval = Math.min(60, interval + 5);
            continue;
        }
        if (r.status === 429) {
            interval = Math.min(60, interval * 2);
            continue;
        }
        if (r.status === 400 && code === "access_denied") throw new CliError("access_denied", "The sign-in request was denied in the browser.", { exitCode: 10 });
        if (r.status === 400 && code === "expired_token") throw new CliError("expired_token", "The sign-in code expired. Run perafly login again.", { exitCode: 10, recovery: "perafly login" });
        throw problemToError(r.status, r.json, "Sign-in failed");
    }
};
