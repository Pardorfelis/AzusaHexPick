"""校验官网构建并按依赖顺序部署到香港 COS；默认只做本地预检。"""
import argparse
from dataclasses import dataclass
import hashlib
import json
import logging
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import sys
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent.parent
REGION = "ap-hongkong"
VERSION = r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
DOMAINS = {"azusa510.cn", "www.azusa510.cn", "azusa510.top", "www.azusa510.top"}
PACKAGE = re.compile(rf"updates/AzusaHexPickApp-({VERSION})-(full|delta)\.nupkg")
DOWNLOAD = re.compile(rf"downloads/AzusaHexPick-({VERSION})-(Setup\.exe|Portable\.zip)")
SHA256 = re.compile(r"[a-fA-F0-9]{64}")
FIXED_KEYS = {
    "index.html", "site.css", "site.js", "guide.html", "guide.css", "credits.html", "release.json",
    "assets/brand.png", "assets/computer.png", "assets/avatar.jpg", "assets/hero.png", "assets/help.jpg",
    "assets/Manrope.ttf", "assets/OFL.txt", "assets/launcher.png", "credits/web-assets.md",
    "credits/launcher-assets.md", "guide-assets/launcher.png", "guide-assets/console.png", "guide-assets/panel.png",
    "guide-assets/hex.png", "guide-assets/songs.png", "guide-assets/equipment.png",
    "media/hex.png", "media/songs.png", "media/equipment.png", "media/cover.png", "media/demo.mp4", "media/demo.vtt",
    "updates/releases.win.json", "updates/releases.win.json.sha256",
}
MAX_FILE = 2 * 1024 ** 3
MAX_JSON = 2 * 1024 ** 2


class DeploymentError(ValueError):
    """仅包含可安全显示的维护提示，不拼接 SDK 错误或密钥。"""


@dataclass(frozen=True)
class Entry:
    key: str
    source: Path
    size: int
    sha256: str

    @property
    def immutable(self):
        return bool(PACKAGE.fullmatch(self.key) or DOWNLOAD.fullmatch(self.key))


@dataclass(frozen=True)
class Plan:
    version: str
    formal: bool
    base_url: str
    entries: tuple


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path):
    if path.stat().st_size > MAX_JSON:
        raise DeploymentError("JSON 清单超过允许大小。")
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError):
        raise DeploymentError("JSON 清单无法读取，请重新构建官网。") from None


def valid_base_url(value):
    try:
        parsed = urlsplit(value)
        return (parsed.scheme == "https" and parsed.hostname in DOMAINS
                and not parsed.username and not parsed.password and parsed.port in {None, 443}
                and parsed.path in {"", "/"} and not parsed.query and not parsed.fragment)
    except (TypeError, ValueError):
        return False


def allowed_key(key):
    if not isinstance(key, str) or "\\" in key or "%" in key or any(ord(char) < 32 for char in key):
        return False
    parsed = PurePosixPath(key)
    if parsed.is_absolute() or key != parsed.as_posix() or any(part in {".", ".."} for part in key.split("/")):
        return False
    return key in FIXED_KEYS or bool(PACKAGE.fullmatch(key) or DOWNLOAD.fullmatch(key)
        or re.fullmatch(r"backgrounds/[a-f0-9]{16}\.(jpg|png|webp)", key))


def load_plan(site, publish=False):
    site = Path(site)
    if site.is_symlink() or not site.is_dir():
        raise DeploymentError("官网构建目录不存在或不是普通目录。")
    site = site.resolve()
    manifest_path = site / "site-manifest.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise DeploymentError("缺少官网白名单清单，请先运行 build-site。")
    manifest = read_json(manifest_path)
    if not isinstance(manifest, dict) or not re.fullmatch(VERSION, str(manifest.get("version", ""))):
        raise DeploymentError("官网版本号必须是正式的三段数字版本。")
    entries, seen = [], set()
    if not isinstance(manifest.get("files"), list) or not manifest["files"]:
        raise DeploymentError("官网白名单清单没有文件。")
    for record in manifest["files"]:
        if not isinstance(record, dict) or not allowed_key(record.get("path")):
            raise DeploymentError("清单含非发布白名单文件。")
        key = record["path"]
        if key in seen:
            raise DeploymentError("清单包含重复对象。")
        seen.add(key)
        source = site / key
        if any(part.is_symlink() for part in [source, *source.parents] if part != site.parent):
            raise DeploymentError("发布文件不允许使用符号链接。")
        if not source.is_file() or not source.resolve().is_relative_to(site):
            raise DeploymentError("发布文件缺失或越出官网目录。")
        size, sha = record.get("bytes"), record.get("sha256")
        if type(size) is not int or size < 0 or size > MAX_FILE or not isinstance(sha, str) or not SHA256.fullmatch(sha):
            raise DeploymentError("文件大小或 SHA-256 格式不正确。")
        if source.stat().st_size != size or file_hash(source) != sha.lower():
            raise DeploymentError("本地文件与构建清单不符，请重新构建。")
        entries.append(Entry(key, source, size, sha.lower()))
    # 清单以外的文件也必须拒绝，避免误把本地配置随手放进部署目录。
    actual = set()
    for source in site.rglob("*"):
        if source.is_symlink():
            raise DeploymentError("官网目录包含符号链接。")
        if source.is_file():
            actual.add(source.relative_to(site).as_posix())
    if actual != seen | {"site-manifest.json"}:
        raise DeploymentError("官网目录有清单外文件或缺失文件，请重新构建。")
    plan = Plan(manifest["version"], manifest.get("formal") is True, manifest.get("baseUrl", ""), tuple(entries))
    if publish:
        validate_release(plan)
    return plan


def validate_release(plan):
    if not plan.formal or not valid_base_url(plan.base_url):
        raise DeploymentError("正式发布需 release 构建和已购置、配置的正式 HTTPS 域名。")
    by_key = {entry.key: entry for entry in plan.entries}
    if not {"index.html", "release.json", "media/demo.mp4", "media/demo.vtt", "updates/releases.win.json"}.issubset(by_key):
        raise DeploymentError("正式官网缺少首页、视频、字幕或更新清单。")
    release = read_json(by_key["release.json"].source)
    if not isinstance(release, dict) or release.get("version") != plan.version or release.get("ready") is not True or release.get("videoReady") is not True:
        raise DeploymentError("正式版本的下载和视频尚未齐全。")
    downloads = release.get("downloads", {})
    for kind, suffix in [("installer", "Setup.exe"), ("portable", "Portable.zip")]:
        value = downloads.get(kind) if isinstance(downloads, dict) else None
        key = f"downloads/AzusaHexPick-{plan.version}-{suffix}"
        entry = by_key.get(key)
        if (not isinstance(value, dict) or not entry or value.get("url") != key
                or value.get("bytes") != entry.size or str(value.get("sha256", "")).lower() != entry.sha256 or entry.size == 0):
            raise DeploymentError("两种下载文件必须与本版清单一致。")
    feed = read_json(by_key["updates/releases.win.json"].source)
    assets = feed.get("Assets") if isinstance(feed, dict) else None
    if not isinstance(assets, list) or not assets:
        raise DeploymentError("更新清单没有正式包。")
    referenced, current_full = set(), False
    target_version = tuple(map(int, plan.version.split(".")))
    for value in assets:
        if not isinstance(value, dict):
            raise DeploymentError("更新清单条目不正确。")
        name, version, kind = value.get("FileName"), value.get("Version"), value.get("Type")
        key = "updates/" + name if isinstance(name, str) else ""
        match = PACKAGE.fullmatch(key)
        entry = by_key.get(key)
        if (not match or value.get("PackageId") != "AzusaHexPickApp" or version != match.group(1)
                or kind not in {"Full", "Delta"} or kind.lower() != match.group(2) or not entry
                or tuple(map(int, version.split("."))) > target_version or key in referenced
                or value.get("Size") != entry.size or str(value.get("SHA256", "")).lower() != entry.sha256 or entry.size == 0):
            raise DeploymentError("更新包引用、版本、大小或 SHA-256 不一致。")
        referenced.add(key)
        current_full |= version == plan.version and kind == "Full"
    if not current_full or referenced != {key for key in by_key if PACKAGE.fullmatch(key)}:
        raise DeploymentError("缺少当前完整更新包，或存在清单未引用的更新包。")
    checksum = by_key.get("updates/releases.win.json.sha256")
    if checksum and checksum.source.read_text(encoding="ascii").split()[0].lower() != by_key["updates/releases.win.json"].sha256:
        raise DeploymentError("更新清单校验文件不匹配。")


def order(entry):
    if entry.immutable:
        return 0, entry.key
    if entry.key == "updates/releases.win.json":
        return 3, entry.key
    if entry.key.startswith("updates/"):
        return 2, entry.key
    if entry.key == "release.json":
        return 4, entry.key
    if entry.key == "index.html":
        return 5, entry.key
    return 1, entry.key


def content_type(key):
    value = mimetypes.guess_type(key)[0] or "application/octet-stream"
    return value + "; charset=utf-8" if key.endswith((".html", ".css", ".js", ".json", ".md", ".txt", ".vtt")) else value


def upload_metadata(sha256, immutable=False):
    """官方 SDK 通过 Metadata 展开专用头部，初始化时核验此契约。"""
    metadata = {"x-cos-meta-sha256": sha256}
    if immutable:
        metadata["x-cos-forbid-overwrite"] = "true"
    return metadata


def verify_sdk_header_mapping(mapper):
    # SDK 参数文档与源码对此项表述不同，不能假定任意 SDK 版本均支持。
    # 只执行本地映射，不创建 HTTP 连接，也不使用真实凭据。
    expected_hash = "0" * 64
    try:
        headers = mapper({"Metadata": upload_metadata(expected_hash, True)})
        valid = (isinstance(headers, dict)
            and headers.get("x-cos-forbid-overwrite") == "true"
            and headers.get("x-cos-meta-sha256") == expected_hash)
    except Exception:
        valid = False
    if not valid:
        raise DeploymentError("当前 COS SDK 不支持已验证的防覆盖头部，请安装 cos-python-sdk-v5==1.9.44 后重试。")


def verify_remote(client, bucket, entry):
    head = client.head_object(Bucket=bucket, Key=entry.key)
    headers = {key.lower(): value for key, value in head.items()}
    if int(headers.get("content-length", -1)) != entry.size:
        raise DeploymentError("远端对象大小与本地不一致，停止发布。")
    response = client.get_object(Bucket=bucket, Key=entry.key)
    stream = response["Body"].get_raw_stream()
    digest, total = hashlib.sha256(), 0
    try:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            total += len(block)
            if total > entry.size:
                raise DeploymentError("远端对象长度异常，停止发布。")
            digest.update(block)
    finally:
        stream.close()
    if total != entry.size or digest.hexdigest() != entry.sha256:
        raise DeploymentError("远端对象 SHA-256 不匹配，停止发布。")


def exists(client, bucket, key):
    try:
        client.head_object(Bucket=bucket, Key=key)
        return True
    except Exception as error:
        if getattr(error, "get_status_code", lambda: None)() == 404:
            return False
        raise


def remote_json(client, bucket, key):
    response = client.get_object(Bucket=bucket, Key=key)
    stream = response["Body"].get_raw_stream()
    try:
        content = stream.read(MAX_JSON + 1)
    finally:
        stream.close()
    if len(content) > MAX_JSON:
        raise DeploymentError("远端版本清单超过允许大小，停止发布。")
    try:
        value = json.loads(content)
    except (UnicodeError, json.JSONDecodeError):
        raise DeploymentError("远端版本清单损坏，停止发布。") from None
    if not isinstance(value, dict):
        raise DeploymentError("远端版本清单格式不正确，停止发布。")
    return value


def prevent_downgrade(plan, client, bucket):
    target = tuple(map(int, plan.version.split(".")))
    if exists(client, bucket, "release.json"):
        value = remote_json(client, bucket, "release.json").get("version")
        if not isinstance(value, str) or not re.fullmatch(VERSION, value):
            raise DeploymentError("远端官网版本号不正确，停止发布。")
        if tuple(map(int, value.split("."))) > target:
            raise DeploymentError("远端已发布更高版本，不能回退正式入口。")
    if exists(client, bucket, "updates/releases.win.json"):
        values = remote_json(client, bucket, "updates/releases.win.json").get("Assets")
        if not isinstance(values, list):
            raise DeploymentError("远端更新清单格式不正确，停止发布。")
        stable = []
        for asset in values:
            if not isinstance(asset, dict) or asset.get("PackageId") != "AzusaHexPickApp" or asset.get("Type") not in {"Full", "Delta"}:
                raise DeploymentError("远端更新清单有异常条目，停止发布。")
            version = asset.get("Version")
            if not isinstance(version, str):
                raise DeploymentError("远端更新包版本号不正确，停止发布。")
            if re.fullmatch(VERSION, version):
                stable.append(tuple(map(int, version.split("."))))
            elif not re.fullmatch(rf"{VERSION}-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*", version):
                raise DeploymentError("远端更新包版本号不正确，停止发布。")
        if stable and max(stable) > target:
            raise DeploymentError("远端更新清单已有更高正式版本，不能回退更新入口。")


def publish(plan, client, bucket, notify=lambda value: None):
    validate_release(plan)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,50}-[0-9]{5,20}", bucket):
        raise DeploymentError("COS_BUCKET 需填写包含 APPID 的完整桶名。")
    if client.get_bucket_location(Bucket=bucket).get("LocationConstraint") != REGION:
        raise DeploymentError("存储桶不在中国香港，停止发布。")
    if client.get_bucket_versioning(Bucket=bucket).get("Status") not in {None, ""}:
        raise DeploymentError("此流程需要未启用过版本控制的桶，才能保证不可变包不被覆盖。")
    prevent_downgrade(plan, client, bucket)
    # 先检查所有不可变对象，冲突时在任何写操作前停止。
    present = set()
    for entry in plan.entries:
        if entry.immutable and exists(client, bucket, entry.key):
            verify_remote(client, bucket, entry)
            present.add(entry.key)
    for entry in sorted(plan.entries, key=order):
        if entry.key == "updates/releases.win.json":
            # 包传输耗时较长，提交 feed 前重新检查，不能只依赖官网入口版本。
            prevent_downgrade(plan, client, bucket)
        if entry.source.stat().st_size != entry.size or file_hash(entry.source) != entry.sha256:
            raise DeploymentError("构建文件在发布期间发生变化，停止发布。")
        if entry.key in present:
            notify({"key": entry.key, "action": "already-verified"})
            continue
        metadata = upload_metadata(entry.sha256, entry.immutable)
        # 现有文件均小于 2 GB，使用简单上传以保留原子防覆盖头。
        with entry.source.open("rb") as stream:
            client.put_object(Bucket=bucket, Key=entry.key, Body=stream, EnableMD5=True,
                StorageClass="STANDARD", Metadata=metadata, ContentType=content_type(entry.key),
                CacheControl="public, max-age=31536000, immutable" if entry.immutable else "no-cache")
        verify_remote(client, bucket, entry)
        notify({"key": entry.key, "action": "uploaded-and-verified"})


def make_client():
    credentials = {name: os.environ.get(name, "") for name in ["COS_SECRET_ID", "COS_SECRET_KEY"]}
    if not all(credentials.values()):
        raise DeploymentError("发布需在本机环境变量配置 COS_SECRET_ID 和 COS_SECRET_KEY，不要发送密钥。")
    try:
        from qcloud_cos import CosConfig, CosS3Client
        from qcloud_cos.cos_comm import mapped
    except ImportError:
        raise DeploymentError("缺少官方 SDK，请运行 python -m pip install cos-python-sdk-v5==1.9.44。") from None
    verify_sdk_header_mapping(mapped)
    # 不启用 SDK 调试日志，异常只显示通用提示，避免签名和凭据输出。
    logging.disable(logging.CRITICAL)
    return CosS3Client(CosConfig(Region=REGION, Scheme="https", SecretId=credentials["COS_SECRET_ID"],
        SecretKey=credentials["COS_SECRET_KEY"], Token=os.environ.get("COS_SESSION_TOKEN") or None))


def main(argv=None):
    for stream in [sys.stdout, sys.stderr]:
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", type=Path, default=ROOT / "dist" / "site")
    parser.add_argument("--bucket", default=os.environ.get("COS_BUCKET", ""))
    parser.add_argument("--publish", action="store_true", help="显式上传正式构建；省略时不连接腾讯云")
    args = parser.parse_args(argv)
    try:
        plan = load_plan(args.site, args.publish)
        if not args.publish:
            print(json.dumps({"dryRun": True, "version": plan.version, "formal": plan.formal,
                "files": len(plan.entries), "bytes": sum(entry.size for entry in plan.entries),
                "order": [entry.key for entry in sorted(plan.entries, key=order)]}, ensure_ascii=False))
            return 0
        if not args.bucket:
            raise DeploymentError("发布需先设置 COS_BUCKET，脚本不会创建或猜测存储桶。")
        publish(plan, make_client(), args.bucket, lambda value: print(json.dumps(value, ensure_ascii=False)))
        print(json.dumps({"published": True, "version": plan.version, "files": len(plan.entries)}, ensure_ascii=False))
        return 0
    except DeploymentError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print("部署未完成。请检查 SDK、桶权限、网络和构建文件；不自动删除或覆盖冲突的更新包。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
