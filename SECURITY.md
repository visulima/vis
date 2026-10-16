# Security Policy

Thanks for helping keep Visulima and its users safe.

## Reporting a vulnerability

**Email `security@anolilab.de`** with as much detail as you can share. PGP / encrypted mail is welcome — request a key in your first message if you'd like to use one.

Alternatively, file a [GitHub Security Advisory](https://github.com/visulima/vis/security/advisories/new) directly. **Do not** open a public issue or discussion for security problems.

Useful things to include:

- A clear description of the vulnerability and the affected package(s) (`@visulima/vis`, `@visulima/secret-scanner`, etc.).
- Reproduction steps — a minimal repro repo, proof-of-concept script, or command invocation is ideal.
- Impact assessment as you see it (data exposure, RCE, path traversal, prototype pollution, ReDoS, DoS, …).
- The commit SHA or package version you tested against.
- Your name or handle if you'd like public credit once the issue is fixed.

## What to expect from us

- **Acknowledgement within 72 hours** of receipt.
- A coordinated disclosure timeline negotiated with you. Default target: a fix published within 30 days of confirmation for high-severity issues; longer is fine if the bug is low-severity or hard to reproduce.
- Credit in the release notes, unless you prefer to stay anonymous.
- No legal action against good-faith research that follows this policy.

## Supported versions

This repository publishes independently versioned packages. Security fixes are published for the **latest released major of each `@visulima/*` package**. Older majors are not patched — upgrade to the current major to receive fixes.

| Version                         | Supported          |
| ------------------------------- | ------------------ |
| Latest major of a given package | :white_check_mark: |
| Any previous major              | :x:                |

## Scope

In scope:

- Code in this repository: the packages under `packages/` (`vis`, `vis-mcp`, `task-runner`, `task-runner-client`, `secret-scanner`, `tui`) and their native Rust bindings.
- The `@visulima/*` packages published from this repository on npm.

Out of scope:

- Vulnerabilities in upstream dependencies — please report them to that dependency's maintainers. If one materially affects Visulima, we handle the coordinated upgrade.
- Findings that require a compromised local machine, a malicious dependency the user installed deliberately, or physical access.

## How this repository is checked

- Every change runs CodeQL, dependency review, and zizmor (workflow hardening) in CI, and the repository is scored with OpenSSF Scorecard.
- Native bindings are built from source in CI for every supported target.
