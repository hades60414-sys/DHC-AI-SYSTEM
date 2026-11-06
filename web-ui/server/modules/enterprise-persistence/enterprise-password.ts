import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt 參數：N=2^15、r=8、p=1，約 32 MiB 記憶體；maxmem 留餘裕。改參數不影響舊雜湊（參數寫在雜湊字串內）。
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * N * R * 2;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;

function derive(password: string, salt: Buffer, n: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: Math.max(MAX_MEMORY, 128 * n * r * 2) }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

/** 供同模組身份 service 與管理 CLI 使用：密碼政策檢查（長度 12–256、非全空白）。 */
export function requirePasswordPolicy(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH || !password.trim()) {
    throw new Error('ENTERPRISE_WEAK_PASSWORD');
  }
  return password;
}

/** 供同模組身份 service 與管理 CLI 使用：產生 `scrypt$N$r$p$salt$hash` 字串。 */
export async function hashEnterprisePassword(password: string): Promise<string> {
  requirePasswordPolicy(password);
  const salt = randomBytes(24);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/**
 * 供同模組身份 service 使用：常數時間比對。格式錯或參數超出範圍一律回 false（不丟例外，避免以錯誤區分帳號）。
 */
export async function verifyEnterprisePassword(password: string, stored: string): Promise<boolean> {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt' || typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isInteger) || n < 16384 || n > 1048576 || r < 8 || r > 32 || p < 1 || p > 4) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length < 16 || expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, salt, n, r, p);
  return timingSafeEqual(actual, expected);
}

/** 未知帳號時也要付出同等成本的雜湊（防止以回應時間列舉帳號）。 */
export const DUMMY_PASSWORD_HASH = ['scrypt', N, R, P, Buffer.alloc(24, 7).toString('base64url'), Buffer.alloc(KEY_LENGTH, 9).toString('base64url')].join('$');
