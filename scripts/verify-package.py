"""检查 ZIP 内容，再在独立解压目录执行全部检查，不连接真实直播或付费模型。"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
PREFIX = "azusa-hexpick-" + VERSION
ARCHIVE = ROOT / "dist" / (PREFIX + ".zip")


def verify():
    runtime = (ROOT / ".runtime").resolve()
    if not runtime.is_relative_to(ROOT.resolve()):
        raise ValueError("临时目录超出项目范围。")
    runtime.mkdir(exist_ok=True)
    with zipfile.ZipFile(ARCHIVE) as archive:
        manifest = json.loads(archive.read(PREFIX + "/package-manifest.json"))
        expected = {PREFIX + "/" + item["path"] for item in manifest["files"]}
        expected.add(PREFIX + "/package-manifest.json")
        if set(archive.namelist()) != expected:
            raise ValueError("压缩包范围不匹配。")
        for item in manifest["files"]:
            name = item["path"]
            parts = Path(name).parts
            if ".." in parts or Path(name).is_absolute() or any(part in {".env.local", ".runtime", "dist"} for part in parts):
                raise ValueError("压缩包含不允许的路径。")
            if name.endswith((".xml", ".ass")) or "deepseek-api-result" in name:
                raise ValueError("压缩包含私有验证资料。")
            content = archive.read(PREFIX + "/" + name)
            if len(content) != item["bytes"] or hashlib.sha256(content).hexdigest() != item["sha256"]:
                raise ValueError("文件校验失败。")
        with tempfile.TemporaryDirectory(prefix="package-smoke-", dir=runtime) as folder:
            target = Path(folder).resolve()
            if not target.is_relative_to(runtime):
                raise ValueError("解压目录超出项目范围。")
            archive.extractall(target)
            project = target / PREFIX
            environment = {**os.environ, "DEEPSEEK_API_KEY": ""}
            commands = [
                ["node", "--test", *[str(path) for path in sorted((project / "tests").glob("*.test.mjs"))]],
                ["python", "-X", "utf8", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
            ]
            results = []
            for index, command in enumerate(commands):
                process = subprocess.run(command, cwd=project, env=environment, capture_output=True,
                                         text=True, encoding="utf-8", errors="replace", timeout=60)
                (runtime / f"package-check-{index}.log").write_text(process.stdout + process.stderr, encoding="utf-8")
                results.append({"runner": "node" if index == 0 else "python", "exitCode": process.returncode})
                if process.returncode != 0:
                    raise ValueError("解压目录中的检查未通过，请查看本机打包日志。")
    result = {"archive": ARCHIVE.name, "manifestFiles": len(manifest["files"]),
              "sha256": hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(),
              "privateConfigIncluded": False, "originalXmlIncluded": False,
              "extractedTests": results, "paidApiCalls": 0}
    (ROOT / "validation" / ("package-" + VERSION + "-smoke-result.json")).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    verify()
