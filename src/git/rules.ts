/**
 * Git kuralları — saf (backend app/src/git/rules.ts ile aynı; eşlik test/git.test.ts'te sabit örneklerle denetlenir).
 * Yayından ve `git set`'ten önce bayrakları ağa gitmeden denetler; sunucu ayrıca doğrular.
 *
 *   isValidBranch(ad)      Git dal adı kuralları (`git check-ref-format --branch` özü)
 *   isCommitSha(değer)     7–64 onaltılık karakter
 *
 * Dal adresi (`<ad>--br-<dal>`) yerelde kurulmaz: sunucunun `version.git.branchUrl`'i kullanılır.
 */
export const BRANCH_MAX = 255;
const SHA_RE = /^[0-9a-f]{7,64}$/i;

export const isValidBranch = (name: unknown): name is string => {
    if (typeof name !== "string" || !name || name.length > BRANCH_MAX) return false;
    if (name === "@" || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock") || name.startsWith("-")) return false;
    // eslint-disable-next-line no-control-regex
    if (name.includes("..") || name.includes("//") || name.includes("@{") || /[\u0000- \u007f~^:?*[\\]/.test(name)) return false;
    return !name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"));
};

export const isCommitSha = (value: unknown): value is string => typeof value === "string" && SHA_RE.test(value);

