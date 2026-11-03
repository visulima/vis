import { beforeAll, describe, expect, it } from "vitest";

import { inspectRuleset, scanString } from "../src";

// Rule-level regression tests: one true positive and one false positive per
// rule we touch at build time (converter fixes, gitleaks patches, Visulima
// rules). Every sample secret below is fake.

beforeAll(async () => {
    await scanString("warmup", "warmup.txt");
}, 120_000);

interface RuleCase {
    content: string;
    file?: string;
    name: string;
    ruleId: string;
}

// Ids of every rule that matched, including the ones the span dedup collapsed
// into a higher-priority finding (`alternateMatches`). Kingfisher often wins the
// span, so checking `ruleId` alone would hide a gitleaks rule that still fires.
const ruleIdsFor = async (content: string, file = "sample.txt"): Promise<string[]> => {
    const findings = await scanString(content, file);

    return findings.flatMap((finding) => [finding.ruleId, ...finding.alternateMatches]);
};

describe("kingfisher rules revived by the named-group keyword fix", () => {
    it("kingfisher.modal.1 finds a Modal token pair without the word `token_id` nearby", async () => {
        expect.assertions(1);

        const content = `modal_token = "ak-Xq9mB2vT7` + `kLp4RzW8nYc3d"\nmodal_secret = "as-Hj5kN8pQ2wE6rT9yU3iO1a"\n`;

        await expect(ruleIdsFor(content)).resolves.toContain("kingfisher.modal.1");
    });

    it("kingfisher.generic.9 finds `user+tag:SECRET` credentials without `user`/`pass` nearby", async () => {
        expect.assertions(1);

        const content = `url = alice.smith+deploy:A9F3K2L8Q7W1E5R6T4Y0U2I8O3P6S1D7\n`;

        await expect(ruleIdsFor(content)).resolves.toContain("kingfisher.generic.9");
    });

    it("kingfisher.ftp.1 finds plain `ftp://` URLs (keyword no longer `ftps`)", async () => {
        expect.assertions(1);

        const content = `mirror = ftp://admin:S3cr3tPassw0rd@files.example.org/pub\n`;

        await expect(ruleIdsFor(content)).resolves.toContain("kingfisher.ftp.1");
    });

    it("kingfisher.modal.1 ignores a lone `ak-` identifier", async () => {
        expect.assertions(1);

        await expect(ruleIdsFor("const id = 'ak-short';\n")).resolves.not.toContain("kingfisher.modal.1");
    });
});

const GITLEAKS_PATCH_TRUE_POSITIVES: RuleCase[] = [
    {
        content:
            "GITHUB_TOKEN=ghs_1234567_eyJodJFCrnl2edlBDdz1C5Jau2RJtBRnl.WmTSHf6pWkLUyifDLkDmWJ6UuVTAIjvFu7WICPhDeOZIiBOB-Y6sHrFH2ZU" + "Cr-lgotu2iXW7GboIRoL3u6aHwnMztVuaP_coUNEhEkk_iqq8vH2BzNZV45pF.CiRcDCajhDieQjEJ_Bq8F80ymm3T207gmhZRnFyy5r2\n",
        name: "ghs_ installation token with app id + JWT",
        ruleId: "github-app-token",
    },
    {
        content: 'OPENAI_API_KEY="sk-xJ7Fj4mgblEv0_9BZhvWaXH6K2_tyLBhhOhg9uhkxiiET3Bl' + 'bkFJZpFfk1OHAOEHYqM6Ojb6mjBHqSiFVKu4MbMnrHontIKA"\n',
        name: "legacy openai key 44+44",
        ruleId: "openai-api-key",
    },
    {
        content: 'OPENAI_API_KEY="sk-svcacct-RAH_Ggl2JfaQqHu42bojteVs3qfNUfTAFnT0tEuw0dwQ0FIunWeT3Bl' + 'bkFJ8Cz6SNDCdyZQJiJSZQdoHwHen3SO3oXyGf3azU3iQOpMN0PZLqy"\n',
        name: "openai service account key",
        ruleId: "openai-api-key",
    },
    {
        content: "Authorization: Bearer pat" + "AQ8yRV5lNKtzJ1.0996daeee6f529a279764017f2ed6cfc7403d75e173e4eaede5fe878f78e2978\n",
        name: "airtable PAT without the word airtable",
        ruleId: "airtable-personnal-access-token",
    },
    {
        content: 'SOURCEGRAPH_TOKEN = "aa2447c462ddaed16dc0' + 'cf0b9cd7f78df0cac5e4"\n',
        name: "sourcegraph bare hex in assignment",
        ruleId: "sourcegraph-access-token",
    },
    { content: "src_token: sgp_0c02d4e518ca6eaa_c8d82f01b" + "7210760474f36e8b5359309cc627393\n", name: "sgp_ token", ruleId: "sourcegraph-access-token" },
    {
        content: "SQUARE_ACCESS_TOKEN=EAAAfS2ViRb1_n3U6t3wI973IPFlJ5F7" + "WRd-Px_BTHRJJbykE0_E8_5clLCZFNV8\n",
        name: "EAAA + 60 token",
        ruleId: "square-access-token",
    },
    { content: '  administrator_login_password = "Wq7zP2kd9Lm4Xv"\n', file: "main.tf", name: "administrator_login_password", ruleId: "hashicorp-tf-password" },
    {
        content: `apiVersion: v1
data:
  ca.pem: LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tXG5BMTBCMjBzdXBlcnNlY3JldHBlbWRhdGFcbi0tLS0tRU5EIFBSSVZBVEUgS0VZLS0tLS1cbg==
  cert.pem: LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tXG5DMzBENDBzdXBlcnNlY3JldHBlbWRhdGFcbi0tLS0tRU5EIFBSSVZBVEUgS0VZLS0tLS1cbg==
  key.pem: LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tXG5FNTBGNjBzdXBlcnNlY3JldHBlbWRhdGFcbi0tLS0tRU5EIFBSSVZBVEUgS0VZLS0tLS0=
kind: Secret
metadata:
  name: client-certs
`,
        file: "secret.yaml",
        name: "kind: Secret after three data entries",
        ruleId: "kubernetes-secret-yaml",
    },
    {
        content: `-----BEGIN EC PRIVATE KEY-----
V3sF0xvwkWE/sD7G6Gb7Kuj4SM2G6MzX9nEWTLLcYJbg/KDTCyGrmfN4eUqlLP1w
zqUIvG9LRo7jsCYUlYbHp6VHWVnD8dPCi7M0orfeM/omErX6V1t1m+0JeVB44EUm
VThYJyp6lBcgQFqAiABDQsaJsqGwodqbTEPcwHgq1oi85Un5CfM6dh9Z2n+4jkPs
-----END EC PRIVATE KEY-----
`,
        file: "ec.pem",
        name: "EC private key",
        ruleId: "private-key",
    },
    { content: "aws_access_key_id = AKIAQYLPMN" + "5HJ38DNCZG\n", name: "AKIA access key still detected", ruleId: "kingfisher.aws.1" },
];

const GITLEAKS_PATCH_FALSE_POSITIVES: RuleCase[] = [
    {
        content: 'token = "ghs_not-an-app-id_eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIifQ.signature"\n',
        name: "ghs_ with non-numeric app id",
        ruleId: "github-app-token",
    },
    { content: 'const marker = "sk-abc123T3Bl' + 'bkFJxyz789";\n', name: "short sk- marker string", ruleId: "openai-api-key" },
    { content: 'const pathToConfigFile = "./config.json";\n', name: "pat-prefixed identifier", ruleId: "airtable-personnal-access-token" },
    {
        content: `# sourcegraph indexer
commit aa2447c462ddaed16dc0` + `cf0b9cd7f78df0cac5e4
`,
        name: "git sha next to the word sourcegraph",
        ruleId: "sourcegraph-access-token",
    },
    {
        content: "mJeJ0b3bVQZu6P8AUEsHCFDBu3Q+EAAAWRAAAFBLAwQUAAgICAAYZxlbAAAAAAAAAAAAAAAAEwAA\n",
        name: "EAAA inside base64 zip fragment",
        ruleId: "square-access-token",
    },
    {
        content: `Content-Transfer-Encoding: base64

EAAAfS2ViRb1_n3U6t3wI973IPFlJ5F7` + `WRd-Px_BTHRJJbykE0_E8_5clLCZFNV8
`,
        file: "message.eml",
        name: "EAAA token in .eml attachment",
        ruleId: "square-access-token",
    },
    { content: 'password_policy = "excellent"\n', file: "policy.tf", name: "password_policy attribute", ruleId: "hashicorp-tf-password" },
    {
        content: '# Create secrets containing the database password, enabling "automatic rotation"\n',
        file: "comment.tf",
        name: "prose in a comment",
        ruleId: "hashicorp-tf-password",
    },
    {
        content: `apiVersion: v1
kind: ConfigMap
data:
  app.properties: bG9nLmxldmVsPWRlYnVnCmZlYXR1cmUuZmxhZz10cnVl
metadata:
  name: app-config
`,
        file: "cm.yaml",
        name: "ConfigMap data",
        ruleId: "kubernetes-secret-yaml",
    },
    {
        content: `-----BEGIN ENCRYPTED COSIGN PRIVATE KEY-----
S2QT6INGDpyOpxyB9JKmyLDUwMbqJfgLq+nbK894RxgG9oiZ+jgttMkFp1CW54M2
NhmABHkuEwjua058LeDKK6jDHz2oCtIsjhvNK4p7MZI/4kf3PGdlDcIfw84Jx3+l
8S0QPnuQ0/KZe6lOGPoZa70gyU/4gAIqK4+pdEuNb0lCo7pt/LI198F6sXyriJ1R
IaKM+t59SQW6PyEXD0fO8WXt/eqQm4m6bs0tj8HRYkQWO+eiEKDl3mm4vMdfPhLT
-----END ENCRYPTED COSIGN PRIVATE KEY-----
`,
        file: "cosign.key",
        name: "encrypted cosign key",
        ruleId: "private-key",
    },
    { content: '{"RoleId": "AROAQ7XK2LM9RT4VB7NP"}\n', file: "role.json", name: "IAM role id (AROA) is not an access key", ruleId: "kingfisher.aws.1" },
    { content: '{"RoleId": "AROAQ7XK2LM9RT4VB7NP"}\n', file: "role.json", name: "IAM role id (AROA) is not an access key", ruleId: "aws-access-token" },
];

describe("gitleaks rule fixes from data/gitleaks.patches.json", () => {
    it.each(GITLEAKS_PATCH_TRUE_POSITIVES)("$ruleId detects $name", async ({ content, file, ruleId }) => {
        expect.assertions(1);

        await expect(ruleIdsFor(content, file)).resolves.toContain(ruleId);
    });

    it.each(GITLEAKS_PATCH_FALSE_POSITIVES)("$ruleId ignores $name", async ({ content, file, ruleId }) => {
        expect.assertions(1);

        await expect(ruleIdsFor(content, file)).resolves.not.toContain(ruleId);
    });
});

const GENERIC_TRUE_POSITIVES: RuleCase[] = [
    {
        content: 'cookie_key = "+qoQB7xoFcSvTAxRzmaZsV2GenFmtX0moDoqW4sg8NFNl5oFA6Qd8Mj7zdn"\n',
        name: "base64 value starting with + (gitleaks#2331)",
        ruleId: "generic-api-key",
    },
    {
        content: 'cookie_key = "/qoQB7xoFcSvTAxRzmaZsV2GenFmtX0moDoqW4sg8NFNl5oFA6Qd8Mj7zdn"\n',
        name: "base64 value starting with / (gitleaks#2331)",
        ruleId: "generic-api-key",
    },
    {
        content: '{ "service": "svc", "operation": "AuthService.register", "auth_token": "bMjAdTdlzC5T4uUhf7kvmlP7HVDctQUy1xvC" }\n',
        file: "log.json",
        name: "secret after an unrelated comma-separated field (gitleaks#2229)",
        ruleId: "generic-api-key",
    },
    {
        content: 'callback = "https://example.com/hook?auth=kgafrfwA94hJ9WnywX0t0ZBfdTEmxI6C&format=json"\n',
        name: "query parameter terminated by & (gitleaks#1954)",
        ruleId: "generic-api-key",
    },
];

const GENERIC_FALSE_POSITIVES: RuleCase[] = [
    {
        content: '{ "service": "svc", "operation": "AuthService.register", "duration_p50_ms": 45 }\n',
        file: "log.json",
        name: "key name after an unrelated field (gitleaks#2229)",
        ruleId: "generic-api-key",
    },
    {
        content: '[{ "key": "ctrl+shift+alt+down", "command": "editor.action.copyLinesDownAction" }]\n',
        file: "keybindings.json",
        name: "VS Code keybinding chord (gitleaks#2195)",
        ruleId: "generic-api-key",
    },
    {
        content: "function x(e){return e.unk_token=e.unk_token,this.vocab=new Array(this.tokens)}\n",
        file: "bundle.min.js",
        name: "JS property copied from another identifier (gitleaks#2136)",
        ruleId: "generic-api-key",
    },
    {
        content: "    let privateKey: P256.Signing.PrivateKey\n",
        file: "Signer.swift",
        name: "Swift type-only declaration (gitleaks#2183)",
        ruleId: "generic-api-key",
    },
    {
        content: `spec:
  encryptedData:
    password: AgBPtYgjmUhBel31iEl2hpChYgCfrL1spNxnyVmihA/2O76UMFxFkM/R5Kjp1vRt+1fjORS/6ilI8ihN5KXSc7Tvo/hBKqFYY/kv5ZJr3J1TWDtkwtDDb+xHKas1VOqg6YYZYn9ZhyiA4uoRgnatmUdjAWtGSU8po+799NksnRH9ucAUsdMlHUvTCQCyEZDz/TddJ8HyS5SUkCnD8zRA9a9SkpXz9w3QlY7Zkuvqdt7s8Stqcbnr3yBdGBLEPH1qhT61qtc4xatws8phP9nhFyJfm5di4PzJ59FHz5r1pY4OjE2jBMptUsGr7CmY+uCu3ZR1zTOlUcR64cXQLioDnkHIfxIq2HZt/PlJhx2jIclHkCiHp6bR1IqfEouHgxzNNAL5wIScGebcy8F5n3/YNBDRzrZSgqbjG3uhkWKFLf6xuI5aHUQPFeNBTxaQWk8JzFalHlsZfYcMMDktXP/tKsf2rcDkdfrUnW5gcF+Ha6ili8GjHEAD6/Wj9KfzjsQGMrb9h+ImB+LK777pzNk8cL6j5IXAAjlsHUqJoUD/+Ydua+5ZMs1SWOpQaPRYpzbLGViYXjU2JgJngKtFI3OyV2dZAkg05rK+gqv81RKMGHZEM9YpvujA/C5Q52ryFlwRlOEVHzc0X0AWIRh/JUqBlIFXZ53Ncqe28+ajY75FnCttn6kfaqDeMqG3omjMyXHCabM6JOF8EFd0Nhcy/1k==
`,
        file: "sealed.yaml",
        name: "sealed-secrets encryptedData value (gitleaks#1728)",
        ruleId: "generic-api-key",
    },
    { content: 'token = "ghp_muxV5EbOApZOXzcy' + 'cDeZ6dqmVe5Mvxrv99Nc"\n', name: "token already reported by github-pat", ruleId: "generic-api-key" },
    { content: "const apiBaseUrl = env.CI_API_V4_URL;\n", file: "ci.ts", name: "env var reference", ruleId: "generic-api-key" },
];

describe("generic-api-key (compiles again; regex fixes and allowlists)", () => {
    it.each(GENERIC_TRUE_POSITIVES)("$ruleId detects $name", async ({ content, file, ruleId }) => {
        expect.assertions(1);

        await expect(ruleIdsFor(content, file)).resolves.toContain(ruleId);
    });

    it.each(GENERIC_FALSE_POSITIVES)("$ruleId ignores $name", async ({ content, file, ruleId }) => {
        expect.assertions(1);

        await expect(ruleIdsFor(content, file)).resolves.not.toContain(ruleId);
    });
});

describe("generic-api-key yields to overlapping findings", () => {
    it("still yields when redact masks the secrets", async () => {
        expect.assertions(2);

        const findings = await scanString('token = "ghp_muxV5EbOApZOXzcy' + 'cDeZ6dqmVe5Mvxrv99Nc"\n', "sample.txt", { redact: true });
        const ids = findings.map((finding) => finding.ruleId);

        expect(ids).toContain("github-pat");
        expect(ids).not.toContain("generic-api-key");
    });
});

describe("bundled ruleset compiles", () => {
    it("skips no rule except the two with known Unicode-size regexes", async () => {
        expect.assertions(1);

        const skipped = await inspectRuleset();

        // pypi-upload-token and vault-batch-token exceed the native regex size
        // limit under Unicode `\w`; tracked separately. generic-api-key used
        // to be in this list and silently never ran.
        expect(skipped.map((rule) => rule.ruleId).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["pypi-upload-token", "vault-batch-token"]);
    });
});
