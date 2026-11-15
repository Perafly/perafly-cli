/**
 * Tarayıcıda adres açar (yalnız etkileşimli kipte çağrılır). Kabuk kullanılmaz: argüman dizisiyle `spawn`. Yalnız
 * https ya da yerel http adresi açılır.
 */
import { spawn } from "node:child_process";

export const isOpenableUrl = (url: string): boolean => {
    try {
        const u = new URL(url);
        return u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1|.*\.localhost)$/.test(u.hostname));
    } catch {
        return false;
    }
};

export const openUrl = async (url: string): Promise<void> => {
    if (!isOpenableUrl(url)) return;
    const [cmd, args] =
        process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    await new Promise<void>((resolve) => {
        try {
            const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
            child.on("error", () => resolve());
            child.unref();
            resolve();
        } catch {
            resolve();
        }
    });
};
