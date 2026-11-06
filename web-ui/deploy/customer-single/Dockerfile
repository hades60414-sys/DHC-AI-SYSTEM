# syntax=docker/dockerfile:1
# 固定 E01 實測下載的 Node 22 bookworm 多平台 manifest digest。
# RUNTIME_BASE：執行期基底。預設＝與 build 相同的完整 bookworm（full profile 維持原行為）；
# AI Office（enterprise profile）由 compose 傳入 node:22-bookworm-slim（同 Node 22.23.4、同 glibc 2.36）以移除 ImageMagick 等用不到的 OS 套件。
ARG RUNTIME_BASE=node:22-bookworm@sha256:7702d8aa4d5910871692af4480eb3ba86f23047a6417a44d857d06c95d060d3f
FROM node:22-bookworm@sha256:7702d8aa4d5910871692af4480eb3ba86f23047a6417a44d857d06c95d060d3f AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 HUSKY=0
COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
RUN npm ci --no-audit --no-fund
COPY . .
# DHC_IMAGE_PROFILE：full（預設，維持原客戶單機 image）／enterprise（AI Office：ASTRA-012 移除個人模式依賴與 optional 原生套件）
ARG DHC_IMAGE_PROFILE=full
RUN npm run build && npm prune --omit=dev --no-audit --no-fund --ignore-scripts \
 && if [ "$DHC_IMAGE_PROFILE" = "enterprise" ]; then \
      npm prune --omit=dev --omit=optional --no-audit --no-fund --ignore-scripts \
      && rm -rf node_modules/@anthropic-ai/claude-agent-sdk node_modules/@anthropic-ai/claude-agent-sdk-* node_modules/@openai/codex node_modules/@openai/codex-darwin-* node_modules/@openai/codex-linux-* node_modules/@openai/codex-win32-* \
      && node scripts/release/enterprise-image-guard.mjs; \
    elif [ "$DHC_IMAGE_PROFILE" != "full" ]; then echo "unknown DHC_IMAGE_PROFILE" >&2; exit 1; fi

FROM ${RUNTIME_BASE} AS runtime
ARG DHC_SOURCE_SHA=unrecorded
# V5.2 RG-007：source＝實際建置的 repository（revision 必須能在這裡找到）；上游 attribution 另列 com.dhc.image.upstream
ARG DHC_SOURCE_REPOSITORY=https://github.com/hades60414-sys/DHC-AI-SYSTEM
ARG DHC_IMAGE_PROFILE=full
ARG RUNTIME_BASE
LABEL org.opencontainers.image.source=$DHC_SOURCE_REPOSITORY \
      org.opencontainers.image.revision=$DHC_SOURCE_SHA \
      com.dhc.image.upstream="https://github.com/hades60414-sys/dhc-cli（DHC CLI V3.2 上游，AGPL-3.0）" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      com.dhc.image.profile=$DHC_IMAGE_PROFILE \
      com.dhc.image.runtime-base=$RUNTIME_BASE
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 SERVER_PORT=3001 DHC_IMAGE_PROFILE=$DHC_IMAGE_PROFILE \
    DATABASE_PATH=/home/node/.cloudcli/auth.db VITE_IS_PLATFORM=false
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY package.json dhc.config.json LICENSE NOTICE README.md ./
COPY public/ ./public/
COPY workspace-template/ ./workspace-template/
COPY domains/ ./domains/
COPY db/enterprise/migrations/ ./db/enterprise/migrations/
COPY deploy/customer-single/healthcheck.mjs ./deploy/customer-single/healthcheck.mjs
RUN mkdir -p /home/node/.cloudcli "/home/node/DHC Workspace" && chown -R node:node /home/node \
    && mkdir -p /var/lib/dhc/blobs && chown node:node /var/lib/dhc/blobs && chmod 0700 /var/lib/dhc/blobs
# V5 供應鏈：enterprise 執行期不需要套件管理器（只有 legacy 外掛註冊與 CLI 自我更新會 spawn npm，企業模式皆不可達）。
# 移除 Node 基底 image 內建的 npm／npx／corepack／yarn，消除其相依（brace-expansion、ip-address、pacote、picomatch、sigstore…）的漏洞面。
# full profile 不受影響。之後斷言 node 與原生模組仍可載入、套件管理器確實不存在。
RUN if [ "$DHC_IMAGE_PROFILE" = "enterprise" ]; then \
      rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
             /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
      && for tool in npm npx corepack yarn yarnpkg; do if command -v "$tool" >/dev/null 2>&1; then echo "enterprise runtime still has $tool" >&2; exit 1; fi; done \
      && node -e "require('better-sqlite3'); require('node-pty'); console.log('runtime ok', process.version)"; \
    fi
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "deploy/customer-single/healthcheck.mjs"]
CMD ["node", "dist-server/server/index.js"]
