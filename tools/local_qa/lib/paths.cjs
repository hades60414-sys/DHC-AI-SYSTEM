'use strict';
// Shared paths, ports and model file locations for the local QA tool. Pure constants, no side effects.
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');           // tools/local_qa
const WS = path.resolve(ROOT, '..', '..');             // Harness優化

const BIN = path.join(WS, 'gemma-offline', 'runtime', 'llama-server.exe');
const CHAT_MODEL = path.join(WS, 'experiments', 'model_compare_20260926', 'models', 'Qwen3.5-4B-Q4_0.gguf');
const EMBED_MODEL = path.join(WS, 'experiments', 'arch_followup_20260929', 'models', 'Qwen3-Embedding-0.6B-Q8_0.gguf');
const RERANK_MODEL = path.join(WS, 'experiments', 'arch_followup_20260929', 'models', 'qwen3-reranker-0.6b-q8_0.gguf');

const PORTS = { chat: 18110, embed: 18111, rerank: 18112 };

const STATE_DIR = path.join(ROOT, 'state');
const LOG_DIR = path.join(ROOT, 'logs');
const INDEX_DIR = path.join(ROOT, 'indexes');
const EVAL_DIR = path.join(ROOT, 'eval_runs');
const SERVERS_JSON = path.join(STATE_DIR, 'servers.json');

module.exports = { ROOT, WS, BIN, CHAT_MODEL, EMBED_MODEL, RERANK_MODEL, PORTS, STATE_DIR, LOG_DIR, INDEX_DIR, EVAL_DIR, SERVERS_JSON };
