/**
 * Sır karartma (README §9 "Çıktı"): anahtarlar (`pfa_`, `pfc_`, `pfh_`, `pfs_`, gizli veri anahtarı `pfk_`, kanca sırrı
 * `pfw_`), paylaşım bağlantısı (`pfl_`), imzalı yükleme ve indirme adresleri (yayın ve depolama) ve sahiplenme
 * bağlantısının parçası `--json` çıktısına, hata nesnesine ve `PERAFLY_DEBUG` loglarına yazılmadan önce buradan geçer.
 * İnsan çıktısında sahiplenme bağlantısı bilerek gösterilir (kullanıcının tarayıcıda açacağı tek yol); o yol bu
 * fonksiyonu atlar ve yalnız `publish` sonucunda kullanılır. Yayınlanabilir veri anahtarı (`pfp_`) sır değildir (tarayıcıda
 * durur; ajan ön yüzü onunla bağlar): karartılmaz.
 */
export const REDACTED = "[redacted]";

const TOKEN_RE = /\bpf[acshlkw]_[0-9A-Za-z]{16,}\b/g;
const UPLOAD_RE = /(\/v1\/(?:uploads|storage-uploads|storage-files)\/)[^\s"'<>?#]+/g;
const CLAIM_RE = /(\/claim#)[^\s"'<>]+/g;
const DEVICE_CODE_RE = /("deviceCode"\s*:\s*")[^"]+/g;
/** Değeri her durumda karartılan alan adları */
const SECRET_KEYS = new Set(["token", "secret", "projectKey", "agentKey", "deviceCode", "password", "authorization", "claimUrl", "url", "uploadUrl", "downloadUrl"]);
/** `url` yalnız imzalı yükleme adresiyse karartılır (canlı adres ve depolamanın herkese açık adresi karartılmaz) */
const isSecretValue = (key: string, value: string) => (key === "url" ? /\/v1\/uploads\//.test(value) : key === "claimUrl" ? true : SECRET_KEYS.has(key));

export const redact = (text: string): string =>
    text.replace(TOKEN_RE, REDACTED).replace(UPLOAD_RE, `$1${REDACTED}`).replace(CLAIM_RE, `$1${REDACTED}`).replace(DEVICE_CODE_RE, `$1${REDACTED}`);

/** Nesneyi derin kopyalayıp sır alanlarını ve metin içindeki belirteçleri karartır */
export const redactDeep = <T>(value: T, depth = 0): T => {
    if (depth > 20) return value;
    if (typeof value === "string") return redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
    if (value && typeof value === "object" && !(value instanceof Date)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = typeof v === "string" && isSecretValue(k, v) ? REDACTED : redactDeep(v, depth + 1);
        }
        return out as T;
    }
    return value;
};
