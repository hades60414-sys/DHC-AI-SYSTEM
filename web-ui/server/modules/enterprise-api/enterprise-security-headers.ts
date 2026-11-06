import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import type { NextFunction, Request, Response } from 'express';

/**
 * 企業模式全域安全標頭（RC-FIX V3 安全複查）。Office token 存在 sessionStorage，CSP 是防 XSS 竊取 token 的主要防線：
 * - script-src 只允許同源檔案與 index.html 內建 service worker 註冊片段的 SHA-256（啟動時由實際建置檔計算，不放 'unsafe-inline'）。
 * - style-src 允許 'unsafe-inline'（React style 屬性需要）與 Google Fonts；font-src 允許 fonts.gstatic.com。
 * - 禁止被嵌入（frame-ancestors 'none'）、不送 Referrer、關閉相機／麥克風／定位。
 * HSTS 由前端 TLS 終端（客戶反向代理）設定，應用層不送（應用本身可能以 HTTP 在內網服務）。
 * 下載端點自行設定更嚴格的 CSP（default-src 'none'; sandbox），會覆寫這裡的值。
 */
export function inlineScriptHashes(indexHtmlPath: string) {
  if (!existsSync(indexHtmlPath)) return [];
  const html = readFileSync(indexHtmlPath, 'utf8');
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
}

export function createEnterpriseSecurityHeaders(options: { indexHtmlPath: string }) {
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(options.indexHtmlPath).join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return function enterpriseSecurityHeaders(_req: Request, res: Response, next: NextFunction) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
  };
}
