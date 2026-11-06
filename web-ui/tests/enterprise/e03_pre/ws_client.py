"""E03-PRE 專用的最小 RFC 6455 WebSocket client（只用 Python 標準庫）。

只供黑箱負向測試：直接對伺服器做 upgrade、送出 masked text frame、讀取 text frame。
不支援 TLS、延伸或分段訊息；伺服器回傳 binary/fragment 時以原始 bytes 回報。
"""
import base64
import hashlib
import json
import os
import socket
import struct

GUID = b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


class UpgradeRejected(Exception):
    """伺服器沒有回 101 Switching Protocols。"""

    def __init__(self, status_line):
        super().__init__(status_line)
        self.status_line = status_line


class WebSocket:
    def __init__(self, sock):
        self.sock = sock
        self.buffer = b''

    @classmethod
    def connect(cls, host, port, path, headers=None, timeout=10.0):
        sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [f'GET {path} HTTP/1.1', f'Host: {host}:{port}', 'Upgrade: websocket',
                 'Connection: Upgrade', f'Sec-WebSocket-Key: {key}', 'Sec-WebSocket-Version: 13']
        for name, value in (headers or {}).items():
            lines.append(f'{name}: {value}')
        sock.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode())
        response = b''
        while b'\r\n\r\n' not in response:
            chunk = sock.recv(4096)
            if not chunk:
                break
            response += chunk
        head, _, rest = response.partition(b'\r\n\r\n')
        status_line = head.split(b'\r\n', 1)[0].decode(errors='replace')
        if ' 101 ' not in status_line + ' ':
            sock.close()
            raise UpgradeRejected(status_line or 'NO_RESPONSE')
        expected = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest()).decode()
        if expected.encode() not in head:
            sock.close()
            raise UpgradeRejected('BAD_ACCEPT_KEY')
        ws = cls(sock)
        ws.buffer = rest
        return ws

    def send_text(self, text):
        payload = text.encode()
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack('!H', length)
        else:
            header.append(0x80 | 127)
            header += struct.pack('!Q', length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def send_json(self, value):
        self.send_text(json.dumps(value))

    def _read_exact(self, count):
        while len(self.buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError('socket closed')
            self.buffer += chunk
        data, self.buffer = self.buffer[:count], self.buffer[count:]
        return data

    def recv(self):
        """回傳 (opcode, payload bytes)。close frame 的 opcode 為 8。"""
        first, second = self._read_exact(2)
        opcode = first & 0x0F
        length = second & 0x7F
        if length == 126:
            length = struct.unpack('!H', self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack('!Q', self._read_exact(8))[0]
        if second & 0x80:
            mask = self._read_exact(4)
            raw = self._read_exact(length)
            return opcode, bytes(b ^ mask[i % 4] for i, b in enumerate(raw))
        return opcode, self._read_exact(length)

    def collect_text(self, seconds, stop_marker=None):
        """在 seconds 內收集所有 text frame；看到 stop_marker 立即返回。"""
        self.sock.settimeout(0.5)
        import time
        deadline = time.monotonic() + seconds
        texts = []
        while time.monotonic() < deadline:
            try:
                opcode, payload = self.recv()
            except (socket.timeout, TimeoutError):
                continue
            except (ConnectionError, OSError):
                texts.append('<<SOCKET_CLOSED>>')
                break
            if opcode == 8:
                texts.append('<<CLOSE_FRAME>>')
                break
            if opcode == 1:
                texts.append(payload.decode(errors='replace'))
                if stop_marker and stop_marker in ''.join(texts):
                    break
        return texts

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass
