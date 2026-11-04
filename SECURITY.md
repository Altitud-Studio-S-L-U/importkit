# Security policy

ImportKit parses application-selected local files and calls application-supplied mapping and destination code. It does not authenticate uploads, authorize destination writes, sandbox callbacks, or provide a hosted service.

## Reporting a concern

Use GitHub's **Report a vulnerability** option when it is available for this repository. Otherwise, contact [Altitud Studio](https://altitudstudio.ad/es/) and ask for a private reporting channel.

Do not include credentials, customer files, private checkpoints, or exploit details in a public issue. A synthetic reproduction, affected version or commit, and a description of the potential impact help us investigate. No response-time or support-window guarantee is offered for this initial release.

## Integration boundaries

- Validate and authorize file paths before passing them to ImportKit. The library is not an upload boundary or path sandbox.
- Use immutable, application-owned source files.
- Keep checkpoints where only the importing service can write them: a local directory with restrictive permissions, or a table that service owns. ImportKit validates a loaded checkpoint's schema and identity, but a well-formed checkpoint written by someone else for the same import would still skip records.
- Treat all parsed values as untrusted. Validate them before SQL, shell commands, templates, or other sensitive sinks.
- Keep resource limits enabled and bound the work performed by custom readers, mapping, and destination callbacks.
- Make destination writes idempotent. Checkpoint recovery permits repeated deliveries and cannot undo external side effects.
- Avoid logging raw records or underlying error causes without reviewing their contents.
- The file checkpoint store's lock coordinates one local path. A custom store coordinates runs only if its `lock()` does. Neither is an authorization mechanism.

See the [README recovery contract](README.md#the-recovery-contract) for the current persistence and coordination limits.
