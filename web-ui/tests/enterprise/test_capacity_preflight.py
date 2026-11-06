"""容量工具只讀 OS free space；以合成容量驗邊界，不填滿真磁碟。"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT/'scripts/enterprise/檢查測試容量.py'

class CapacityPreflightTests(unittest.TestCase):
    def invoke(self, free_bytes, args=()):
        # OS disk_usage 是唯一替身：無副作用；CLI parsing、回傳與輸出用真程式。
        output = io.StringIO()
        with patch('shutil.disk_usage') as usage, patch.object(sys,'argv',[str(SCRIPT),*args]), contextlib.redirect_stdout(output):
            usage.return_value.free = free_bytes
            try:
                runpy.run_path(str(SCRIPT),run_name='__main__')
            except SystemExit as error:
                code = error.code
            else:
                code = 0
        return code,json.loads(output.getvalue())

    def test_before_vm_rejects_capacity_that_cannot_preserve_budget(self):
        code,result = self.invoke(7*1024**3,['--stage','before-vm'])
        self.assertEqual(code,3)
        self.assertEqual(result['status'],'PENDING_ENV')
        self.assertEqual(result['shortfall_bytes'],5*1024**3)

    def test_exact_boundary_is_sufficient_and_one_byte_less_is_not(self):
        code,result = self.invoke(12*1024**3,['--stage','before-vm'])
        self.assertEqual((code,result['shortfall_bytes']),(0,0))
        self.assertEqual(self.invoke(12*1024**3-1,['--stage','before-vm'])[0],3)

    def test_running_vm_reserve_catches_observed_low_space(self):
        self.assertEqual(self.invoke(1201381376,['--stage','running-vm'])[0],3)
        code,result = self.invoke(2*1024**3,['--stage','running-vm'])
        self.assertEqual((code,result['status']),(0,'CAPACITY_OK'))

    def test_filesystem_error_is_not_a_pass(self):
        output = io.StringIO()
        with patch('shutil.disk_usage',side_effect=OSError('synthetic path failure')),patch.object(sys,'argv',[str(SCRIPT),'--stage','before-vm']),contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as error:runpy.run_path(str(SCRIPT),run_name='__main__')
        self.assertEqual(error.exception.code,2)
        self.assertEqual(json.loads(output.getvalue())['status'],'BLOCKED_ENVIRONMENT')

    def test_invalid_stage_is_rejected(self):
        result = subprocess.run([sys.executable,str(SCRIPT),'--stage','bypass'],capture_output=True,text=True)
        self.assertEqual(result.returncode,2)
        self.assertIn('invalid choice',result.stderr)

    def test_pg_runner_rejects_before_evidence_secrets_or_docker_side_effects(self):
        with tempfile.TemporaryDirectory(prefix='dhc-capacity-test-') as temporary:
            evidence = Path(temporary)/'must-not-exist'
            def command(args,**kwargs):
                if '檢查測試容量.py' in str(args):return subprocess.CompletedProcess(args,3)
                raise AssertionError('QA attempted a command after denied capacity')
            with patch.object(sys,'argv',['驗證企業資料層.py','--evidence',str(evidence)]),patch('subprocess.run',side_effect=command),patch('subprocess.check_output',return_value='v22.23.4\n'):
                with self.assertRaises(SystemExit) as error:runpy.run_path(str(ROOT/'scripts/enterprise/驗證企業資料層.py'),run_name='__main__')
            self.assertEqual(error.exception.code,3)
            self.assertFalse(evidence.exists())

    def test_container_runner_rejects_before_creating_secrets(self):
        def command(args,**kwargs):
            if '檢查測試容量.py' in str(args):return subprocess.CompletedProcess(args,3)
            raise AssertionError('Container QA attempted a command after denied capacity')
        with patch('subprocess.run',side_effect=command),patch('tempfile.TemporaryDirectory',side_effect=AssertionError('secret directory must not be created')):
            with self.assertRaises(SystemExit) as error:runpy.run_path(str(ROOT/'tests/enterprise/容器驗收.py'),run_name='__main__')
        self.assertEqual(error.exception.code,3)

if __name__=='__main__':unittest.main()
