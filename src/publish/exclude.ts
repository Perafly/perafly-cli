/**
 * Dışlama kuralları (README §9 "Hiçbir yoldan yüklenmeyen dosyalar"; backend app/src/publish/manifest.ts blockedReason).
 * GÜVENLİK SINIRI. Sunucu da aynı dosyaları reddeder; CLI onları bildirime hiç koymaz ve `--dry-run`'da gösterir.
 *
 * CLI sunucudan katıdır: bütün `.env*` dosyaları (örnekler dahil), `.perafly/` klasörünün tamamı ve işletim sistemi
 * artıkları da atlanır.
 */

/** Klasör adı → neden (bu klasörün altı hiç gezilmez) */
const EXCLUDED_DIRS: Record<string, string> = {
    ".git": "version control directory",
    ".hg": "version control directory",
    ".svn": "version control directory",
    node_modules: "node_modules",
    ".ssh": "credential directory",
    ".aws": "credential directory",
    ".gnupg": "credential directory",
    ".perafly": "local Perafly state",
    ".vercel": "local hosting state"
};

const CREDENTIAL_FILES = new Set([".npmrc", ".netrc", ".pypirc", ".htpasswd", ".git-credentials", ".dockercfg"]);
/** Git'in kendi dosyaları: sitede işe yaramaz; CLI `.gitignore`'u kendisi de yazar (state.json için) */
const VCS_FILES = new Set([".gitignore", ".gitattributes", ".gitmodules", ".gitkeep"]);
const JUNK_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

/** Klasör (göreli yolun son bölümü) atlanacaksa neden, değilse null */
export const excludedDirReason = (name: string): string | null => EXCLUDED_DIRS[name.toLowerCase()] ?? null;

/** Dosya göreli yolu atlanacaksa neden, değilse null. Yol `/` ayraçlıdır. */
export const excludedFileReason = (relPath: string): string | null => {
    const lower = relPath.toLowerCase();
    const segments = lower.split("/");
    for (const s of segments.slice(0, -1)) {
        const r = EXCLUDED_DIRS[s];
        if (r) return r;
    }
    const file = segments[segments.length - 1] ?? "";
    if (/^\.env(\..*)?$/.test(file)) return "environment file";
    if (/\.(pem|key|p12|pfx|keystore|jks|kdbx)$/.test(file)) return "private key file";
    if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(file)) return "SSH key";
    if (CREDENTIAL_FILES.has(file)) return "credential file";
    if (VCS_FILES.has(file)) return "version control file";
    if (JUNK_FILES.has(file)) return "system file";
    return null;
};

/**
 * Bildirime girebilecek yol mu: denetim karakteri, ters eğik çizgi, `..` ve boş bölüm reddedilir (sunucu kuralının
 * istemci kopyası; Windows'ta yol ayraçları önceden `/`'e çevrilir). Sınırlar: yol 512, bölüm 255 karakter.
 */
export const invalidPathReason = (relPath: string): string | null => {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\\]/.test(relPath)) return "invalid characters in name";
    if (relPath.length > 512) return "path too long";
    for (const s of relPath.split("/")) {
        if (!s || s === "." || s === "..") return "invalid path";
        if (s.length > 255) return "name too long";
    }
    return null;
};
