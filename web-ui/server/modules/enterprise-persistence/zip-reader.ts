import { crc32, inflateRawSync } from 'node:zlib';

/**
 * ASTRA-003：有界的 ZIP（OOXML）讀取器，取代「JSZip.loadAsync + checkCRC32」整包解壓。
 *
 * 1. 先只讀 central directory，在解壓任何位元組前驗證整個封包：
 *    entry 數、每個 entry 宣告大小、所有 entry 宣告總和、壓縮比例、加密旗標、ZIP64、路徑（.. 與絕對路徑）、重複名稱。
 * 2. 只解壓呼叫端需要的 entry；inflateRawSync 以 maxOutputLength 硬性限制實際輸出（宣告大小造假也無法超過），
 *    並驗證實際長度＝宣告長度、CRC32＝宣告值。用不到的大型 entry 永遠不會被解壓或計算 CRC。
 * 任何違規都丟 ENTERPRISE_EXTRACTION_FAILED（格式／安全問題）或 ENTERPRISE_EXTRACTION_TOO_LARGE（資源上限）。
 */
export const ZIP_LIMITS = {
  maxEntries: 2000,
  maxEntryBytes: 20 * 1024 * 1024,
  maxTotalDeclaredBytes: 64 * 1024 * 1024,
  /** 單一 entry 的 uncompressed／compressed 上限（小 entry 免檢，避免正常的小 XML 誤判） */
  maxRatio: 200,
  ratioFloorBytes: 1024 * 1024,
  maxNameBytes: 512,
} as const;

type Entry = { name: string; method: number; flags: number; crc: number; compressedSize: number; uncompressedSize: number; localOffset: number };

function failed(): never {
  throw new Error('ENTERPRISE_EXTRACTION_FAILED');
}
function tooLarge(): never {
  throw new Error('ENTERPRISE_EXTRACTION_TOO_LARGE');
}

function findEndOfCentralDirectory(buffer: Buffer) {
  // EOCD 22 bytes + 最多 65535 bytes comment
  const stop = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= stop; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return failed();
}

/** 讀取並驗證 central directory；不解壓任何資料。 */
export function inspectZip(buffer: Buffer, limits = ZIP_LIMITS) {
  if (buffer.length < 22) failed();
  const eocd = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const cdDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) failed(); // 不支援分割封包
  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) failed(); // ZIP64 不支援
  if (totalEntries > limits.maxEntries) tooLarge();
  if (cdOffset + cdSize > eocd) failed();

  const entries = new Map<string, Entry>();
  let pointer = cdOffset;
  let declaredTotal = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (pointer + 46 > eocd || buffer.readUInt32LE(pointer) !== 0x02014b50) failed();
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const crc = buffer.readUInt32LE(pointer + 16);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    if (nameLength === 0 || nameLength > limits.maxNameBytes) failed();
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    pointer += 46 + nameLength + extraLength + commentLength;
    if (pointer > eocd) failed();
    if (flags & 0x1) failed(); // 加密
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) failed(); // ZIP64
    if (method !== 0 && method !== 8) failed(); // 只接受 stored／deflate
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..') || /[\u0000-\u001f]/.test(name)) failed();
    if (entries.has(name)) failed(); // 重複名稱可用來混淆解析器
    if (uncompressedSize > limits.maxEntryBytes) tooLarge();
    if (uncompressedSize > limits.ratioFloorBytes && uncompressedSize > Math.max(1, compressedSize) * limits.maxRatio) tooLarge();
    declaredTotal += uncompressedSize;
    if (declaredTotal > limits.maxTotalDeclaredBytes) tooLarge();
    if (localOffset + 30 + compressedSize > cdOffset) failed();
    entries.set(name, { name, method, flags, crc, compressedSize, uncompressedSize, localOffset });
  }
  if (pointer !== cdOffset + cdSize) failed();
  return { entries, declaredTotal };
}

/** 解壓單一 entry：輸出長度以宣告大小為硬上限，並驗證長度與 CRC32。 */
function readEntry(buffer: Buffer, entry: Entry) {
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) failed();
  const localMethod = buffer.readUInt16LE(local + 8);
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  if (localMethod !== entry.method) failed();
  const localName = buffer.subarray(local + 30, local + 30 + nameLength).toString('utf8');
  if (localName !== entry.name) failed(); // local header 與 central directory 不一致
  const start = local + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  if (compressed.length !== entry.compressedSize) failed();
  let output: Buffer;
  if (entry.method === 0) {
    output = compressed;
  } else {
    try {
      // maxOutputLength：就算宣告大小是假的，實際解壓也不會超過宣告值＋1（超過即拋錯）
      output = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize + 1) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') tooLarge();
      return failed();
    }
  }
  if (output.length !== entry.uncompressedSize) failed();
  if ((crc32(output) >>> 0) !== entry.crc) failed();
  return output;
}

/** 驗證整個封包後，只回傳指定 entry 的 UTF-8 文字（不存在則 undefined）。 */
export function createZipReader(buffer: Buffer, limits = ZIP_LIMITS) {
  const { entries } = inspectZip(buffer, limits);
  return {
    has: (name: string) => entries.has(name),
    text(name: string) {
      const entry = entries.get(name);
      if (!entry) return undefined;
      return new TextDecoder('utf-8', { fatal: false }).decode(readEntry(buffer, entry));
    },
  };
}
