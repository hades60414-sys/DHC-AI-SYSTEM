"""跨 cluster QA 的拒絕路徑；不啟 Docker、不使用真密碼、不修改既有資料。"""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/enterprise/驗證跨叢集還原.py'
HOST = 'unix://' + str(Path.home() / '.colima/dhc-e02b-dr-unit/docker.sock')


def load_runner():
    spec = importlib.util.spec_from_file_location('dhc_cross_cluster_qa', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CrossClusterSafetyTests(unittest.TestCase):
    def test_implicit_remote_and_other_local_daemons_are_rejected_before_commands(self):
        module = load_runner()
        with tempfile.TemporaryDirectory(dir=ROOT / 'evidence') as temporary:
            evidence = Path(temporary) / 'must-not-exist'
            for host in ['', 'tcp://example.invalid:2375', 'unix:///var/run/docker.sock',
                         'unix://' + str(Path.home() / '.colima/default/docker.sock')]:
                with self.subTest(host=host), patch.dict(os.environ, {'DOCKER_HOST': host}), patch('subprocess.run', side_effect=AssertionError('no command authorized')):
                    with self.assertRaises(SystemExit) as error:
                        module.main(['--evidence', str(evidence)])
                    self.assertEqual(error.exception.code, 2)
                    self.assertFalse(evidence.exists())

    def test_repo_capacity_denial_has_no_evidence_secret_or_docker_side_effect(self):
        module = load_runner()
        with tempfile.TemporaryDirectory(dir=ROOT / 'evidence') as temporary:
            evidence = Path(temporary) / 'must-not-exist'
            def command(args, **kwargs):
                if '檢查測試容量.py' in str(args):
                    return subprocess.CompletedProcess(args, 3)
                raise AssertionError('command after denied capacity')
            with patch.dict(os.environ, {'DOCKER_HOST': HOST}), patch('subprocess.run', side_effect=command):
                self.assertEqual(module.main(['--evidence', str(evidence)]), 3)
            self.assertFalse(evidence.exists())

    def test_actual_profile_capacity_is_checked_in_addition_to_repo(self):
        module = load_runner()
        calls = []
        with tempfile.TemporaryDirectory(dir=ROOT / 'evidence') as temporary:
            evidence = Path(temporary) / 'must-not-exist'
            def command(args, **kwargs):
                if '檢查測試容量.py' not in str(args):
                    raise AssertionError('Docker or secret side effect after capacity denial')
                calls.append(args)
                return subprocess.CompletedProcess(args, 0 if len(calls) == 1 else 3)
            with patch.dict(os.environ, {'DOCKER_HOST': HOST}), patch('subprocess.run', side_effect=command):
                self.assertEqual(module.main(['--evidence', str(evidence)]), 3)
            self.assertEqual(len(calls), 2)
            self.assertIn(str(ROOT), calls[0])
            self.assertIn(str(Path.home() / '.colima/dhc-e02b-dr-unit'), calls[1])
            self.assertFalse(evidence.exists())

    def test_existing_evidence_is_never_overwritten(self):
        module = load_runner()
        with tempfile.TemporaryDirectory(dir=ROOT / 'evidence') as temporary:
            sentinel = Path(temporary) / 'keep.txt'
            sentinel.write_text('keep original evidence')
            with patch.dict(os.environ, {'DOCKER_HOST': HOST}), patch('subprocess.run', side_effect=AssertionError('no command authorized')):
                with self.assertRaises(SystemExit) as error:
                    module.main(['--evidence', temporary])
                self.assertEqual(error.exception.code, 2)
            self.assertEqual(sentinel.read_text(), 'keep original evidence')

    def test_outside_and_symlink_evidence_are_rejected(self):
        module = load_runner()
        with tempfile.TemporaryDirectory() as outside, tempfile.TemporaryDirectory(dir=ROOT / 'evidence') as temporary:
            link = Path(temporary) / 'link'
            link.symlink_to(outside, target_is_directory=True)
            for evidence in [Path(outside) / 'new', link]:
                with patch.dict(os.environ, {'DOCKER_HOST': HOST}), patch('subprocess.run', side_effect=AssertionError('no command authorized')):
                    with self.assertRaises(SystemExit) as error:
                        module.main(['--evidence', str(evidence)])
                    self.assertEqual(error.exception.code, 2)

    def test_parent_database_and_secret_environment_is_not_forwarded(self):
        module = load_runner()
        env = module.build_qa_environment({'PATH': '/synthetic', 'DOCKER_HOST': HOST,
            'PGHOST': 'example.invalid', 'PGPASSWORD': 'synthetic-not-forwarded',
            'DHC_DATABASE_NAME': 'do-not-touch', 'ENTERPRISE_DB_PASSWORD': 'synthetic-not-forwarded'})
        self.assertEqual(env['DOCKER_HOST'], HOST)
        for name in ['PGHOST', 'PGPASSWORD', 'DHC_DATABASE_NAME', 'ENTERPRISE_DB_PASSWORD']:
            self.assertNotIn(name, env)


if __name__ == '__main__':
    unittest.main()
