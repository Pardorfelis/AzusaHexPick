"""使用合成 ZIP 检查官网交付门槛，不读取真实配置或连接网络。"""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import struct
import unittest
import warnings
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_site_portable", ROOT / "scripts/verify-site-portable.py")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)
VERSION = "0.7.1"
BASE = "https://azusa510.example/"


def make_package(path, *, additional=None, missing=(), tampered=None, entries_transform=None,
                 manifest_patch=None, package_version=VERSION, metadata_version=VERSION, extra_zip=(), delivery_patch=None,
                 compression=zipfile.ZIP_DEFLATED):
    delivery = {"introductionUrl": BASE, "updateBaseUrl": BASE + "updates/"}
    delivery.update(delivery_patch or {})
    contents = {
        CHECK.MAIN_EXE: b"MZ synthetic launcher",
        "app/package.json": json.dumps({"version": package_version}).encode(),
        "app/delivery.json": json.dumps(delivery).encode(),
        "app/public/index.html": b"<html>synthetic test</html>",
    }
    contents.update(additional or {})
    entries = [{"path": name, "sha256": hashlib.sha256(data).hexdigest()} for name, data in contents.items()]
    if entries_transform:
        entries = entries_transform(entries)
    manifest = {"version": VERSION, "platform": "win-x64", "selfContained": True, "personalDataIncluded": False, "files": entries}
    manifest.update(manifest_patch or {})
    contents.update(tampered or {})
    metadata = (f'<package xmlns="http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd"><metadata>'
                f'<id>AzusaHexPickApp</id><version>{metadata_version}</version><mainExe>{CHECK.MAIN_EXE}</mainExe>'
                f'<channel>win</channel><rid>win-x64</rid></metadata></package>').encode()
    files = {"current/" + name: data for name, data in contents.items()}
    files.update({CHECK.MANIFEST: json.dumps(manifest).encode(), CHECK.VELOPACK_METADATA: metadata,
                  CHECK.MAIN_EXE: b"MZ synthetic bootstrap", "Update.exe": b"MZ synthetic updater", ".portable": b""})
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(path, "w", compression) as archive:
            for name, data in files.items():
                if name not in missing:
                    archive.writestr(name, data)
            for name, data in extra_zip:
                archive.writestr(name, data)


def replace_zip_file(path, name, data):
    with zipfile.ZipFile(path) as archive:
        contents = [(entry.filename, archive.read(entry)) for entry in archive.infolist()]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for filename, original in contents:
            archive.writestr(filename, data if filename == name else original)


class PortableSiteTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.package = Path(self.directory.name) / "synthetic.zip"

    def check_rejected(self, **options):
        make_package(self.package, **options)
        with self.assertRaises(ValueError):
            CHECK.verify_portable(self.package, VERSION, BASE)

    def test_valid_manifest_matches_all_files_and_required_metadata(self):
        make_package(self.package)
        result = CHECK.verify_portable(self.package, VERSION, BASE)
        self.assertTrue(result["success"])
        self.assertEqual(result["files"], 4)

    def test_explicit_parent_directory_entries_are_allowed(self):
        make_package(self.package, extra_zip=[("current/", b""), ("current/app/", b""), ("current/app/public/", b"")])
        self.assertTrue(CHECK.verify_portable(self.package, VERSION)["success"])

    def test_public_interface_document_is_not_confused_with_local_design_helper(self):
        make_package(self.package, additional={"app/docs/design.md": b"public interface documentation"})
        self.assertTrue(CHECK.verify_portable(self.package, VERSION)["success"])
        self.check_rejected(additional={"app/DESIGN.md": b"local design helper"})

    def test_empty_invalid_or_duplicate_manifest_is_rejected(self):
        for change in [{"files": []}, {"files": {}}, {"files": None}, {"selfContained": False}, {"personalDataIncluded": True}]:
            with self.subTest(change=change):
                self.check_rejected(manifest_patch=change)
        self.check_rejected(entries_transform=lambda entries: entries + [entries[0]])
        self.check_rejected(entries_transform=lambda entries: entries + [{**entries[-1], "path": "app/public/INDEX.html"}])

    def test_unlisted_extra_file_and_extra_directory_are_rejected(self):
        for name in ["current/app/extra.txt", "current/extra.dll", "extra.txt", "current/unused/"]:
            with self.subTest(path=name):
                self.check_rejected(extra_zip=[(name, b"not listed")])

    def test_missing_declared_file_root_bootstrap_or_update_metadata_is_rejected(self):
        for name in ["current/app/public/index.html", CHECK.MANIFEST, CHECK.VELOPACK_METADATA, "Update.exe", CHECK.MAIN_EXE, ".portable"]:
            with self.subTest(path=name):
                self.check_rejected(missing=[name])

    def test_tampered_file_is_rejected_even_when_names_still_match(self):
        self.check_rejected(tampered={"app/public/index.html": b"changed after manifest creation"})

    def test_private_configuration_and_assistant_paths_are_rejected_even_if_declared(self):
        for name in ["app/.env.local", "app/.env", "app/AGENTS.md", "app/.codex/settings.json", "app/.agents/local.md",
                     "app/.git/config", "app/public/temp/guide.html", "app/data/appearance.json", "app/UserData/key.dpapi",
                     "app/data/original.xml", "app/config.local.json"]:
            with self.subTest(path=name):
                self.check_rejected(additional={name: b"synthetic private content"})
        self.check_rejected(extra_zip=[("current/app/.env.local", b"synthetic private content")])
        self.check_rejected(extra_zip=[(".env.local", b"synthetic private content")])

    def test_absolute_traversal_backslash_case_collision_and_windows_alias_paths_are_rejected(self):
        for name in ["/current/app/extra", "current/app/../outside", "current/app//extra", "current/app\\extra", "C:/private",
                     "current/app/trailing. ", "current/app/./extra", "CURRENT/app/public/index.html",
                     "current/app/NUL.txt", "current/app/COM1", "current/app/new\nline", "current/app/star*"]:
            with self.subTest(path=name):
                self.check_rejected(extra_zip=[(name, b"synthetic")])
        self.check_rejected(extra_zip=[("current/app/public/index.html", b"duplicate")])

    def test_invalid_hash_and_unsafe_manifest_path_are_rejected(self):
        for value in ["", "x" * 64, 123]:
            with self.subTest(hash=value):
                self.check_rejected(entries_transform=lambda entries, value=value: [{**entry, "sha256": value} for entry in entries])
        self.check_rejected(entries_transform=lambda entries: entries + [{"path": "../private", "sha256": "a" * 64}])
        self.check_rejected(entries_transform=lambda entries: entries + [{"path": "sq.version", "sha256": "a" * 64}])

    def test_update_and_application_versions_must_match_manifest(self):
        self.check_rejected(metadata_version="0.7.0")
        self.check_rejected(package_version="0.7.0")
        self.check_rejected(manifest_patch={"version": "0.7.0"})

    def test_formal_introduction_and_update_addresses_are_checked(self):
        self.check_rejected(delivery_patch={"introductionUrl": "https://old.example/"})
        self.check_rejected(delivery_patch={"updateBaseUrl": "https://old.example/updates/"})
        make_package(self.package)
        for base in ["http://azusa510.example/", "https://user:password@azusa510.example/", BASE + "?token=synthetic"]:
            with self.subTest(base=base), self.assertRaises(ValueError):
                CHECK.verify_portable(self.package, VERSION, base)

    def test_symlink_and_non_windows_root_executable_are_rejected(self):
        make_package(self.package)
        link = zipfile.ZipInfo("current/app/link")
        link.create_system = 3
        link.external_attr = (0o120777 << 16)
        with zipfile.ZipFile(self.package, "a") as archive:
            archive.writestr(link, b"../outside")
        with self.assertRaises(ValueError):
            CHECK.verify_portable(self.package, VERSION)
        make_package(self.package)
        replace_zip_file(self.package, "Update.exe", b"not a Windows binary")
        with self.assertRaises(ValueError):
            CHECK.verify_portable(self.package, VERSION)

    def test_invalid_oversized_json_and_unsafe_update_xml_are_rejected(self):
        for data in [b"not JSON", b"[]", b"x" * (CHECK.MAX_METADATA_BYTES + 1)]:
            with self.subTest(metadata=data[:10]):
                make_package(self.package)
                replace_zip_file(self.package, CHECK.MANIFEST, data)
                with self.assertRaises(ValueError):
                    CHECK.verify_portable(self.package, VERSION)
        for data in [b"not XML", b'<!DOCTYPE package [<!ENTITY secret SYSTEM "file:///synthetic">]><package/>']:
            with self.subTest(xml=data[:10]):
                make_package(self.package)
                replace_zip_file(self.package, CHECK.VELOPACK_METADATA, data)
                with self.assertRaises(ValueError):
                    CHECK.verify_portable(self.package, VERSION)

    def test_portable_marker_does_not_permit_hidden_data(self):
        make_package(self.package)
        replace_zip_file(self.package, ".portable", b"synthetic unexpected data")
        with self.assertRaises(ValueError):
            CHECK.verify_portable(self.package, VERSION)

    def test_actual_crc_corruption_is_rejected(self):
        make_package(self.package, compression=zipfile.ZIP_STORED)
        with zipfile.ZipFile(self.package) as archive:
            entry = archive.getinfo("current/app/public/index.html")
        raw = bytearray(self.package.read_bytes())
        name_length, extra_length = struct.unpack_from("<HH", raw, entry.header_offset + 26)
        start = entry.header_offset + 30 + name_length + extra_length
        raw[start] ^= 1
        self.package.write_bytes(raw)
        with self.assertRaises(ValueError):
            CHECK.verify_portable(self.package, VERSION)

    def test_corrupt_archive_is_rejected(self):
        self.package.write_bytes(b"not a ZIP")
        with self.assertRaises(ValueError):
            CHECK.verify_portable(self.package, VERSION)


if __name__ == "__main__":
    unittest.main()
