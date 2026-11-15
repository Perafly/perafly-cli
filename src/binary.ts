/**
 * Tek dosya ikili (README §8; scripts/build-binary.mjs, Node SEA) açılışı.
 *
 * Node SEA'da `process.argv[1]` ham `argv[0]`'dır: PATH'ten çağrılınca yalnız ad (`perafly`), göreli çağrıda göreli
 * yol. npm'deki betikte ise Node onu mutlak yola çevirir. Git kimlik yardımcısı bu yolu yazar (src/git/repo.ts
 * `helperCommand`): yalın ad çalışma klasörüne göre çözülseydi Git, deponun içindeki bir `perafly` dosyasını
 * çalıştırırdı. Bu yüzden ikilide `argv[1]` mutlak yola çevrilir: ayırıcı varsa çağrılan yol; yalın adsa PATH'te bu
 * ikiliye giden ilk mutlak girdi (Homebrew'un sürümden bağımsız bağı gibi); bulunamazsa ikilinin kendi yolu. Aday,
 * gerçek yolu ikilininkiyle aynı değilse kullanılmaz.
 */
import { posix, win32 } from "node:path";

export interface EntryPathInput {
    argv1: string | undefined;
    execPath: string;
    pathEnv: string | undefined;
    platform: NodeJS.Platform;
    cwd: string;
    /** Gerçek yol; dosya yoksa null */
    realpath: (path: string) => string | null;
}

export const binaryEntryPath = (input: EntryPathInput): string => {
    const p = input.platform === "win32" ? win32 : posix;
    const self = input.realpath(input.execPath) ?? input.execPath;
    const same = (candidate: string) => input.realpath(candidate) === self;
    const raw = input.argv1 ?? "";
    if (!raw) return input.execPath;
    if (/[\\/]/.test(raw)) {
        const typed = p.resolve(input.cwd, raw);
        return same(typed) ? typed : input.execPath;
    }
    const names = input.platform === "win32" && !/\.exe$/i.test(raw) ? [raw, `${raw}.exe`] : [raw];
    for (const dir of (input.pathEnv ?? "").split(p.delimiter)) {
        // Göreli PATH girdisi (`.`) çalışma klasörüne bağlıdır: atlanır
        if (!dir || !p.isAbsolute(dir)) continue;
        for (const name of names) {
            const candidate = p.join(dir, name);
            if (same(candidate)) return candidate;
        }
    }
    return input.execPath;
};
