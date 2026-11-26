import dgram from "node:dgram";
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The `expiredDomains` marshall of `vis inspect` asks a DNS resolver for the NS records of a maintainer's domain
 * (`src/security/marshalls/expired-domains.ts`). The native port (`native/cli/src/inspect/expired_domains.rs`) sends the same
 * query itself and answers only for the three answers Node's resolver (c-ares) classifies as "registered" or "lapsed"; it hands
 * every other answer to Node. Both read `native/cli/tests/fixtures/dns-scenarios.json`: this file serves each scenario to Node's
 * own `Resolver` and checks the classification the fixture names, and the Rust tests serve the same scenarios to the port.
 * The resolver is a UDP stub on 127.0.0.1, so nothing leaves the machine.
 */

interface Entry {
    address?: number[];
    target?: string;
    type: "A" | "CNAME" | "NS";
}

interface Scenario {
    answers?: Entry[];
    authority?: Entry[];
    expected: "lapsed" | "registered" | "unresolved";
    name: string;
    native?: "decline";
    rcode?: number;
    silent?: boolean;
    tc?: boolean;
}

const scenarios = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "cli", "tests", "fixtures", "dns-scenarios.json"), "utf8")) as Scenario[];

const nameWire = (name: string): Buffer => Buffer.concat([...name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);

const recordWire = (entry: Entry): Buffer => {
    const types = { A: 1, CNAME: 5, NS: 2 };
    const data = entry.address === undefined ? nameWire(entry.target as string) : Buffer.from(entry.address);
    const head = Buffer.alloc(10);

    head.writeUInt16BE(types[entry.type], 0);
    head.writeUInt16BE(1, 2);
    head.writeUInt32BE(300, 4);
    head.writeUInt16BE(data.length, 8);

    return Buffer.concat([Buffer.from([0xC0, 0x0C]), head, data]);
};

/** `isExpiredError` and `resolveDomain` of the marshall: records are registered, no such domain or no data is lapsed, anything else is a failure. */
const classify = async (resolver: Resolver, domain: string, limit = 1500): Promise<"lapsed" | "registered" | "unresolved"> => {
    try {
        const records = await Promise.race([
            resolver.resolveNs(domain),
            new Promise<never>((_resolve, reject) => {
                setTimeout(() => {
                    reject(new Error("ETIMEDOUT"));
                }, limit);
            }),
        ]);

        return Array.isArray(records) && records.length > 0 ? "registered" : "lapsed";
    } catch (error: unknown) {
        const { code } = error as { code?: string };

        return code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN" ? "lapsed" : "unresolved";
    }
};

/** A resolver stub on 127.0.0.1: what it answers to a query comes from `answer`, which sees the scenario and the domain asked. */
const startStub = async (answer: () => Scenario): Promise<{ asked: string[]; close: () => void; port: number }> => {
    const server = dgram.createSocket("udp4");
    const asked: string[] = [];

    server.on("message", (message, from) => {
        const labels: string[] = [];
        let end = 12;

        while (message[end] !== 0) {
            labels.push(message.subarray(end + 1, end + 1 + (message[end] as number)).toString());
            end += (message[end] as number) + 1;
        }

        end += 5;
        asked.push(labels.join("."));

        const current = answer();

        if (current.silent === true) {
            return;
        }

        const answers = current.answers ?? [];
        const authority = current.authority ?? [];
        const head = Buffer.alloc(12);

        message.copy(head, 0, 0, 2);
        head.writeUInt16BE(0x81_80 + (current.tc === true ? 0x02_00 : 0) + (current.rcode ?? 0), 2);
        head.writeUInt16BE(1, 4);
        head.writeUInt16BE(answers.length, 6);
        head.writeUInt16BE(authority.length, 8);
        server.send(Buffer.concat([head, message.subarray(12, end), ...answers.map((entry) => recordWire(entry)), ...authority.map((entry) => recordWire(entry))]), from.port, from.address);
    });

    await new Promise<void>((resolve) => {
        server.bind(0, "127.0.0.1", resolve);
    });

    return {
        asked,
        close: () => {
            server.close();
        },
        port: server.address().port,
    };
};

const named = (name: string): Scenario => scenarios.find((scenario) => scenario.name === name) as Scenario;

/** The marshall's resolver: `new Resolver()` with the servers set (here to stubs); `-1` is the default timeout. */
const resolverFor = (...ports: number[]): Resolver => {
    const resolver = new Resolver({ timeout: -1 });

    resolver.setServers(ports.map((port) => `127.0.0.1:${port}`));

    return resolver;
};

describe("expiredDomains: what Node's resolver makes of each answer", () => {
    let current: Scenario;
    let stub: Awaited<ReturnType<typeof startStub>>;

    beforeAll(async () => {
        current = named("nxdomain");
        stub = await startStub(() => current);
    });

    afterAll(() => {
        stub.close();
    });

    it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))("classifies %s", async (_name, scenario) => {
        expect.hasAssertions();

        current = scenario;

        const resolver = resolverFor(stub.port);

        try {
            await expect(classify(resolver, "example.test")).resolves.toBe(scenario.expected);
        } finally {
            resolver.cancel();
        }
    });

    it("asks the name as written, once: no search domain and no suffix", async () => {
        expect.hasAssertions();

        current = named("nxdomain");
        stub.asked.length = 0;

        const resolver = resolverFor(stub.port);

        try {
            await classify(resolver, "example.test");
        } finally {
            resolver.cancel();
        }

        // `LOCALDOMAIN` and `RES_OPTIONS` (set in the environment of the run that checked this by hand) change nothing here.
        expect(stub.asked).toStrictEqual(["example.test"]);
    });

    it("sends the query the native port sends: recursion desired, one question of type NS, no EDNS", async () => {
        expect.hasAssertions();

        const raw = dgram.createSocket("udp4");
        const received = new Promise<Buffer>((resolve) => {
            raw.once("message", resolve);
        });

        await new Promise<void>((resolve) => {
            raw.bind(0, "127.0.0.1", resolve);
        });

        const resolver = resolverFor((raw.address() as { port: number }).port);

        try {
            const pending = classify(resolver, "example.com");
            const query = await received;

            // After the two bytes of id: flags 0x0100, one question, no other record, then the name, type NS and class IN.
            expect(query).toHaveLength(29);
            expect(query.subarray(2, 12).toString("hex")).toBe("01000001000000000000");
            expect(query.subarray(12).toString("hex")).toBe("076578616d706c6503636f6d0000020001");

            resolver.cancel();
            await pending;
        } finally {
            raw.close();
        }
    });
});

describe("expiredDomains: Node asks the first of its two servers", () => {
    const ask = async (first: Scenario, second: Scenario, times: number, limit = 1500): Promise<{ first: number; outcomes: Set<string>; second: number }> => {
        const one = await startStub(() => first);
        const two = await startStub(() => second);
        const outcomes = new Set<string>();

        try {
            for (let round = 0; round < times; round += 1) {
                const resolver = resolverFor(one.port, two.port);

                try {
                    outcomes.add(await classify(resolver, "example.test", limit));
                } finally {
                    resolver.cancel();
                }
            }

            return { first: one.asked.length, outcomes, second: two.asked.length };
        } finally {
            one.close();
            two.close();
        }
    };

    it.each([
        ["lapsed first, registered second", "nxdomain", "ns records", "lapsed"],
        ["registered first, lapsed second", "ns records", "nxdomain", "registered"],
        ["servfail first, registered second", "servfail", "ns records", "unresolved"],
        ["lapsed first, silent second", "nxdomain", "no answer", "lapsed"],
    ])("answers what the first server says (%s), and never asks the second", async (_label, first, second, expected) => {
        expect.hasAssertions();

        const result = await ask(named(first), named(second), 5);

        expect([...result.outcomes]).toStrictEqual([expected]);
        expect(result.first).toBe(5);
        expect(result.second).toBe(0);
    });

    it("asks the second server only when the first does not answer", async () => {
        expect.hasAssertions();

        // The marshall waits 4 seconds for a domain; c-ares tries the second server after its own 2 seconds.
        const result = await ask(named("no answer"), named("ns records"), 1, 3900);

        expect([...result.outcomes]).toStrictEqual(["registered"]);
        expect(result.second).toBeGreaterThan(0);
    });
});
