> **給下載者**：這份是第一版（v1）的設計說明，安全模型與流程仍適用；現行程式是 V35（`Channel*.cs`、`Build-V35.ps1`、`Controller-V35.ps1`）。建置需要自己產生簽章與收件憑證（`release.json`、`outer-signer.cer` 不隨 repo 散布），屬進階元件，建議先讀懂再動手。

# RAGENT bounded agent channel v1

Last verified: 2026-09-17. This release transports four typed actions only: `health`, `gemma-smoke`, `reason`, `stop`. It cannot execute shell commands, SQL, scripts, generated code, or database jobs. Gemma output is advice. A `COMPLETED` report means the handler completed; `acceptance=NOT_INDEPENDENTLY_VERIFIED` is retained for ASTRA's review.

The existing CloudCLI assets service is unchanged. Agent -> HTTPS assets uses curl; no browser, SSH, new package, CloudCLI restart, or Windows startup task is required. Initial host setup and certificate pairing still require the user's RAGENT console.

## Files and ownership

- `Channel.cs`: .NET Framework executable, cryptography, fixed actions, durable journals, controller.
- `Build.ps1`: creates/reuses the workstation signing certificate, embeds public certs/config, compiles, prepares a hash-pinned bootstrap. Does not publish.
- `Controller.ps1`: explicit prepare/build, pairing, submit, receive, status, publish commands.
- `Setup-Agent.ps1`: RAGENT-only idempotent device certificate/state setup, encrypted enrollment, foreground launch.
- `Tests.cs`, `Test.ps1`: disposable certificate and loopback fixtures; no DB or external network.
- `release/`: public executable/base64, public setup/bootstrap, embedded public cert/config and local manifest. Publish only the three manifest allowlisted artifacts.
- `controller-state/`: private local state/reference files. Never publish this directory. Certificates' private keys remain nonexportable in CurrentUser/My; no private key file is created.
- VM state: `C:\dbclone\dhc-agent-v1`. Never delete/reinitialize its journal to resolve a failure.

## Security and execution contract

The VM certificate is nonexportable RSA3072, generated locally. Enrollment is device SignedCms(SHA256) inside AES256 EnvelopedCms to the existing workstation recipient. It remains untrusted until the user communicates the SHA256 certificate fingerprint printed on the VM console. `pair` requires that fingerprint explicitly. It never substitutes a fingerprint extracted from enrollment.

Jobs are signed with a separate workstation signing certificate and encrypted to the pinned device. Reports are signed by the device and encrypted to the workstation recipient. Every message verifies the exact pinned DER certificate, one SHA256 signer, one envelope recipient matching issuer/serial, AES256, schema, deployment, agent, target, and sequence. The bootstrap includes public certificates in its hash-pinned executable; it contains no private keys or passwords.

The host must actually hold NIC address `10.255.0.12`; DNS resolution is not accepted as host binding. Every operation holds an exclusive `FileShare.None` state-directory file lock across Windows/RDP sessions for its entire lifetime; a local named mutex is also retained. Source/target SQL passwords are cleared before child curl/model calls and inherited values are redacted in errors. TLS CA and hostname verification remain enabled; `--ssl-revoke-best-effort` is retained from the existing transport.

One job is outstanding at a time. Controller saves its encrypted command in the same atomic journal as sequence/job ID, before exporting the inbox. Repeating `publish-inbox` safely recovers a failed export/publish. Commands expire 15 minutes after submission. An expired valid command produces `REJECTED` when the agent next polls; receive that report before submitting a new command. Never reset the sequence to unblock a pending job.

Before executing a handler the runner flushes `RUNNING` to disk. Restart converts an unfinished `RUNNING` job to `INTERRUPTED`, without replay. A new explicit command is required. Completed/older sequences never execute again. The encrypted outbox is journaled before upload and retried unchanged after failure/restart. A crash after HTTP acknowledgement but before local save may create duplicate report assets; the controller deduplicates authenticated final reports by monotonic sequence/job ID/phase. Local state/signing failures STOP; they are never classified as transport retries.

Normal polling is 10 seconds with no AI invocation. Missing inbox (404) is idle. Transport failures back off 10–60 seconds. Curl response is capped at 256 KiB, connection timeout 10 seconds, poll deadline 25 seconds, upload deadline 60 seconds. Local Gemma response is capped at 64 KiB with a total 180-second deadline. `reason` accepts at most 2048 UTF-8 bytes, uses no tools, caps output at 512 tokens, and returns at most 4000 characters; this reserves room for instructions/template within the existing 4096-token Gemma context.

## Workstation commands (Windows PowerShell 5.1)

Run from this directory, using a user account with the existing recipient private key:

```powershell
.\Controller.ps1 -Command prepare
.\Test.ps1
.\Test-Publish.ps1
# Review source, test results and release manifest before publishing.
.\Controller.ps1 -Command publish-release
```

Give the user the initial bootstrap download command **with its SHA256 from `release/manifest.json` through the trusted chat**, and verify that hash before calling the downloaded bootstrap. The bootstrap then hash-checks the executable and setup script. Do not rebuild between publishing and delivering that hash.

The bootstrap starts the foreground runner and prints `PAIRING_SHA256`. The user sends that console value once. Locate the encrypted enrollment asset ending `-ragent-agent-enrollment.cms.b64.txt`, then:

```powershell
.\Controller.ps1 -Command pair -File 'C:\Users\demo\.cloudcli\assets\<receipt>-ragent-agent-enrollment.cms.b64.txt' -Fingerprint '<64 hex from VM console>'
.\Controller.ps1 -Command submit -Action health
.\Controller.ps1 -Command publish-inbox
# Locate the encrypted report asset ending -ragent-agent-report.cms.b64.txt.
.\Controller.ps1 -Command receive -File 'C:\Users\demo\.cloudcli\assets\<receipt>-ragent-agent-report.cms.b64.txt'
.\Controller.ps1 -Command status
```

After receiving/reviewing the final report, submit `gemma-smoke`, or `reason -PromptFile <UTF8 text file>` through the same submit/publish/receive sequence. The prompt remains local except for its encrypted command and the VM-local model request. `status` does not invoke the model or dump the encrypted wire.

For a clean stop, submit/publish `stop`; runner uploads its final report then exits. It retries an unacknowledged stop report before exiting. A later **explicit local** call to `C:\dbclone\dhc-agent-v1\start-agent.cmd` resumes polling while retaining the sequence and device certificate. Ctrl+C is an emergency local stop; an in-progress job is conservatively interrupted on restart. If enrollment upload failed, re-run `Setup-Agent.ps1`; it reuses the certificate/state.

## Verified limits

The fixture suite exercises real .NET CMS, filesystem state, a separate CLI process, real curl over loopback, and a loopback model HTTP server. It covers encryption/signature/pair rejection, target/deployment, invalid/expired jobs, replay, write-before-execute failures, crash recovery, retry/deduplication, missing export recovery, caps, valid JSON, BOM state, and stop/restart. The production wrong-host guards were executed locally and returned exit 1 without creating agent state.

Live validation completed on 2026-09-17: VM-console fingerprint matched, pairing succeeded, health reported the expected host and model status ok, and gemma-smoke returned GEMMA_READY. A synthetic reason call returned the correct arithmetic value but failed its requested number-only format; reason output remains advisory, never an executable command. No SQL was run. See project `.astra/channel-verification.json` for bounded acceptance evidence.

Repeated publication initially exposed PowerShell 5.1 coercion of `$null` to an empty backup-path string in File.Replace. Controller.ps1 now passes NullString.Value; Test-Publish.ps1 verifies initial/repeated publication and exact hashes in an isolated assets directory. This workstation-only correction did not change the VM executable or bootstrap hashes.
