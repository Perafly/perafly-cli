/**
 * Bildirim özetleri (README §2.1): her dosyanın sha256'sı akışla hesaplanır. Okuma sırasında boyutu değişen dosya
 * hata verir (yarım yazılmış derleme çıktısı yayınlanmasın).
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { CliError } from "../errors.js";
import type { CollectedFile } from "./collect.js";

export interface HashedFile extends CollectedFile {
    sha256: string;
}

export const sha256File = (absPath: string): Promise<{ sha256: string; size: number }> =>
    new Promise((resolveHash, reject) => {
        const h = createHash("sha256");
        let size = 0;
        createReadStream(absPath)
            .on("data", (chunk) => {
                const b = chunk as Buffer;
                size += b.length;
                h.update(b);
            })
            .on("error", reject)
            .on("end", () => resolveHash({ sha256: h.digest("hex"), size }));
    });

export const hashFiles = async (files: readonly CollectedFile[], opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<HashedFile[]> => {
    const out: HashedFile[] = new Array(files.length);
    const concurrency = Math.max(1, Math.min(32, opts.concurrency ?? 8));
    let next = 0;
    let done = 0;
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= files.length) return;
            const f = files[i]!;
            const { sha256, size } = await sha256File(f.absPath);
            if (size !== f.size) throw new CliError("validation_error", `${f.path} changed while it was being read. Wait for the build to finish, then publish again.`, { exitCode: 2 });
            out[i] = { ...f, sha256 };
            opts.onProgress?.(++done, files.length);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
    return out;
};
