# Runtime constraints (template)

Replace every `<...>`. Delete sections that do not apply. Record how each fact was verified and when, so a later reader can tell if it is stale.

## Machines

| Role | Name used in chat | OS | Can run | Cannot run | Verified (date, how) |
|---|---|---|---|---|---|
| Main workstation | `<e.g. srv-main>` | `<Windows 10>` | `<Node 22, PowerShell 5.1, Python 3.x>` | `<...>` | `<...>` |
| Database host | `<e.g. srv-db>` | `<...>` | `<...>` | `<...>` | `<...>` |
| Colleague PCs | `<...>` | `<...>` | `<...>` | `<...>` | `<...>` |

## Shell default

- Commands handed to colleagues: `<CMD / PowerShell 5.1 / bash>`. If PowerShell is not guaranteed to be current, write for 5.1 (no `&&`, no `??`, UTF-8 with BOM for non-ASCII scripts).
- New automation on company machines: `<...>`.

## Endpoint security

Some endpoint products kill interpreters by executable name and still return exit code 0, which looks like success.

- Product and rule (if any): `<e.g. none / product name, which executables are blocked>`.
- Symptom check: run a script that writes a marker file; if the file is missing after exit 0, the process was killed.
- Approved alternative when blocked: `<e.g. use Node.js; request a whitelist from IT>`.
- Never rename an executable to get around a block.

## Network reach

| From | To | Works? | Notes |
|---|---|---|---|
| `<workstation>` | `<intranet web server>` | `<yes/no>` | `<e.g. only via jump host>` |
| `<workstation>` | internet | `<yes/proxy/no>` | `<...>` |

## Transferring files into the company network

`<e.g. zip attachments are blocked; send base64 text and decode with certutil -decode>`
