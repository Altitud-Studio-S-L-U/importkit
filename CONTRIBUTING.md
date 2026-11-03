# Contributing to ImportKit

Changes are proposed through pull requests. Fork the repository, create a focused branch, and explain the observable behavior your change adds or fixes. The maintainer controls merges into the protected default branch.

## Local setup

Use Node.js 24 or newer and npm:

```sh
npm ci
npm run check
npm run demo
```

This repository deliberately has no CI/CD workflows. Run the checks locally and include their actual results in your pull request. Distinguish passed checks, pre-existing failures, and checks you could not run.

## Before opening a pull request

- Keep the change focused and preserve public contracts outside its scope.
- Add behavior tests for relevant failures and boundaries. For regressions, show that the test fails before the fix when practical.
- Preserve valid tests. Do not relax an assertion or silently skip a failure to make the suite pass.
- Document changes to replay, record IDs, checkpoint compatibility, reader behavior, or destination responsibilities.
- Keep secrets, real customer data, local checkpoints, generated builds, and downloaded dependencies out of commits.
- Inspect the staged diff, including new files and dependency lockfile changes.

The built-in readers share a small contract. Propose additional dependencies or abstractions only when a concrete supported format or behavior requires them. A new reader needs documented decoding rules, a deterministic ID, resource limits, cancellation cleanup, and representative malformed-input tests.

## Reporting a bug

Include the Node.js version, operating system, expected behavior, actual behavior, and a minimal reproduction using synthetic data. For recovery bugs, describe which destination writes succeeded and which checkpoint was present. Do not post confidential input files or credentials.

For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue with exploit details.
