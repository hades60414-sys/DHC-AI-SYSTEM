#!/usr/bin/env bash
# Linux setup for Ollama + model pull
set -euo pipefail
MODEL="${1:-qwen2.5-coder:14b}"
echo "== agent-harness: setup-ollama =="
echo "Model: $MODEL"

if ! command -v ollama >/dev/null 2>&1; then
  # NOTE: official installer via curl|sh (unpinned). Prefer your distro package
  # manager if available; or download first, inspect, then run:
  #   curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh && less /tmp/ollama-install.sh && sh /tmp/ollama-install.sh
  echo "Installing Ollama (official install.sh)..."
  curl -fsSL https://ollama.com/install.sh | sh
fi

if ! curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "Starting ollama serve..."
  nohup ollama serve >/tmp/ollama-serve.log 2>&1 &
  sleep 3
fi

curl -fsS --max-time 5 http://127.0.0.1:11434/api/tags >/dev/null
ollama pull "$MODEL"
ollama run "$MODEL" "Reply with exactly: HARNESS_OK"
echo "DONE. Next: bash ops/healthcheck.sh"
