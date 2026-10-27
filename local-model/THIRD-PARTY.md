# Gemma offline package review — 2026-09-17

## Sources pinned

- Google: `google/gemma-4-E4B-it-qat-q4_0-gguf`, revision `4b4a2c1d584be7264f87aac328a1bc739ce81b6c`.
- Model: `gemma-4-E4B_q4_0-it.gguf`, 5,154,941,280 bytes.
- Model SHA256 (Hugging Face LFS): `676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee`.
- llama.cpp: official `ggml-org/llama.cpp`, release `b10964`, `llama-b10964-bin-win-cpu-x64.zip`.
- Runtime SHA256 (GitHub asset digest): `917f39c076402c421224824607397af20f53625a60defc20e8dd22446bf4c5d7`.
- Both local artifacts matched those publisher digests before packaging/execution.

## Review scope and decision

SkillSpector is absent. Manual distribution review covered the release archive file listing, pinned server entry point, official server configuration documentation, model metadata/template, and our generated install/start/test scripts. This is not a complete C++ dependency audit or proof that the binaries are vulnerability-free.

The archive contains Windows EXE/DLL files and an OpenMP license; no installer hooks or PowerShell/Python bootstrap. The official server supports optional shell/file/MCP tools. These are capabilities, not evidence of malicious behavior, but are unnecessary for this delivery and are not enabled. The launcher clears inherited tool/MCP settings and database password variables in its child environment, binds only to loopback, selects a local model and offline mode, and disables agent/UI/MCP-proxy features. It does not use an automatic updater or a remote model URL.

Decision: use the pinned official distribution for local inference testing with the documented restricted launcher. No suspicious outbound destination or credential-harvesting behavior was identified in the reviewed material. Arbitrary CMD/SQL execution and DHC job transport are not implemented by this package.

## Installation behavior

The generated CMD installer downloads only this package's static files from the existing DHC attachment endpoint. Each decoded model part, the joined model, the runtime archive, and support files are checked against embedded SHA256 values. A mismatch stops installation. Verified decoded parts are retained for restart; successfully decoded base64 parts are individually removed. No source/destination SQL connection is opened, no database password is read, and no existing database report is changed.

The model's Apache-2.0 declaration is in the saved official model card. llama.cpp's MIT license is included in the installed support files. The optional visual projector is not included; this is text-only inference.
