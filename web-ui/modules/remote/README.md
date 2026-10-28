# 遠端存取（選用）

**預設不需要這個模組。** DHC CLI 只在本機跑（`http://127.0.0.1:3001`）就能完整使用。只有你要從外網（家裡、手機、出差）連回這台機器時才需要。

這裡是範本，不含任何真實網址、密碼或金鑰；所有 `<...>` 都要換成你自己的值。

## 架構

```
瀏覽器 ──► Cloudflare Worker（登入閘門，cookie）──► Cloudflare Tunnel ──► 127.0.0.1:3001（DHC CLI）
```

- **Tunnel**：由這台機器主動連出到 Cloudflare，不用開防火牆埠、不用固定 IP。
- **Worker 閘門**：沒有登入 cookie 的請求一律只看到登入頁；登入後 cookie 有效 30 天。這一層是加在 DHC CLI 自己的登入之外，兩層都要過。

## 安全提醒（先做這三件事再開通道）

1. **伺服器只綁 127.0.0.1**。DHC CLI 預設就是這樣（`.env` 的 `HOST=127.0.0.1`）；不要改成 `0.0.0.0`，通道只需要本機位址。
2. **先設好登入再開通道**：DHC CLI 第一次開啟時會要求建立帳號，先建好；Worker 的 `GATE_PASSWORD` 用夠長的隨機字串。
3. **不要把 Tunnel 原始網址給別人**。快速通道的網址本身沒有登入，只分享 Worker 的網址。

## 安裝步驟

### 1. 安裝 cloudflared

照 Cloudflare 官方說明安裝：<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>

### 2. 開通道

快速通道（不需要 Cloudflare 帳號，但每次啟動網址都會變）：

```bash
node modules/remote/start-tunnel.mjs 3001
```

畫面會印出 `Tunnel URL: https://...`。

要固定網址就改用具名通道（named tunnel，需要 Cloudflare 帳號與網域），做法見 Cloudflare 文件；之後 `TUNNEL_ORIGIN` 填具名通道的網址即可，不用每次改。

### 3. 部署 Worker 閘門

```bash
cd modules/remote/worker
cp wrangler.toml.example wrangler.toml      # 把 <YOUR-WORKER-NAME> 換掉
npx wrangler login
npx wrangler secret put TUNNEL_ORIGIN       # 貼上第 2 步的 Tunnel URL
npx wrangler secret put GATE_PASSWORD       # <YOUR-LONG-RANDOM-PASSWORD>
npx wrangler secret put COOKIE_SECRET       # <ANOTHER-LONG-RANDOM-STRING>
npx wrangler deploy
```

部署完會得到 `https://<YOUR-WORKER-NAME>.<你的帳號>.workers.dev`，這才是要分享的網址。

快速通道重啟後網址會變，要重跑 `npx wrangler secret put TUNNEL_ORIGIN`。

### 4. 更新設定

把 `dhc.config.json` 的 `remote.enabled` 改成 `true`（記錄你有開遠端，方便之後檢查）。

## 關掉

停掉 `start-tunnel.mjs`（Ctrl+C）就斷線；要完全移除，執行 `npx wrangler delete`。改 `COOKIE_SECRET` 可以讓所有人立刻登出。
