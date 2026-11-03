import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { crc32, gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Finding, ScanOptions } from "../src/index";
import { scan, scanFiles } from "../src/index";

vi.setConfig({ testTimeout: 30_000 });

const TOKEN = "ghp_aB3dE4fG5hI6jK7l" + "M8nO9pQ0rS1tU2vW3xY4";
const LEAK = Buffer.from(`token = ${TOKEN}\n`);

const config: ScanOptions["config"] = {
    extendBundled: false,
    inline: { rules: [{ id: "gh-pat", keywords: ["ghp_"], regex: "ghp_[0-9A-Za-z]{36}" }] },
};

type Entry = [name: string, data: Buffer];

/** Minimal stored (uncompressed) zip writer. */
const zipOf = (entries: Entry[]): Buffer => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const [name, data] of entries) {
        const nameBytes = Buffer.from(name);
        const crc = crc32(data);
        const local = Buffer.alloc(30);

        local.writeUInt32LE(0x04_03_4b_50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);

        const central = Buffer.alloc(46);

        central.writeUInt32LE(0x02_01_4b_50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);

        locals.push(local, nameBytes, data);
        centrals.push(central, nameBytes);
        offset += local.length + nameBytes.length + data.length;
    }

    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);

    end.writeUInt32LE(0x06_05_4b_50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...locals, directory, end]);
};

/** Minimal ustar writer. Names are written raw, so hostile names survive. */
const tarOf = (entries: Entry[]): Buffer => {
    const blocks: Buffer[] = [];

    for (const [name, data] of entries) {
        const header = Buffer.alloc(512);

        header.write(name, 0, 100);
        header.write("0000644\0", 100);
        header.write("0000000\0", 108);
        header.write("0000000\0", 116);
        header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
        header.write("00000000000\0", 136);
        header.write("        ", 148);
        header.write("0", 156);
        header.write("ustar\0", 257);
        header.write("00", 263);

        let sum = 0;

        for (const byte of header) {
            sum += byte;
        }

        header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
        blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }

    return Buffer.concat([...blocks, Buffer.alloc(1024)]);
};

const files = (findings: Finding[]): string[] => findings.map((finding) => finding.file).toSorted((a, b) => a.localeCompare(b));

let tmp: string;

beforeEach(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), "secret-scanner-archive-"));
});

afterEach(async () => {
    await rm(tmp, { force: true, recursive: true });
});

describe("archive scanning (maxArchiveDepth)", () => {
    it("is off by default: archives are skipped as binary files", async () => {
        expect.assertions(1);

        await writeFile(resolve(tmp, "bundle.zip"), zipOf([["app.env", LEAK]]));

        await expect(scan([tmp], { config })).resolves.toHaveLength(0);
    });

    it("reports zip entries with a relative virtual path", async () => {
        expect.assertions(2);

        await writeFile(resolve(tmp, "bundle.zip"), zipOf([["config/app.env", LEAK]]));

        const findings = await scan([tmp], { config, maxArchiveDepth: 1 });

        expect(files(findings)).toStrictEqual(["bundle.zip!config/app.env"]);
        expect(findings[0]?.secret).toBe(TOKEN);
    });

    it("finds a nested zip inside a tar.gz only within the depth limit", async () => {
        expect.assertions(2);

        const inner = zipOf([["deploy/.env", LEAK]]);

        await writeFile(resolve(tmp, "release.tar.gz"), gzipSync(tarOf([["vendor/inner.zip", inner]])));

        await expect(scan([tmp], { config, maxArchiveDepth: 1 })).resolves.toHaveLength(0);

        expect(files(await scan([tmp], { config, maxArchiveDepth: 2 }))).toStrictEqual(["release.tar.gz!vendor/inner.zip!deploy/.env"]);
    });

    it("detects archives by magic bytes, not by extension", async () => {
        expect.assertions(1);

        // Plain text with an archive-looking name is still text (gitleaks #2317)…
        await writeFile(resolve(tmp, "notes.7z.txt"), LEAK);
        // …and a zip/gzip with an unrelated extension is still opened (#2010).
        await writeFile(resolve(tmp, "payload.dat"), zipOf([["a.env", LEAK]]));
        await writeFile(resolve(tmp, "backup.zip"), gzipSync(LEAK));

        expect(files(await scan([tmp], { config, maxArchiveDepth: 1 }))).toStrictEqual(["backup.zip!backup.zip", "notes.7z.txt", "payload.dat!a.env"]);
    });

    it("sanitises traversal entry names", async () => {
        expect.assertions(1);

        await writeFile(resolve(tmp, "evil.tar"), tarOf([["../../../etc/passwd", LEAK]]));

        expect(files(await scan([tmp], { config, maxArchiveDepth: 1 }))).toStrictEqual(["evil.tar!etc/passwd"]);
    });

    it("skips binary entries", async () => {
        expect.assertions(1);

        await writeFile(resolve(tmp, "bin.zip"), zipOf([["blob.bin", Buffer.concat([LEAK, Buffer.from([0])])]]));

        await expect(scan([tmp], { config, maxArchiveDepth: 1 })).resolves.toHaveLength(0);
    });

    it("opens archives passed to scanFiles", async () => {
        expect.assertions(1);

        const path = resolve(tmp, "dump.sql.gz");

        await writeFile(path, gzipSync(LEAK));

        const findings = await scanFiles([path], { config, maxArchiveDepth: 1 });

        expect(findings.map((finding) => finding.file.endsWith("dump.sql.gz!dump.sql"))).toStrictEqual([true]);
    });
});
