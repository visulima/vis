<p align="center">
  <a href="https://visulima.com">
    <img src="./.github/assets/visulima_logo.svg" width="200" />
    <h1 align="center">Visulima Vis</h1>
  </a>
</p>

<p align="center">
  <strong>Rust-backed tooling for the Visulima ecosystem: a task runner, an MCP server, a secret scanner, and a terminal UI.</strong>
</p>

<div align="center">

[![typescript-image][typescript-badge]][typescript-url]
[![mit licence][license-badge]][license]
[![Chat][chat-badge]][chat]
[![PRs Welcome][prs-welcome-badge]][prs-welcome]

</div>

---

## What is this?

This repository holds the packages that compile Rust code into Node.js native addons through [NAPI-RS](https://napi.rs). They were split out of [visulima/visulima](https://github.com/visulima/visulima) so their Rust builds and tests no longer slow down the rest of the monorepo.

Every package is still standalone. Install the one you need, and every other `@visulima/*` dependency comes from npm.

## Packages

| Package                                                               | Description                                                                                          | npm                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`@visulima/vis`](packages/tooling/vis)                               | Monorepo dev toolkit: task runner, remote caching, security scanning, git hooks, and AI agent hooks. | ![npm](https://img.shields.io/npm/v/@visulima/vis?style=flat-square&label=)                |
| [`@visulima/vis-mcp`](packages/tooling/vis-mcp)                       | Model Context Protocol server that exposes `vis` tooling to AI agents over stdio.                    | ![npm](https://img.shields.io/npm/v/@visulima/vis-mcp?style=flat-square&label=)            |
| [`@visulima/task-runner`](packages/tooling/task-runner)               | Task runner with caching for monorepo workspaces.                                                    | ![npm](https://img.shields.io/npm/v/@visulima/task-runner?style=flat-square&label=)        |
| [`@visulima/task-runner-client`](packages/tooling/task-runner-client) | Zero-dependency client for giving `task-runner` cache-correctness hints from inside a task.          | ![npm](https://img.shields.io/npm/v/@visulima/task-runner-client?style=flat-square&label=) |
| [`@visulima/secret-scanner`](packages/tooling/secret-scanner)         | Fast secret and credential scanner, a Rust port of gitleaks detection.                               | ![npm](https://img.shields.io/npm/v/@visulima/secret-scanner?style=flat-square&label=)     |
| [`@visulima/tui`](packages/terminal/tui)                              | React terminal UI library with a native Rust diff engine and an Ink-compatible API.                  | ![npm](https://img.shields.io/npm/v/@visulima/tui?style=flat-square&label=)                |

## Quick start

```bash
npm install @visulima/vis
npx vis --help
```

The native binding for your platform is installed automatically through `optionalDependencies`. Each package's README covers its own API.

## Development

Requirements: Node.js `^22.14.0 || >=24.10.0`, pnpm `11.28.2`, and a stable Rust toolchain (`rust-toolchain.toml` pins the channel).

```bash
pnpm install
pnpm -r run build:native                                       # Rust bindings (release)
pnpm -r run build
FORCE_COLOR=3 pnpm -r run test
```

- Build a package's native binding with its `build:native` script. Use `build:native:debug` for faster local iteration.
- The terminal suites assert on ANSI output, so set `FORCE_COLOR` when running outside a TTY.
- The `secret-scanner` binding test needs a release build, because the debug binary is too slow for its timeout.

CI runs `build-native.yml` on pushes and pull requests to `main`. It compiles the bindings for every target, and the `ci.yml` test job downloads the host binding for the same commit.

## Contributing

Read the [contributing guide](https://github.com/visulima/vis/blob/main/.github/CONTRIBUTING.md) first. Commits follow Angular-style conventional commits, scoped to the package name, for example `fix(secret-scanner): ...`.

<div align="center">

[![Chat][chat-badge]][chat]

</div>

---

<div align="center">
  <p>
    <sub>Built with ❤️ by</sub>
  </p>
  <p>
    <a href="https://anolilab.com">
      <img src="./.github/assets/anolilab.svg" alt="Anolilab" width="400" />
    </a>
  </p>
</div>

<!-- badges -->

[license-badge]: https://img.shields.io/badge/LICENSE-MIT-green?style=for-the-badge
[license]: https://github.com/visulima/vis/blob/main/LICENSE.md
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: https://github.com/visulima/vis/blob/main/.github/CONTRIBUTING.md
[chat-badge]: https://img.shields.io/discord/902465130518949899.svg?style=for-the-badge
[chat]: https://discord.gg/eajEZvk2PG
[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
