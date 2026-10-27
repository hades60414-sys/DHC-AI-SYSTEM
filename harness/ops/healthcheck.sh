#!/usr/bin/env bash
# Health check: package files + ~/.claude install + (optional) local Ollama.
# Ollama is optional by default; set REQUIRE_OLLAMA=1 to make it required.
OK=1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

echo "== healthcheck =="

# 1) Package files
for f in rules/AGENTS.md rules/CLAUDE.md rules/MIDOFFICE.md memory/MEMORY.md templates/BOOTSTRAP_PROMPT.md; do
  if [ -f "$ROOT/$f" ]; then echo "OK file $f"; else echo "MISS $f"; OK=0; fi
done

# 2) ~/.claude install state
if [ -f "$CLAUDE_DIR/CLAUDE.md" ]; then
  echo "OK installed $CLAUDE_DIR/CLAUDE.md"
  for imp in AGENTS.md MIDOFFICE.md; do
    if [ ! -f "$CLAUDE_DIR/$imp" ]; then
      echo "FAIL: $CLAUDE_DIR/$imp missing (CLAUDE.md imports it)"; OK=0
    fi
  done
else
  echo "FAIL: not installed to $CLAUDE_DIR"; OK=0
fi
PKG_SKILLS=$(find "$ROOT/skills" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
PKG_AGENTS=$(find "$ROOT/agents" -maxdepth 1 -name "*.md" 2>/dev/null | wc -l)
INST_SKILLS=$(find "$CLAUDE_DIR/skills" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
INST_AGENTS=$(find "$CLAUDE_DIR/agents" -maxdepth 1 -name "*.md" 2>/dev/null | wc -l)
if [ "$INST_SKILLS" -lt "$PKG_SKILLS" ]; then echo "FAIL: skills installed $INST_SKILLS < package $PKG_SKILLS"; OK=0
else echo "OK skills installed: $INST_SKILLS (package: $PKG_SKILLS)"; fi
if [ "$INST_AGENTS" -lt "$PKG_AGENTS" ]; then echo "FAIL: agents installed $INST_AGENTS < package $PKG_AGENTS"; OK=0
else echo "OK agents installed: $INST_AGENTS (package: $PKG_AGENTS)"; fi

# 3) Local Ollama (optional unless REQUIRE_OLLAMA=1)
if curl -fsS --max-time 8 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  MODELS=$(curl -fsS --max-time 8 http://127.0.0.1:11434/api/tags | grep -o '"name":"[^"]*"' | head -5)
  echo "OLLAMA_UP $MODELS"
  if [ -z "$MODELS" ]; then
    echo "WARN: no models pulled yet - run setup-ollama.sh"
    [ "$REQUIRE_OLLAMA" = "1" ] && OK=0
  fi
else
  if [ "$REQUIRE_OLLAMA" = "1" ]; then echo "FAIL: Ollama not reachable on 127.0.0.1:11434"; OK=0
  else echo "INFO: Ollama not reachable on 127.0.0.1:11434 (optional; run setup-ollama.sh if this machine should serve local models)"; fi
fi

# 4) Public-bind check
case "$OLLAMA_HOST" in
  *0.0.0.0*) echo "WARN: OLLAMA_HOST=$OLLAMA_HOST (public bind - use Tailscale/Tunnel + auth instead)";;
esac

if [ "$OK" = "1" ]; then echo "RESULT: OK"; exit 0; else echo "RESULT: FAIL"; exit 1; fi
