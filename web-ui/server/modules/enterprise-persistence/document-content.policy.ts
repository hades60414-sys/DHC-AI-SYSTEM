import { createHash } from 'node:crypto';

/** 伺服器硬上限；部署可設更小的 maxBytes，但不能超過此值。 */
const HARD_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 255;
/** ZIP local header 掃描範圍；只用來判讀 Office 型別，不解壓縮、不信任壓縮內容。 */
const ZIP_SCAN_BYTES = 256 * 1024;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function startsWith(content: Buffer, signature: number[]) {
  return content.length >= signature.length && signature.every((byte, index) => content[index] === byte);
}

/** 依序找出 ZIP local file header 的檔名；壞掉的 header 直接停止，不丟例外。 */
function zipEntryNames(content: Buffer) {
  const names: string[] = [];
  const limit = Math.min(content.length, ZIP_SCAN_BYTES);
  for (let offset = content.indexOf(0x50); offset >= 0 && offset + 30 <= limit; offset = content.indexOf(0x50, offset + 1)) {
    if (content.readUInt32LE(offset) !== 0x04034b50) continue;
    const nameLength = content.readUInt16LE(offset + 26);
    const nameStart = offset + 30;
    if (nameStart + nameLength > content.length) break;
    names.push(content.subarray(nameStart, nameStart + nameLength).toString('utf8'));
  }
  return names;
}

function isOfficeZip(content: Buffer, partPrefix: string) {
  if (!startsWith(content, [0x50, 0x4b, 0x03, 0x04])) return false;
  const names = zipEntryNames(content);
  return names.includes('[Content_Types].xml') && names.some(name => name.startsWith(partPrefix));
}

/** UTF-8 文字：必須能嚴格解碼且不含 NUL（避免二進位冒充文字）。 */
function isStrictUtf8Text(content: Buffer) {
  if (content.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

/** allowlist：宣告型別 → 檔頭特徵檢查。HTML、SVG 等可主動執行的格式刻意不在清單。 */
const contentSignatures: Record<string, (content: Buffer) => boolean> = {
  'application/pdf': content => startsWith(content, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  [DOCX]: content => isOfficeZip(content, 'word/'),
  [XLSX]: content => isOfficeZip(content, 'xl/'),
  'image/png': content => startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': content => startsWith(content, [0xff, 0xd8, 0xff]),
  'text/plain': isStrictUtf8Text,
  'text/markdown': isStrictUtf8Text,
  'text/csv': isStrictUtf8Text,
};

function normalizeFilename(filename: unknown) {
  if (typeof filename !== 'string') throw new Error('ENTERPRISE_DOCUMENT_INVALID_FILENAME');
  const trimmed = filename.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.length > MAX_FILENAME_LENGTH
    || /[/\\]/.test(trimmed) || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error('ENTERPRISE_DOCUMENT_INVALID_FILENAME');
  }
  return trimmed;
}

function resolveMaxBytes(maxBytes: number | undefined) {
  const value = maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(value) || value < 1 || value > HARD_MAX_BYTES) throw new Error('ENTERPRISE_DOCUMENT_INVALID_LIMIT');
  return value;
}

/**
 * 供同模組 enterprise.service 在寫入版本前使用：伺服器端計算 SHA-256、驗大小、型別 allowlist 與檔頭一致性、檔名安全。
 * 回傳的 metadata 才可寫入資料庫；呼叫端給的 expectedSha256 只拿來比對，永遠不直接採用。
 */
export function inspectDocumentContent(
  input: { filename: string; mediaType: string; content: Buffer; expectedSha256?: string },
  limits?: { maxBytes?: number },
) {
  const maxBytes = resolveMaxBytes(limits?.maxBytes);
  const { content } = input;
  if (!Buffer.isBuffer(content) || content.length === 0) throw new Error('ENTERPRISE_DOCUMENT_EMPTY');
  if (content.length > maxBytes) throw new Error('ENTERPRISE_DOCUMENT_TOO_LARGE');
  const filename = normalizeFilename(input.filename);
  const matches = Object.hasOwn(contentSignatures, input.mediaType) ? contentSignatures[input.mediaType] : undefined;
  if (!matches) throw new Error('ENTERPRISE_DOCUMENT_TYPE_NOT_ALLOWED');
  if (!matches(content)) throw new Error('ENTERPRISE_DOCUMENT_TYPE_MISMATCH');
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (input.expectedSha256 !== undefined
    && (typeof input.expectedSha256 !== 'string' || input.expectedSha256.toLowerCase() !== sha256)) {
    throw new Error('ENTERPRISE_DOCUMENT_HASH_MISMATCH');
  }
  return { filename, mediaType: input.mediaType, byteSize: content.length, sha256 };
}
