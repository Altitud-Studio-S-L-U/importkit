# Security policy

ImportKit parses files that your application selects and calls the mapping, destination and checkpoint code that your application supplies. It does not authenticate uploads, authorize destination writes, sandbox callbacks or run as a hosted service.

## Report a vulnerability

Use GitHub's **Report a vulnerability** option on this repository. If it is unavailable, contact [Altitud Studio](https://altitudstudio.ad/es/) and ask for a private channel.

Do not put credentials, customer files, private checkpoints or exploit details in a public issue. A synthetic reproduction, the affected version or commit and the potential impact help us investigate. Fixes are released in a new version of the latest release line.

## Threat model

| Input | Trusted | How ImportKit handles it |
| --- | --- | --- |
| Source content | No | Bounds the size of the source, of each record and the number of records. Rejects invalid UTF-8 and reserved CSV headers, and builds CSV records without a prototype. Error messages and reports never include source values, and reports include schema messages, which can quote them, only with `includeSchemaMessages`. |
| What a checkpoint store loads | No | Validates the checkpoint's schema and identity before using it, and bounds the size of checkpoint files. |
| Source paths | Chosen by your application | Opens the path as given. ImportKit is not a path sandbox: validate and authorize paths first. |
| Readers, callbacks and checkpoint stores | Yes | Runs them in your process with its permissions. ImportKit cannot bound their memory, time or side effects. |

## Integration boundaries

- Import immutable files that your application owns. Copy an upload to such a location before importing it.
- Keep checkpoints where only the importing service can write them: a directory with restrictive permissions, or a table that service owns. A malformed checkpoint is rejected, but a well-formed one written by someone else for the same import would make the next run skip records.
- Treat parsed values as untrusted. Validate them before they reach SQL, shell commands, templates or other sensitive sinks.
- Keep resource limits enabled, and bound the work of custom readers, mapping and destination code.
- Make destination writes idempotent. Recovery can deliver a batch again, and it cannot undo external side effects such as emails or payments.
- Review an error's `cause` before logging it: it can contain application data or file content.
- The file checkpoint store's lock coordinates runs that use one local path. A custom store coordinates runs only if its `lock()` does. Neither is an authorization mechanism.

[Recovery](docs/recovery.md) describes the persistence and coordination guarantees in detail.
