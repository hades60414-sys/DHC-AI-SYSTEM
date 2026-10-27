# 讓 Grok / 其他客戶端指到本機模型

Ollama 提供 OpenAI-compatible 端點（版本新的 Ollama）：

```text
Base URL:  http://127.0.0.1:11434/v1
API Key:   ollama   （任意非空字串通常即可）
Model:     你 ollama list 看到的名字，例如 qwen2.5-coder:14b
```

## Grok CLI / Build

若支援 custom / BYOK OpenAI endpoint：

1. Base URL 設成上面  
2. Model 設成本機已 pull 的名稱  
3. 規則仍用本包 `rules/AGENTS.md`（不要改靠模型權重記規則）

## 從另一台電腦連 4080

**推薦：Tailscale**

1. 兩台都登入同一 Tailscale 帳號  
2. 在 4080 跑 `Tailscale IP`（例如 `100.x.y.z`）  
3. 客戶端 Base URL：`http://100.x.y.z:11434/v1`  
4. Windows 防火牆若擋入站，只允許 Tailscale 介面或該 port 給 tailscale 網段  

**不推薦：家用路由器直接 port forward 11434**

## 最小 curl 測試

```powershell
curl http://127.0.0.1:11434/api/tags
```

```powershell
curl http://127.0.0.1:11434/api/generate -Method POST -ContentType "application/json" -Body '{"model":"qwen2.5-coder:14b","prompt":"ping","stream":false}'
```

## 額度

這是你自己的 GPU。沒有雲端 token 帳單，但有：

- 電費與散熱  
- 磁碟（模型數 GB～數十 GB）  
- 若公網裸奔：被掃到會變別人的免費算力  

本 harness **不包含**自動 24h 高頻 keep-warm（本地模型不需要雲端那種防休眠）；需要時手動 `ollama run` 即可。
