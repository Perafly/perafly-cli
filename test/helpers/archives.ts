/**
 * Test arşivleri: kötü niyetli girdileri (yol kaçışı, bağ, bomba) kurmak için elle yazılan küçük zip ve tar üreticileri.
 * Kütüphaneler bu girdileri üretmeyi reddettiği için başlıklar burada doğrudan yazılır.
 */
import { crc32, gzipSync } from "node:zlib";

export interface ZipEntry { name: string; content?: Buffer; unixMode?: number; encrypted?: boolean; declaredSize?: number }

export const makeZip = (entries: ZipEntry[]): Buffer => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, "utf8");
        const data = e.content ?? Buffer.alloc(0);
        const crc = crc32(data) >>> 0;
        const flags = 0x0800 | (e.encrypted ? 0x1 : 0);
        const size = e.declaredSize ?? data.length;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(0, 10);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, data);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((3 << 8) | 20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt32LE(0, 12);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(size, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((e.unixMode ?? (e.name.endsWith("/") ? 0o040755 : 0o100644)) << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
};

export interface TarEntry { name: string; content?: Buffer; type?: "0" | "2" | "1" | "5"; linkname?: string }

const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";

export const makeTarGz = (entries: TarEntry[]): Buffer => {
    const blocks: Buffer[] = [];
    for (const e of entries) {
        const data = e.content ?? Buffer.alloc(0);
        const type = e.type ?? "0";
        const h = Buffer.alloc(512);
        h.write(e.name, 0, 100, "utf8");
        h.write(octal(0o644, 8), 100);
        h.write(octal(0, 8), 108);
        h.write(octal(0, 8), 116);
        h.write(octal(type === "0" ? data.length : 0, 12), 124);
        h.write(octal(0, 12), 136);
        h.write("        ", 148);
        h.write(type, 156);
        if (e.linkname) h.write(e.linkname, 157, 100, "utf8");
        h.write("ustar\u000000", 257);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(octal(sum, 7) + " ", 148);
        blocks.push(h);
        if (data.length && type === "0") blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
};
