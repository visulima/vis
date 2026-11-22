/**
 * Actions the generated GitHub workflows use (`vis sync ci-workflow`,
 * `vis sync codeowners --write-guard`, `vis release init --workflows`),
 * pinned to a commit so a moved tag cannot change what runs. The version is
 * kept for the trailing comment that tools like Dependabot and `vis update`
 * read to bump the pin.
 */
export interface GithubAction {
    name: string;
    sha: string;
    version: string;
}

const action = (name: string, sha: string, version: string): GithubAction => {
    return { name, sha, version };
};

export const GITHUB_ACTIONS = {
    cache: action("actions/cache", "55cc8345863c7cc4c66a329aec7e433d2d1c52a9", "v6.1.0"),
    checkout: action("actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"),
    setupBeam: action("erlef/setup-beam", "54075bcc5e249e4758d363f27d099f55d843f124", "v1.24.1"),
    setupBun: action("oven-sh/setup-bun", "0c5077e51419868618aeaa5fe8019c62421857d6", "v2.2.0"),
    setupDart: action("dart-lang/setup-dart", "6afc89df92d6eb3834022f73cd65adc8cdfcb92d", "v1.8.1"),
    setupDotnet: action("actions/setup-dotnet", "0f4a354dd5547a28c70b7853dbd95d5b67886e73", "v6.1.0"),
    setupGo: action("actions/setup-go", "b7ad1dad31e06c5925ef5d2fc7ad053ef454303e", "v7.0.0"),
    setupJava: action("actions/setup-java", "77dd5b2ce225ea11469928ac317850245a74ae78", "v6.2.0"),
    setupNode: action("actions/setup-node", "949feb2413d6458794dcd2491c4babbbce0c15c1", "v7.1.0"),
    setupPhp: action("shivammathur/setup-php", "eb7c497e18156a6bbabfef1d3a82760b9eda3962", "2.40.0"),
    setupPnpm: action("pnpm/action-setup", "73e46992e05b19abd31f2f3c20e0e7370d762115", "v6.1.1"),
    setupPython: action("actions/setup-python", "6d4fd22b20465ccc0f7354476588e8df7c9ca0e0", "v7.1.0"),
    setupRuby: action("ruby/setup-ruby", "de492cf36cbab201753d720ce4f4e336cd688c94", "v1.336.0"),
    setupRust: action("actions-rust-lang/setup-rust-toolchain", "a188e68d0fd2bd36ad51dccb2b07ba6e75105f30", "v2.0.1"),
    setupZig: action("mlugg/setup-zig", "d1434d08867e3ee9daa34448df10607b98908d29", "v2.2.1"),
} as const;

/** A `uses:` value for plain (unquoted) YAML: the pinned ref plus its version comment. */
export const usesPinned = ({ name, sha, version }: GithubAction): string => `${name}@${sha} # ${version}`;
