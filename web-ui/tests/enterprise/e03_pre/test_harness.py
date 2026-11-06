"""E03-PRE harness 自身的單元測試：防止假 RED / 假 GREEN，不啟動伺服器。"""
import socket
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_e03_pre import marker_seen, record, results  # noqa: E402
from ws_client import UpgradeRejected, WebSocket  # noqa: E402


class MarkerTests(unittest.TestCase):
    command = "printf 'E03%s\\n' PRE_X"

    def test_echoed_command_alone_is_not_execution(self):
        self.assertFalse(marker_seen('$ ' + self.command + '\r\n', self.command, 'E03PRE_X'))

    def test_executed_output_is_detected(self):
        self.assertTrue(marker_seen('$ ' + self.command + '\r\nE03PRE_X\r\n', self.command, 'E03PRE_X'))


class RecordTests(unittest.TestCase):
    def tearDown(self):
        results.clear()

    def test_req_and_ctrl_verdicts(self):
        record('R', 'REQ', 'e', 'm', 'r', 'o', secure=False, severity='HIGH')
        record('C', 'CTRL', 'e', 'm', 'r', 'o', secure=False)
        self.assertEqual([r['verdict'] for r in results], ['RED', 'FAIL'])
        self.assertEqual(results[0]['severity_if_red'], 'HIGH')


class UpgradeTests(unittest.TestCase):
    def test_non_101_is_reported_as_rejected(self):
        server = socket.socket()
        server.bind(('127.0.0.1', 0))
        server.listen(1)
        port = server.getsockname()[1]

        def respond():
            conn, _ = server.accept()
            conn.recv(4096)
            conn.sendall(b'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
            conn.close()

        thread = threading.Thread(target=respond)
        thread.start()
        with self.assertRaises(UpgradeRejected) as caught:
            WebSocket.connect('127.0.0.1', port, '/ws')
        thread.join()
        server.close()
        self.assertIn('401', caught.exception.status_line)


if __name__ == '__main__':
    unittest.main()
