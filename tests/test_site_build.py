"""验证静态官网构建的发布边界，不连接云账户。"""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class SiteBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        files = (
            'site/index.html', 'site/site.css', 'site/site.js',
            'public/assets/azusa-brand.png', 'public/assets/azusa-computer.png',
            'launcher/Assets/avatar.jpg', 'launcher/Assets/hero.png', 'launcher/Assets/help.jpg',
            'public/assets/fonts/Manrope.ttf', 'public/assets/fonts/OFL.txt',
            'public/guide-assets/launcher.png', 'public/assets/README.md', 'launcher/Assets/README.md',
            'public/guide-assets/hex.png', 'public/guide-assets/songs.png', 'public/guide-assets/equipment.png',
            'public/guide.css', 'dist/delivery/cover.png', 'public/guide.html',
        )
        for name in files:
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text('fixture', encoding='utf-8')
        (self.root / 'scripts').mkdir()
        shutil.copyfile(ROOT / 'scripts/build-site.mjs', self.root / 'scripts/build-site.mjs')
        (self.root / 'package.json').write_text(json.dumps({'version': '0.7.1'}), encoding='utf-8')
        (self.root / 'delivery.json').write_text('{}', encoding='utf-8')
        (self.root / 'site/config.json').write_text(json.dumps({
            'baseUrl': '', 'background': 'none', 'backgrounds': [{'id': 'none'}],
        }), encoding='utf-8')
        self.node = shutil.which('node')
        if not self.node:
            self.skipTest('本机未安装 Node.js。')

    def run_build(self, *arguments):
        return subprocess.run([self.node, str(self.root / 'scripts/build-site.mjs'), *arguments],
                              cwd=self.root, capture_output=True, text=True, encoding='utf-8')

    def test_preview_is_explicitly_not_ready(self):
        result = self.run_build()
        self.assertEqual(result.returncode, 0, result.stderr)
        release = json.loads((self.root / 'dist/site/release.json').read_text(encoding='utf-8'))
        self.assertFalse(release['ready'])
        self.assertFalse(release['videoReady'])

    def test_formal_build_rejects_missing_domain(self):
        self.assertNotEqual(self.run_build('--release').returncode, 0)
        self.assertFalse((self.root / 'dist/site').exists())

    def test_formal_build_rejects_preview_release_directory(self):
        self.assertNotEqual(self.run_build('--release', '--preview-releases', '.runtime/releases').returncode, 0)

    def test_guide_symlink_cannot_publish_external_content(self):
        external = self.root.parent / (self.root.name + '-external.html')
        external.write_text('external private fixture', encoding='utf-8')
        self.addCleanup(lambda: external.unlink(missing_ok=True))
        guide = self.root / 'public/guide.html'
        guide.unlink()
        try:
            guide.symlink_to(external)
        except OSError:
            self.skipTest('当前系统不允许创建符号链接。')
        result = self.run_build()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'dist/site/guide.html').exists())


if __name__ == '__main__':
    unittest.main()
