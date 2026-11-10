# Contributing to ImportKit

Changes are proposed through pull requests. Fork the repository, create a focused branch, and explain the observable behavior your change adds or fixes. The maintainer controls merges into the protected default branch.

## Local setup

Use Node.js 24 or newer and npm:

```sh
npm ci
npm run check
npm run demo
```

`npm run check` type-checks the library, runs the tests and checks the documentation: it type-checks every TypeScript example that imports the package and verifies links to files and headings in this repository.

Every pull request runs the same checks, the examples and a package dry run on Linux, macOS and Windows with Node.js 24 and 26, and a CodeQL scan. Run the checks locally first and include their actual results in your pull request. Distinguish passed checks, pre-existing failures, and checks you could not run. Releases are published by the maintainer, not by a workflow.

## Before opening a pull request

- Keep the change focused and preserve public contracts outside its scope.
- Add behavior tests for relevant failures and boundaries. For regressions, show that the test fails before the fix when practical.
- Preserve valid tests. Do not relax an assertion or silently skip a failure to make the suite pass.
- Document changes to replay, record IDs, checkpoint compatibility, reader behavior, or destination responsibilities.
- Keep secrets, real customer data, local checkpoints, generated builds, and downloaded dependencies out of commits.
- Inspect the staged diff, including new files and dependency lockfile changes.

The built-in readers share a small contract. Propose additional dependencies or abstractions only when a concrete supported format or behavior requires them. A new reader needs documented decoding rules, a deterministic ID, resource limits, cancellation cleanup, and representative malformed-input tests.

## Documentation style

The README helps a backend engineer decide in a few minutes whether ImportKit fits, and then run a first import. Contracts and details live in `docs/`, and the README links to them.

- Use one term per concept: source, reader, record, batch, destination, checkpoint, checkpoint store, import and run, as defined in the [API reference](docs/api.md#concepts).
- Write headings as tasks, in the active voice and the present tense. Keep one idea per paragraph.
- Explain each limitation once, where it applies, and link to it from elsewhere.
- Give every figure its unit, the ImportKit version it was measured with and its source.
- Make examples complete: real imports, and the orders domain used elsewhere. `npm run check` type-checks them.
- Avoid marketing adjectives, emojis and filler.

## Reporting a bug

Include the Node.js version, operating system, expected behavior, actual behavior, and a minimal reproduction using synthetic data. For recovery bugs, describe which destination writes succeeded and which checkpoint was present. Do not post confidential input files or credentials.

For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue with exploit details.
