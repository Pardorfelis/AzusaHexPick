"""官网构建前核对便携包清单、文件范围、版本与正式地址。"""
import hashlib
import json
from pathlib import PurePosixPath
import re
import stat
import sys
import xml.etree.ElementTree as ET
import zipfile
import zlib
from urllib.parse import urljoin, urlsplit


MANIFEST = "current/package-manifest.json"
VELOPACK_METADATA = "current/sq.version"
MAIN_EXE = "梓有妙选.exe"
ROOT_FILES = {".portable", "Update.exe", MAIN_EXE}
PRIVATE_PARTS = {".git", ".agents", ".codex", ".claude", ".impeccable", ".runtime", "userdata"}
PRIVATE_FILES = {"agents.md", "claude.md", "gemini.md", "product.md", "config.local.json",
                 "launcher.json", "appearance.json", "app-settings.json", "song-blacklist.json", "key.dpapi", "api-key.dpapi"}
MAX_METADATA_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
WINDOWS_RESERVED = {"con", "prn", "aux", "nul"} | {f"{prefix}{number}" for prefix in ["com", "lpt"] for number in range(1, 10)}


def checked_path(value, directory=False):
    if (not isinstance(value, str) or not value or any(ord(character) < 32 or character in '\\:*?<>|"' for character in value)
            or value.startswith("/")):
        raise ValueError("便携包包含不安全的文件路径。")
    path = value[:-1] if directory and value.endswith("/") else value
    parts = path.split("/")
    if any(not part or part in {".", ".."} or part.rstrip(" .") != part for part in parts):
        raise ValueError("便携包包含不安全的文件路径。")
    if any(part.split(".")[0].casefold() in WINDOWS_RESERVED for part in parts):
        raise ValueError("便携包包含 Windows 保留名称。")
    if any(part.casefold() in PRIVATE_PARTS for part in parts):
        raise ValueError("便携包包含本机数据或助手文件。")
    filename = parts[-1].casefold()
    lower_parts = [part.casefold() for part in parts]
    public_design_document = lower_parts in [["app", "docs", "design.md"], ["current", "app", "docs", "design.md"]]
    application_path = lower_parts[:2] == ["current", "app"] or lower_parts[0] == "app"
    if (filename in PRIVATE_FILES or filename == ".env" or filename.startswith(".env.") and filename != ".env.example"
            or filename == "design.md" and not public_design_document
            or re.fullmatch(r"desktop-display-.*\.json", filename)
            or any(left.casefold() == "public" and right.casefold() == "temp" for left, right in zip(parts, parts[1:]))
            or application_path and "data" in lower_parts and filename.endswith((".xml", ".ass"))):
        raise ValueError("便携包包含私有配置、原始数据或助手文件。")
    return path


def small_file(archive, name):
    if archive.getinfo(name).file_size > MAX_METADATA_BYTES:
        raise ValueError("便携包内部元数据过大。")
    return archive.read(name)


def decode_json(data):
    try:
        value = json.loads(data.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError("便携包内部 JSON 无效。") from None
    if not isinstance(value, dict):
        raise ValueError("便携包内部 JSON 格式无效。")
    return value


def verify_velopack(archive, version):
    data = small_file(archive, VELOPACK_METADATA)
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("便携包的更新元数据无效。")
    try:
        package = ET.fromstring(data)
    except ET.ParseError:
        raise ValueError("便携包的更新元数据无效。") from None
    expected = {"id": "AzusaHexPickApp", "version": version, "mainExe": MAIN_EXE, "channel": "win", "rid": "win-x64"}
    for name, value in expected.items():
        matches = package.findall(f"./{{*}}metadata/{{*}}{name}")
        if len(matches) != 1 or matches[0].text != value:
            raise ValueError("便携包的更新身份、版本或启动入口不一致。")


def verify_portable(path, version, base_url=None):
    try:
        with zipfile.ZipFile(path) as archive:
            all_names, file_names, folded = set(), set(), set()
            infos = archive.infolist()
            if sum(info.file_size for info in infos) > MAX_ARCHIVE_BYTES:
                raise ValueError("便携包解压大小超过检查范围。")
            for info in infos:
                name = checked_path(info.filename, info.is_dir())
                if name in all_names or name.casefold() in folded:
                    raise ValueError("便携包含重复或大小写冲突的文件路径。")
                if stat.S_ISLNK(info.external_attr >> 16) or info.flag_bits & 1:
                    raise ValueError("便携包不允许符号链接或加密条目。")
                all_names.add(name)
                folded.add(name.casefold())
                if not info.is_dir():
                    file_names.add(name)
            if MANIFEST not in file_names or VELOPACK_METADATA not in file_names:
                raise ValueError("便携包缺少内部清单或必要更新元数据。")
            manifest = decode_json(small_file(archive, MANIFEST))
            if manifest.get("version") != version:
                raise ValueError("便携包版本与官网不一致。")
            if manifest.get("platform") != "win-x64" or manifest.get("selfContained") is not True or manifest.get("personalDataIncluded") is not False:
                raise ValueError("便携包平台、运行环境或个人数据声明无效。")
            entries = manifest.get("files")
            if not isinstance(entries, list) or not entries or len(entries) > 20000:
                raise ValueError("便携包内部文件清单为空或无效。")
            paths, folded_paths = set(), set()
            for entry in entries:
                if not isinstance(entry, dict):
                    raise ValueError("便携包清单条目无效。")
                relative = checked_path(entry.get("path"))
                if relative in {"package-manifest.json", "sq.version"}:
                    raise ValueError("便携包清单不能重复声明更新元数据。")
                if relative in paths or relative.casefold() in folded_paths:
                    raise ValueError("便携包内部清单包含重复路径。")
                if not isinstance(entry.get("sha256"), str) or not re.fullmatch(r"[a-fA-F0-9]{64}", entry["sha256"]):
                    raise ValueError("便携包清单哈希无效。")
                paths.add(relative)
                folded_paths.add(relative.casefold())
            if not {MAIN_EXE, "app/package.json", "app/delivery.json"}.issubset(paths):
                raise ValueError("便携包内部清单缺少应用核心文件。")
            expected_files = ROOT_FILES | {MANIFEST, VELOPACK_METADATA} | {"current/" + name for name in paths}
            if file_names != expected_files:
                raise ValueError("便携包文件集合与清单不一致，存在丢失或额外文件。")
            if archive.getinfo(".portable").file_size != 0:
                raise ValueError("便携包标识文件不应包含数据。")
            permitted_directories = {str(parent) for name in expected_files for parent in PurePosixPath(name).parents if str(parent) != "."}
            if not (all_names - file_names).issubset(permitted_directories):
                raise ValueError("便携包包含清单外的目录。")
            for entry in entries:
                digest = hashlib.sha256()
                with archive.open("current/" + entry["path"]) as content:
                    while chunk := content.read(1024 * 1024):
                        digest.update(chunk)
                if digest.hexdigest() != entry["sha256"].lower():
                    raise ValueError("便携包内容与内部清单不一致。")
            verify_velopack(archive, version)
            application = decode_json(small_file(archive, "current/app/package.json"))
            if application.get("version") != version:
                raise ValueError("便携包应用版本与内部清单不一致。")
            for name in ROOT_FILES:
                with archive.open(name) as content:
                    if name.endswith(".exe") and content.read(2) != b"MZ":
                        raise ValueError("便携包根启动入口不是有效的 Windows 文件。")
                    # 即使标识文件或启动器不在内部清单中，也完整读取以核查 ZIP 的 CRC。
                    while content.read(1024 * 1024):
                        pass
            if base_url is not None:
                split = urlsplit(base_url)
                if split.scheme != "https" or not split.hostname or split.username or split.password or split.query or split.fragment:
                    raise ValueError("官网地址必须是无凭据的 HTTPS 地址。")
                delivery = decode_json(small_file(archive, "current/app/delivery.json"))
                base = base_url.rstrip("/") + "/"
                if delivery.get("introductionUrl") != base or delivery.get("updateBaseUrl") != urljoin(base, "updates/"):
                    raise ValueError("便携包内的官网或更新地址未配置成正式域名。")
            return {"version": version, "success": True, "files": len(entries)}
    except (zipfile.BadZipFile, KeyError, RuntimeError, NotImplementedError, zlib.error):
        raise ValueError("便携包压缩结构或内容校验失败。") from None


def main():
    if len(sys.argv) not in {3, 4}:
        raise ValueError("请提供便携包、版本及可选正式官网地址。")
    print(json.dumps(verify_portable(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
