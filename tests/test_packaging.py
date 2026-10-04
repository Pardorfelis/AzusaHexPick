"""验证发布范围，测试不读取本机私有配置内容。"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "package.py"
SPEC = importlib.util.spec_from_file_location("azusa_package", SCRIPT)
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)


class PackagingTests(unittest.TestCase):
    def test_reparse_point_in_parent_is_rejected_before_reading(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            parent = root / 'public'
            parent.mkdir()
            target = parent / 'guide.html'
            target.write_text('fixture', encoding='utf-8')
            real_lstat = Path.lstat
            def parent_reparse(path):
                if path == parent:
                    return SimpleNamespace(st_file_attributes=0x400, st_mode=real_lstat(path).st_mode)
                return real_lstat(path)
            with patch.object(Path, 'lstat', parent_reparse):
                with self.assertRaises(ValueError):
                    PACKAGE.safe_release_file(target, root)
                with self.assertRaises(ValueError):
                    list(PACKAGE.release_files(parent, root))

    def test_source_outside_release_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'project'
            root.mkdir()
            external = root.parent / 'external.md'
            external.write_text('fixture', encoding='utf-8')
            with self.assertRaises(ValueError):
                PACKAGE.safe_release_file(external, root)

    def test_workspace_manifest_excludes_private_and_runtime_files(self):
        names = {path.relative_to(PACKAGE.ROOT).as_posix() for path in PACKAGE.package_files()}
        self.assertIn(".env.example", names)
        self.assertIn("data/replays/azusa-p3.json", names)
        self.assertNotIn(".env.local", names)
        self.assertFalse(any(".runtime" in name or "__pycache__" in name for name in names))
        self.assertFalse(any(name.endswith((".xml", ".ass", ".bmp")) for name in names))
        self.assertFalse(any("deepseek-api-result" in name for name in names))

    def test_unlisted_data_cannot_enter_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in PACKAGE.TOP_FILES + PACKAGE.REPORT_FILES + PACKAGE.DATA_FILES + PACKAGE.ASSET_FILES:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("fixture", encoding="utf-8")
            private_data = root / "data" / "private-account.json"
            private_data.write_text("synthetic-private", encoding="utf-8")
            (root / "data" / "song-blacklist.json").write_text("synthetic-list", encoding="utf-8")
            (root / "data" / "song-blacklist.json.tmp").write_text("synthetic-list", encoding="utf-8")
            (root / ".env.local").write_text("synthetic-key", encoding="utf-8")
            (root / "public" / "assets" / "private-screenshot.png").write_bytes(b"private fixture")
            names = {path.relative_to(root).as_posix() for path in PACKAGE.package_files(root)}
            self.assertNotIn("data/private-account.json", names)
            self.assertNotIn("data/song-blacklist.json", names)
            self.assertNotIn("data/song-blacklist.json.tmp", names)
            self.assertNotIn(".env.local", names)
            self.assertNotIn("public/assets/private-screenshot.png", names)
            self.assertTrue(set(PACKAGE.ASSET_FILES).issubset(names))

    def test_local_documents_are_excluded_from_distribution(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in PACKAGE.TOP_FILES + PACKAGE.REPORT_FILES + PACKAGE.DATA_FILES + PACKAGE.ASSET_FILES:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("fixture", encoding="utf-8")
            local_names = ("AGENTS.md", "docs/AGENTS.md", "scripts/CLAUDE.md", "docs/plan.md",
                           "public/temp/index.html", "public/temp/guide.html", "site/config.local.json",
                           "site/backgrounds/local/personal.json",
                           "src/.agents/instructions.mjs", "scripts/.codex/local.py", "src/.claude/local.json", "public/.impeccable/brief.json")
            for name in local_names:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("local fixture", encoding="utf-8")
            public_doc = root / "docs" / "usage.md"
            public_doc.write_text("public fixture", encoding="utf-8")
            names = {path.relative_to(root).as_posix() for path in PACKAGE.package_files(root)}
            self.assertTrue(all(name not in names for name in local_names))
            self.assertIn("docs/usage.md", names)


if __name__ == "__main__":
    unittest.main()
