/**
 * Açık API istemcisi (README §7; backend docs/API.md §15). Sözleşme `src/api/openapi.json`'dur; her çağrı bir
 * `operationId` taşır (hata ayıklama ve eşleme testi için).
 *
 * - Kimlik: `Authorization: Bearer pfa_…` ya da `pfc_…`; kimliksiz çağrı yalnız `publish` içindir.
 * - Hata: RFC 9457 gövdesi `problemToError` ile CliError; `X-Request-Id` hataya geçer.
 * - Yeniden deneme: 429'da `Retry-After` ile en çok 2 kez (GET ya da `Idempotency-Key` taşıyan POST); ağ hatası
 *   `network_error` (çıkış 40).
 * - `PERAFLY_DEBUG`: stderr'e yöntem, yol, durum ve süre; satırlar karartılır, `Authorization` yazılmaz.
 * - Sorgu: düz değer `k=v`; nesne deepObject biçiminde açılır (`filter[alan]=v`, `filter[alan][op]=v`; backend
 *   docs/API.md §20.2). Dizi virgülle birleşir.
 * - İmzalı adresler (`upload`, `download`): kimlik başlığı gönderilmez; tanılama satırında adresin belirteç kısmı yazılmaz.
 */
import { randomUUID } from "node:crypto";
import { redact } from "../auth/redact.js";
import { CliError, problemToError } from "../errors.js";
import { USER_AGENT } from "../version.js";

export type FetchLike = typeof fetch;

export interface ApiClientOptions {
    apiUrl: string;
    token?: string | null;
    fetch?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    debug?: (line: string) => void;
}

export interface RequestOptions {
    operationId: string;
    /** Düz değer ya da deepObject nesnesi (`{ filter: { price: { gte: 10 } } }`); boş değer atlanır */
    query?: Record<string, unknown>;
    body?: unknown;
    /** POST için tekrar güvenliği; `true` yeni bir anahtar üretir */
    idempotencyKey?: string | true;
    /** Bu çağrı için kimliği ezer (`null` → kimliksiz) */
    token?: string | null;
    signal?: AbortSignal;
    /**
     * Ham istek (`perafly api`): her durum kodunda yanıt döner; 4xx/5xx CliError'a çevrilmez, 429 ve 5xx yeniden
     * denenmez (ağ hatası yine denenir). Yalnız `stream` ile anlamlıdır.
     */
    anyStatus?: boolean;
}

export interface ApiResponse<T> {
    status: number;
    data: T;
    requestId: string | null;
    headers: Headers;
}

export const newIdempotencyKey = () => `pf-${randomUUID()}`;

/** Sorgu değeri: düz değer `k=v`, dizi virgülle, nesne deepObject (`k[alan]`, `k[alan][op]`) */
const appendQuery = (params: URLSearchParams, key: string, value: unknown, depth = 0) => {
    if (value === undefined || value === null || value === "" || depth > 4) return;
    if (Array.isArray(value)) {
        params.set(key, value.map(String).join(","));
        return;
    }
    if (typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) appendQuery(params, `${key}[${k}]`, v, depth + 1);
        return;
    }
    params.set(key, String(value));
};

/** Tanılama için imzalı adresin yolu: son parça (belirteç) yazılmaz */
const maskedPath = (u: URL) => u.pathname.replace(/\/[^/]+$/, "/…");

/** Yükleme gövdesi: bellekteki baytlar ya da her denemede yeniden açılan akış (büyük dosya) */
export type UploadBody = Uint8Array | (() => ReadableStream<Uint8Array>);

export class ApiClient {
    readonly apiUrl: string;
    private token: string | null;
    private readonly f: FetchLike;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly debug?: (line: string) => void;

    constructor(opts: ApiClientOptions) {
        this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
        this.token = opts.token ?? null;
        this.f = opts.fetch ?? fetch;
        this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.debug = opts.debug ?? (process.env.PERAFLY_DEBUG ? (line) => process.stderr.write(`[perafly] ${redact(line)}\n`) : undefined);
    }

    withToken(token: string | null): ApiClient {
        return new ApiClient({ apiUrl: this.apiUrl, token, fetch: this.f, sleep: this.sleep, debug: this.debug });
    }

    get hasToken() {
        return !!this.token;
    }

    /** İstek ve yeniden deneme; başarıda gövdesi okunmamış yanıt, hatada CliError */
    private async send(method: string, path: string, opts: RequestOptions): Promise<{ res: Response; requestId: string | null }> {
        const url = new URL(`${this.apiUrl}${path}`);
        for (const [k, v] of Object.entries(opts.query ?? {})) appendQuery(url.searchParams, k, v);
        const token = opts.token === undefined ? this.token : opts.token;
        const idem = opts.idempotencyKey === true ? newIdempotencyKey() : opts.idempotencyKey;
        const headers: Record<string, string> = { Accept: "application/json, application/problem+json", "User-Agent": USER_AGENT };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (idem) headers["Idempotency-Key"] = idem;
        if (opts.body !== undefined) headers["Content-Type"] = "application/json";
        const retriable = method === "GET" || !!idem;
        for (let attempt = 1; ; attempt++) {
            const started = Date.now();
            let res: Response;
            try {
                res = await this.f(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: opts.signal });
            } catch (error: any) {
                if (error?.name === "AbortError") throw new CliError("cancelled", "Cancelled", { exitCode: 130 });
                this.debug?.(`${method} ${url.pathname} network error (${opts.operationId})`);
                if (retriable && attempt <= 2) {
                    await this.sleep(500 * attempt);
                    continue;
                }
                throw new CliError("network_error", `Could not reach the Perafly API at ${this.apiUrl}`, { exitCode: 40, retryable: true });
            }
            const requestId = res.headers.get("x-request-id");
            this.debug?.(`${method} ${url.pathname} ${res.status} ${Date.now() - started}ms ${opts.operationId}${requestId ? ` ${requestId}` : ""}`);
            if (res.status < 400 || opts.anyStatus) return { res, requestId };
            const text = await res.text();
            let json: any = null;
            try {
                json = text ? JSON.parse(text) : null;
            } catch {
                json = null;
            }
            if (res.status === 429 && retriable && attempt <= 2) {
                const retryAfter = Number(res.headers.get("retry-after") ?? json?.retryAfterSeconds);
                const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 2000;
                await this.sleep(wait);
                continue;
            }
            if (res.status >= 500 && retriable && attempt <= 2) {
                await this.sleep(1000 * attempt);
                continue;
            }
            const err = problemToError(res.status, json, `${opts.operationId} failed (HTTP ${res.status})`);
            if (!err.requestId && requestId) (err as { requestId: string | null }).requestId = requestId;
            throw err;
        }
    }

    async request<T = any>(method: string, path: string, opts: RequestOptions): Promise<ApiResponse<T>> {
        const { res, requestId } = await this.send(method, path, opts);
        const text = await res.text();
        let json: any = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = null;
        }
        return { status: res.status, data: json as T, requestId, headers: res.headers };
    }

    /** Gövdesi okunmamış yanıt (dışa aktarma gibi dosya dönen uçlar); hata yine CliError */
    async stream(method: string, path: string, opts: RequestOptions): Promise<Response> {
        return (await this.send(method, path, opts)).res;
    }

    get<T = any>(path: string, opts: RequestOptions) {
        return this.request<T>("GET", path, opts);
    }
    post<T = any>(path: string, opts: RequestOptions) {
        return this.request<T>("POST", path, opts);
    }
    patch<T = any>(path: string, opts: RequestOptions) {
        return this.request<T>("PATCH", path, opts);
    }
    put<T = any>(path: string, opts: RequestOptions) {
        return this.request<T>("PUT", path, opts);
    }
    delete<T = any>(path: string, opts: RequestOptions) {
        return this.request<T>("DELETE", path, opts);
    }

    /**
     * İmzalı adres: https olmalıdır (API ile aynı kökteyse yerel geliştirmede http de olur); yükleme ve indirme ileride
     * nesne deposuna taşınabileceği için başka bir https sunucusu kabul edilir.
     */
    private signedTarget(url: string, what: "upload" | "download"): URL {
        let target: URL;
        try {
            target = new URL(url, this.apiUrl);
        } catch {
            throw new CliError("invalid_response", `The API returned an invalid ${what} URL`, { exitCode: 1 });
        }
        if (target.protocol !== "https:" && target.origin !== new URL(this.apiUrl).origin) throw new CliError("invalid_response", `The API returned an insecure ${what} URL`, { exitCode: 1 });
        return target;
    }

    /**
     * İmzalı yükleme adresine dosya baytları (`uploadFile`, `uploadStorageFile`). Kimlik başlığı gönderilmez: yetki
     * adresin kendisindedir. Gövde akışsa her denemede yeniden açılır. Yanıt gövdesi JSON ise döner (depolama nesnesi).
     */
    async upload(url: string, body: UploadBody, signal?: AbortSignal, operationId = "uploadFile"): Promise<any> {
        const target = this.signedTarget(url, "upload");
        for (let attempt = 1; ; attempt++) {
            let res: Response;
            try {
                const init: RequestInit & { duplex?: "half" } = { method: "PUT", headers: { "Content-Type": "application/octet-stream", "User-Agent": USER_AGENT }, signal };
                if (typeof body === "function") {
                    init.body = body();
                    init.duplex = "half";
                } else init.body = body;
                res = await this.f(target, init);
            } catch (error: any) {
                if (error?.name === "AbortError") throw new CliError("cancelled", "Cancelled", { exitCode: 130 });
                if (attempt <= 3) {
                    await this.sleep(500 * attempt);
                    continue;
                }
                throw new CliError("network_error", "Upload failed: could not reach the Perafly API", { exitCode: 40, retryable: true });
            }
            this.debug?.(`PUT ${maskedPath(target)} ${res.status} ${operationId}`);
            const text = await res.text();
            let json: any = null;
            try {
                json = text ? JSON.parse(text) : null;
            } catch {
                json = null;
            }
            if (res.status === 204 || res.status === 200) return json;
            if ((res.status >= 500 || res.status === 429) && attempt <= 3) {
                await this.sleep(1000 * attempt);
                continue;
            }
            throw problemToError(res.status, json, "Upload failed");
        }
    }

    /** İmzalı indirme adresinden dosya (`downloadStorageFile`): kimliksiz GET, gövdesi okunmamış yanıt */
    async download(url: string, signal?: AbortSignal, operationId = "downloadStorageFile"): Promise<Response> {
        const target = this.signedTarget(url, "download");
        for (let attempt = 1; ; attempt++) {
            let res: Response;
            try {
                res = await this.f(target, { method: "GET", headers: { "User-Agent": USER_AGENT }, signal });
            } catch (error: any) {
                if (error?.name === "AbortError") throw new CliError("cancelled", "Cancelled", { exitCode: 130 });
                if (attempt <= 3) {
                    await this.sleep(500 * attempt);
                    continue;
                }
                throw new CliError("network_error", "Download failed: could not reach the Perafly API", { exitCode: 40, retryable: true });
            }
            this.debug?.(`GET ${maskedPath(target)} ${res.status} ${operationId}`);
            if (res.status >= 200 && res.status < 300) return res;
            const text = await res.text();
            let json: any = null;
            try {
                json = text ? JSON.parse(text) : null;
            } catch {
                json = null;
            }
            if ((res.status >= 500 || res.status === 429) && attempt <= 3) {
                await this.sleep(1000 * attempt);
                continue;
            }
            throw problemToError(res.status, json, res.status === 401 ? "The download link expired. Try again." : "Download failed");
        }
    }
}
