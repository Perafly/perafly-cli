/** Paket sürümü (tsup derlemede `__PERAFLY_VERSION__`'ı doldurur; testte package.json'dan okunur) */
import { createRequire } from "node:module";

declare const __PERAFLY_VERSION__: string | undefined;

const fromPackage = (): string => {
    try {
        return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
    } catch {
        return "0.0.0";
    }
};

export const VERSION: string = typeof __PERAFLY_VERSION__ === "string" ? __PERAFLY_VERSION__ : fromPackage();
export const USER_AGENT = `perafly-cli/${VERSION} node/${process.versions.node}`;
