import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';

import { PII_BLOCK_EVENT, findPii, findPiiInFile, findPiiInTurn, installPiiNetworkGuard, piiBlockMessage } from './piiGuard';

const kinds = (text: string) => findPii(text).map((h) => h.kind);

describe('findPii', () => {
  it('finds Taiwan IDs and resident numbers only when the checksum holds', () => {
    expect(kinds('客戶 A123456789 要開戶')).toEqual(['身分證字號']);
    expect(kinds('a123456789')).toEqual(['身分證字號']);
    expect(kinds('A123456788')).toEqual([]);
    expect(kinds('A800000014')).toEqual(['居留證號']);
    expect(kinds('AC00000003')).toEqual(['居留證號']);
  });

  it('finds card numbers by brand, length and Luhn', () => {
    expect(kinds('4111111111111111')).toEqual(['信用卡號']);
    expect(kinds('卡號 4111-1111-1111-1111')).toEqual(['信用卡號']);
    expect(kinds('4111111111111112')).toEqual([]);
    expect(kinds('1234567812345670')).toEqual([]);
  });

  it('finds mobile numbers in the usual spellings', () => {
    for (const phone of ['0912345678', '0912-345-678', '0912 345 678', '+886912345678', '+886 912 345 678']) {
      expect(kinds(`電話 ${phone}。`)).toEqual(['手機號碼']);
    }
    expect(kinds('02-12345678')).toEqual([]);
    expect(kinds('091234567')).toEqual([]);
  });

  it('leaves ordinary work text alone', () => {
    const text = [
      '部位 2026-11-02 END，損益 -1,234,567,890',
      'session 3f2a1c49-02d7-405a-a652-f2c4b5da2338',
      'sha256 663395c2a123456789ab0912345678ffee',
      '日期 20261102123456 代號 2330 台積電',
      'XA123456789 是料號',
    ].join('\n');
    expect(findPii(text)).toEqual([]);
  });

  it('reports each value once, masked', () => {
    const hits = findPii('A123456789 和 A123456789');
    expect(hits).toEqual([{ kind: '身分證字號', masked: 'A12****789' }]);
    expect(piiBlockMessage(hits)).toContain('A12****789');
    expect(piiBlockMessage(hits)).not.toContain('A123456789');
  });
});

describe('files', () => {
  it('reads the XML inside an Excel workbook', async () => {
    const zip = new JSZip();
    zip.file('xl/sharedStrings.xml', '<sst><si><t>A123456789</t></si></sst>');
    const file = new File([await zip.generateAsync({ type: 'uint8array' }) as BlobPart], '客戶.xlsx');
    expect(await findPiiInFile(file)).toEqual([{ kind: '身分證字號', masked: 'A12****789', source: '客戶.xlsx' }]);
  });

  it('reads UTF-16 text exports', async () => {
    const utf16 = new Uint8Array([...'tel 0912345678'].flatMap((c) => [c.charCodeAt(0), 0]));
    expect((await findPiiInFile(new File([utf16], 'export.txt'))).map((h) => h.kind)).toEqual(['手機號碼']);
  });

  it('checks the text and the attachments of a turn', async () => {
    const hits = await findPiiInTurn('請看附件', [new File(['4111111111111111'], 'a.csv')]);
    expect(hits.map((h) => h.source)).toEqual(['a.csv']);
  });
});

describe('installPiiNetworkGuard', () => {
  it('stops fetch and socket sends that carry personal data, and lets the rest through', async () => {
    const realFetch = vi.fn(async () => new Response('ok'));
    window.fetch = realFetch as unknown as typeof fetch;
    const realWsSend = vi.fn();
    WebSocket.prototype.send = realWsSend;
    const notices: string[] = [];
    window.addEventListener(PII_BLOCK_EVENT, (e) => notices.push((e as CustomEvent<{ message: string }>).detail.message));

    installPiiNetworkGuard();

    await expect(fetch('/api/user/drafts', { method: 'PUT', body: JSON.stringify({ text: '0912345678' }) })).rejects.toThrow('偵測到個資');
    await expect(fetch('/api/search?q=A123456789')).rejects.toThrow('偵測到個資');
    const form = new FormData();
    form.append('files', new File(['4111111111111111'], 'x.csv'));
    await expect(fetch('/api/assets/files', { method: 'POST', body: form })).rejects.toThrow('信用卡號');
    expect(realFetch).not.toHaveBeenCalled();

    await fetch('/api/user/drafts', { method: 'PUT', body: JSON.stringify({ text: '今天部位' }) });
    expect(realFetch).toHaveBeenCalledTimes(1);

    const socket = Object.create(WebSocket.prototype) as WebSocket;
    socket.send(JSON.stringify({ type: 'chat.send', content: '身分證 A123456789' }));
    expect(realWsSend).not.toHaveBeenCalled();
    socket.send(JSON.stringify({ type: 'chat.send', content: '查部位' }));
    expect(realWsSend).toHaveBeenCalledTimes(1);

    expect(notices).toHaveLength(4);
  });
});
