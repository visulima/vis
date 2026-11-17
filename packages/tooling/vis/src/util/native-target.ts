// Platform → `@visulima/vis-binding-<target>` slug. Keep in sync with
// bin/resolve-binary.mjs (the launcher's copy) and the NAPI loader in index.js.
// Best-effort musl detection for Linux. Defaults to glibc on any uncertainty.
const isMusl = (): boolean => {
    const { report } = process;

    if (typeof report?.getReport !== "function") {
        return false;
    }

    const data = report.getReport() as { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] };

    if (Array.isArray(data.sharedObjects)) {
        return data.sharedObjects.some((object) => object.includes("libc.musl-") || object.includes("ld-musl-"));
    }

    return !data.header?.glibcVersionRuntime;
};

const STATIC_TARGETS: Record<string, string> = {
    "darwin:arm64": "darwin-arm64",
    "darwin:x64": "darwin-x64",
    "win32:arm64": "win32-arm64-msvc",
    "win32:x64": "win32-x64-msvc",
};

/** The binding-package slug for this platform, or `undefined` when none is published. */
export const nativeTarget = (): string | undefined => {
    const { arch, platform } = process;

    if (platform === "linux") {
        if (arch === "arm64" || arch === "x64") {
            return `linux-${arch}-${isMusl() ? "musl" : "gnu"}`;
        }

        return undefined;
    }

    return STATIC_TARGETS[`${platform}:${arch}`];
};
