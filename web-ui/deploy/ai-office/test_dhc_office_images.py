"""V5.2 ASTRA-ROLL-007：離線安裝的 image reference 一致性（不連 Docker；以替身取代 docker image inspect）。
用法：python3 -B deploy/ai-office/test_dhc_office_images.py
"""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dhc_office', HERE / 'dhc-office.py')
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)

IDS = {'dhc-ai-office:pkg': 'sha256:' + 'a' * 64, 'dhc-ai-office:other': 'sha256:' + 'b' * 64}


class OfflineImageReference(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {'DHC_SECRET_DIR': self.dir}, clear=False)
        self.env.start()
        os.environ.pop('DHC_IMAGE', None)
        self.inspect = mock.patch.object(tool, 'image_id', side_effect=lambda reference: IDS.get(reference))
        self.inspect.start()

    def tearDown(self):
        self.inspect.stop()
        self.env.stop()

    def install(self, tag='dhc-ai-office:pkg', image_id=None):
        Path(self.dir, 'image.env').write_text(f'DHC_IMAGE={tag}\nDHC_IMAGE_ID={image_id or IDS[tag]}\nDHC_SUPPORT_IMAGES={{}}\n')

    def test_offline_uses_recorded_reference_and_verifies_it(self):
        self.install()
        self.assertEqual(tool.selected_image(), 'dhc-ai-office:pkg')
        tool.assert_offline_images()

    def test_offline_same_reference_override_is_allowed(self):
        self.install()
        os.environ['DHC_IMAGE'] = 'dhc-ai-office:pkg'
        self.assertEqual(tool.selected_image(), 'dhc-ai-office:pkg')

    def test_offline_different_override_is_refused(self):
        self.install()
        os.environ['DHC_IMAGE'] = 'dhc-ai-office:other'
        with self.assertRaises(SystemExit):
            tool.selected_image()
        with self.assertRaises(SystemExit):
            tool.assert_offline_images()

    def test_offline_recorded_id_mismatch_is_refused(self):
        self.install(image_id='sha256:' + 'c' * 64)
        with self.assertRaises(SystemExit):
            tool.assert_offline_images()

    def test_online_development_uses_env_override(self):
        os.environ['DHC_IMAGE'] = 'dhc-ai-office:other'
        self.assertEqual(tool.selected_image(), 'dhc-ai-office:other')
        os.environ.pop('DHC_IMAGE')
        self.assertIsNone(tool.selected_image())


if __name__ == '__main__':
    unittest.main(verbosity=2)
