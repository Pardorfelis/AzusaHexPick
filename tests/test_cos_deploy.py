"""使用内存客户端和真实 SDK 的离线请求构建，不访问腾讯云账号。"""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "deploy-cos.py"
SPEC = importlib.util.spec_from_file_location("azusa_deploy_cos", SCRIPT)
DEPLOY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = DEPLOY
SPEC.loader.exec_module(DEPLOY)
BUCKET = "azusa510-1250000000"

# SDK 仅供维护者部署；独立软件包验证没有 SDK 时明确跳过 SDK 集成检查。
SDK = None
SDK_DIRECTORY = SCRIPT.parent.parent / ".runtime" / "tools" / "cos-sdk"
if importlib.util.find_spec("qcloud_cos") is None and SDK_DIRECTORY.is_dir():
    sys.path.insert(0, str(SDK_DIRECTORY))
try:
    import qcloud_cos as SDK
except ImportError:
    pass


class Missing(Exception):
    def get_status_code(self):
        return 404


class Body:
    def __init__(self, data):
        self.data = data

    def get_raw_stream(self):
        return io.BytesIO(self.data)


class FakeClient:
    def __init__(self):
        self.objects = {}
        self.writes = []
        self.headers = {}
        self.location = "ap-hongkong"
        self.versioning = ""
        self.corrupt = None
        self.race = None

    def get_bucket_location(self, Bucket):
        assert Bucket == BUCKET
        return {"LocationConstraint": self.location}

    def get_bucket_versioning(self, Bucket):
        assert Bucket == BUCKET
        return {"Status": self.versioning}

    def head_object(self, Bucket, Key):
        assert Bucket == BUCKET
        if Key not in self.objects:
            raise Missing()
        return {"Content-Length": str(len(self.objects[Key]))}

    def get_object(self, Bucket, Key):
        assert Bucket == BUCKET
        return {"Body": Body(self.objects[Key])}

    def put_object(self, Bucket, Key, Body, **headers):
        assert Bucket == BUCKET
        immutable = DEPLOY.PACKAGE.fullmatch(Key) or DEPLOY.DOWNLOAD.fullmatch(Key)
        if immutable:
            assert headers["Metadata"]["x-cos-forbid-overwrite"] == "true"
            if Key in self.objects or Key == self.race:
                raise RuntimeError("COS_SECRET_KEY=must-never-be-displayed")
        self.writes.append(Key)
        self.headers[Key] = headers
        data = Body.read()
        self.objects[Key] = b"x" * len(data) if Key == self.corrupt else data


class CosDeployTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.client = FakeClient()
        self.build()

    def tearDown(self):
        self.directory.cleanup()

    def build(self, version="0.7.1", formal=True, full=True, delta=False):
        for key in getattr(self, "files", {}):
            target = self.root / key
            if target.is_file():
                target.unlink()
        self.files = {"index.html": b"<h1>Test</h1>", "site.css": b"body{color:black}",
            "media/demo.mp4": b"demonstration", "media/demo.vtt": b"WEBVTT\n"}
        downloads = {}
        for kind, suffix in [("installer", "Setup.exe"), ("portable", "Portable.zip")]:
            key = f"downloads/AzusaHexPick-{version}-{suffix}"
            data = (kind + version).encode()
            self.files[key] = data
            downloads[kind] = {"url": key, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        self.files["release.json"] = json.dumps({"version": version, "ready": True,
            "videoReady": True, "downloads": downloads}).encode()
        assets = []
        for kind in (["Full"] if full else []) + (["Delta"] if delta else []):
            name = f"AzusaHexPickApp-{version}-{kind.lower()}.nupkg"
            data = (version + kind).encode()
            self.files["updates/" + name] = data
            assets.append({"PackageId": "AzusaHexPickApp", "Version": version, "Type": kind,
                "FileName": name, "Size": len(data), "SHA256": hashlib.sha256(data).hexdigest()})
        self.files["updates/releases.win.json"] = json.dumps({"Assets": assets}).encode()
        self.manifest = {"version": version, "formal": formal, "baseUrl": "https://azusa510.cn",
            "files": []}
        self.write_all()

    def write_all(self):
        self.manifest["files"] = []
        for key, data in self.files.items():
            target = self.root / key
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            self.manifest["files"].append({"path": key, "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest()})
        self.write_manifest()

    def write_manifest(self):
        (self.root / "site-manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def plan(self):
        return DEPLOY.load_plan(self.root, publish=True)

    def test_default_dry_run_never_loads_sdk_or_connects(self):
        self.manifest["formal"] = False
        self.manifest["baseUrl"] = ""
        self.write_manifest()
        output = io.StringIO()
        with patch.object(DEPLOY, "make_client", side_effect=AssertionError("Must not connect")), redirect_stdout(output):
            self.assertEqual(DEPLOY.main(["--site", str(self.root)]), 0)
        self.assertTrue(json.loads(output.getvalue())["dryRun"])

    def test_formal_publish_needs_domain_and_release_build(self):
        for name, value in [("formal", False), ("baseUrl", "https://example.invalid"),
                ("baseUrl", "http://azusa510.cn"), ("baseUrl", "https://password@azusa510.cn"),
                ("baseUrl", "https://azusa510.cn:444"), ("baseUrl", "https://azusa510.cn/path")]:
            previous = self.manifest[name]
            self.manifest[name] = value
            self.write_manifest()
            with self.assertRaises(DEPLOY.DeploymentError):
                self.plan()
            self.manifest[name] = previous

    def test_both_confirmable_domain_candidates_are_supported(self):
        for domain in ["azusa510.cn", "www.azusa510.cn", "azusa510.top", "www.azusa510.top"]:
            self.assertTrue(DEPLOY.valid_base_url("https://" + domain))
        self.assertFalse(DEPLOY.valid_base_url("https://azusa510.top.attacker.cn"))

    def test_changed_sdk_mapping_is_rejected_before_a_client_is_created(self):
        def metadata_only(arguments):
            return {key: value for key, value in arguments["Metadata"].items()
                if key.startswith("x-cos-meta-")}
        with self.assertRaises(DEPLOY.DeploymentError):
            DEPLOY.verify_sdk_header_mapping(metadata_only)
        with self.assertRaises(DEPLOY.DeploymentError):
            DEPLOY.verify_sdk_header_mapping(lambda arguments: None)
        DEPLOY.verify_sdk_header_mapping(lambda arguments: arguments["Metadata"].copy())

    def test_whitelist_rejects_private_config_and_path_escape(self):
        for key in [".env.local", "AGENTS.md", "site/config.local.json", "public/temp/index.html",
                "../../outside.txt", "assets\\brand.png", "assets/%2e%2e/key.txt", "/index.html"]:
            self.manifest["files"].append({"path": key, "bytes": 0, "sha256": "0" * 64})
            self.write_manifest()
            with self.assertRaises(DEPLOY.DeploymentError):
                self.plan()
            self.manifest["files"].pop()

    def test_unlisted_files_are_not_silently_uploaded(self):
        (self.root / ".env.local").write_text("secret must stay local", encoding="utf-8")
        with self.assertRaises(DEPLOY.DeploymentError):
            self.plan()

    def test_local_corruption_stops_before_any_remote_calls(self):
        (self.root / "index.html").write_bytes(b"modified")
        with self.assertRaises(DEPLOY.DeploymentError):
            self.plan()
        self.assertEqual(self.client.writes, [])

    def test_missing_download_or_video_cannot_publish(self):
        for key in ["downloads/AzusaHexPick-0.7.1-Setup.exe", "media/demo.mp4"]:
            original = self.files.pop(key)
            (self.root / key).unlink()
            self.write_all()
            with self.assertRaises(DEPLOY.DeploymentError):
                self.plan()
            self.files[key] = original
            self.write_all()

    def test_full_update_required_and_unreferenced_package_rejected(self):
        self.build(full=False, delta=True)
        with self.assertRaises(DEPLOY.DeploymentError):
            self.plan()
        self.build()
        self.files["updates/AzusaHexPickApp-0.7.1-delta.nupkg"] = b"unlisted update"
        self.write_all()
        with self.assertRaises(DEPLOY.DeploymentError):
            self.plan()

    def test_upload_order_puts_verified_packages_before_feed_and_page(self):
        self.build(delta=True)
        DEPLOY.publish(self.plan(), self.client, BUCKET)
        writes = self.client.writes
        feed = writes.index("updates/releases.win.json")
        for index, key in enumerate(writes):
            if DEPLOY.PACKAGE.fullmatch(key) or DEPLOY.DOWNLOAD.fullmatch(key):
                self.assertLess(index, feed)
        self.assertEqual(writes[-2:], ["release.json", "index.html"])
        self.assertEqual(self.client.headers["index.html"]["ContentType"], "text/html; charset=utf-8")
        self.assertEqual(self.client.headers["index.html"]["CacheControl"], "no-cache")

    def test_existing_identical_immutable_objects_reused_after_readback(self):
        key = "updates/AzusaHexPickApp-0.7.1-full.nupkg"
        self.client.objects[key] = self.files[key]
        DEPLOY.publish(self.plan(), self.client, BUCKET)
        self.assertNotIn(key, self.client.writes)

    def test_existing_conflict_aborts_before_any_write(self):
        key = "updates/AzusaHexPickApp-0.7.1-full.nupkg"
        self.client.objects[key] = b"x" * len(self.files[key])
        with self.assertRaises(DEPLOY.DeploymentError):
            DEPLOY.publish(self.plan(), self.client, BUCKET)
        self.assertEqual(self.client.writes, [])

    def test_readback_hash_failure_does_not_publish_feed(self):
        self.client.corrupt = "updates/AzusaHexPickApp-0.7.1-full.nupkg"
        with self.assertRaises(DEPLOY.DeploymentError):
            DEPLOY.publish(self.plan(), self.client, BUCKET)
        self.assertNotIn("updates/releases.win.json", self.client.writes)
        self.assertNotIn("release.json", self.client.writes)

    def test_region_and_versioning_must_be_safe_before_write(self):
        for location, status in [("ap-guangzhou", ""), ("ap-hongkong", "Enabled"),
                ("ap-hongkong", "Suspended"), ("ap-hongkong", "Unexpected")]:
            self.client.location, self.client.versioning = location, status
            with self.assertRaises(DEPLOY.DeploymentError):
                DEPLOY.publish(self.plan(), self.client, BUCKET)
        self.assertEqual(self.client.writes, [])

    def test_remote_newer_version_is_not_replaced(self):
        self.client.objects["release.json"] = b'{"version":"0.8.0"}'
        with self.assertRaises(DEPLOY.DeploymentError):
            DEPLOY.publish(self.plan(), self.client, BUCKET)
        self.assertEqual(self.client.writes, [])

    def test_newer_remote_feed_blocks_old_retry_even_if_home_version_is_old(self):
        self.client.objects["release.json"] = b'{"version":"0.7.0"}'
        self.client.objects["updates/releases.win.json"] = json.dumps({"Assets": [
            {"PackageId": "AzusaHexPickApp", "Type": "Full", "Version": "0.6.0"},
            {"PackageId": "AzusaHexPickApp", "Type": "Delta", "Version": "0.7.2"},
            {"PackageId": "AzusaHexPickApp", "Type": "Full", "Version": "0.7.1"},
        ]}).encode()
        with self.assertRaises(DEPLOY.DeploymentError):
            DEPLOY.publish(self.plan(), self.client, BUCKET)
        self.assertEqual(self.client.writes, [])

    def test_newer_feed_alone_blocks_old_retry_when_home_commit_is_missing(self):
        self.client.objects["updates/releases.win.json"] = json.dumps({"Assets": [
            {"PackageId": "AzusaHexPickApp", "Type": "Full", "Version": "0.10.0"},
        ]}).encode()
        with self.assertRaises(DEPLOY.DeploymentError):
            DEPLOY.publish(self.plan(), self.client, BUCKET)
        self.assertEqual(self.client.writes, [])

    def test_corrupt_remote_feed_is_not_blindly_replaced(self):
        self.client.objects["updates/releases.win.json"] = b"not valid json"
        with self.assertRaises(DEPLOY.DeploymentError):
            DEPLOY.publish(self.plan(), self.client, BUCKET)
        self.assertEqual(self.client.writes, [])

    def test_feed_version_is_rechecked_after_package_transfer(self):
        def concurrent_change(value):
            if value["key"].endswith("-full.nupkg"):
                self.client.objects["updates/releases.win.json"] = json.dumps({"Assets": [
                    {"PackageId": "AzusaHexPickApp", "Type": "Full", "Version": "0.8.0"},
                ]}).encode()
        with self.assertRaises(DEPLOY.DeploymentError):
            DEPLOY.publish(self.plan(), self.client, BUCKET, concurrent_change)
        self.assertNotIn("updates/releases.win.json", self.client.writes)
        self.assertNotIn("release.json", self.client.writes)
        self.assertNotIn("index.html", self.client.writes)

    def test_sdk_failure_is_redacted_and_no_feed_is_written(self):
        self.client.race = "updates/AzusaHexPickApp-0.7.1-full.nupkg"
        error = io.StringIO()
        with patch.object(DEPLOY, "make_client", return_value=self.client), redirect_stderr(error), redirect_stdout(io.StringIO()):
            status = DEPLOY.main(["--site", str(self.root), "--bucket", BUCKET, "--publish"])
        self.assertEqual(status, 1)
        self.assertNotIn("must-never-be-displayed", error.getvalue())
        self.assertNotIn("updates/releases.win.json", self.client.writes)


@unittest.skipUnless(SDK is not None, "维护者的 COS SDK 未安装，真实 SDK 离线检查另行运行。")
class OfficialSdkRequestTests(unittest.TestCase):
    def test_official_mapping_preserves_forbid_overwrite_header(self):
        from qcloud_cos.cos_comm import mapped
        DEPLOY.verify_sdk_header_mapping(mapped)
        headers = mapped({"Metadata": DEPLOY.upload_metadata("0" * 64, True)})
        self.assertEqual(headers["x-cos-forbid-overwrite"], "true")
        self.assertNotIn("x-cos-meta-forbid-overwrite", headers)

    def test_real_prepared_and_signed_upload_has_the_atomic_header(self):
        import requests
        client = SDK.CosS3Client(SDK.CosConfig(Region=DEPLOY.REGION, Scheme="https",
            SecretId="synthetic-offline-id", SecretKey="synthetic-offline-secret"))
        requests_seen = []

        def inspect_request(request, **kwargs):
            # Session.send 被替换，因此 SDK 执行映射、MD5 与签名后不会访问网络。
            requests_seen.append(request)
            headers = {key: value.decode("ascii") if isinstance(value, bytes) else value
                for key, value in request.headers.items()}
            self.assertEqual(request.method, "PUT")
            self.assertEqual(headers["x-cos-forbid-overwrite"], "true")
            self.assertEqual(headers["x-cos-meta-sha256"], "0" * 64)
            self.assertEqual(headers["Content-MD5"], "x50dXzzSiIaPSo3knBQIJA==")
            self.assertIn("x-cos-forbid-overwrite", headers["Authorization"])
            self.assertEqual(request.body.read(), b"offline-package")
            response = requests.Response()
            response.status_code = 200
            response.headers["ETag"] = '"offline"'
            response._content = b""
            response.request = request
            return response

        with patch.object(client._session, "send", side_effect=inspect_request):
            result = client.put_object(Bucket=BUCKET,
                Key="updates/AzusaHexPickApp-0.7.1-full.nupkg", Body=io.BytesIO(b"offline-package"),
                EnableMD5=True, Metadata=DEPLOY.upload_metadata("0" * 64, True),
                StorageClass="STANDARD", ContentType="application/octet-stream")
        self.assertEqual(result["ETag"], '"offline"')
        self.assertEqual(len(requests_seen), 1)


if __name__ == "__main__":
    unittest.main()
