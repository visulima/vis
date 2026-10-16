# visulima/vis

Workspace for the Rust-backed Visulima tooling. It was split out of
[visulima/visulima](https://github.com/visulima/visulima) so that the native
builds and their CI no longer slow down the rest of the monorepo.

## Packages

| Package | Path |
| --- | --- |
| `@visulima/vis` | `packages/tooling/vis` |
| `@visulima/vis-mcp` | `packages/tooling/vis-mcp` |
| `@visulima/task-runner` | `packages/tooling/task-runner` |
| `@visulima/task-runner-client` | `packages/tooling/task-runner-client` |
| `@visulima/secret-scanner` | `packages/tooling/secret-scanner` |
| `@visulima/tui` | `packages/terminal/tui` |

Every other `@visulima/*` dependency is consumed from npm.

## Development

```bash
pnpm install
pnpm --filter @visulima/secret-scanner run build:native:debug   # host Rust binding
pnpm -r run build
FORCE_COLOR=3 pnpm -r run test
```

The Rust crates are built by `build:native` in each package and by
`.github/workflows/build-native.yml`. The terminal suites assert on ANSI output,
so run them with `FORCE_COLOR` set when the shell is not a TTY.

## Releases

Packages are versioned independently and tagged `@visulima/<name>@<version>`.
Release tags from the monorepo were carried over with their history.
