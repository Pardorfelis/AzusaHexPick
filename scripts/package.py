"""打包可复核的应用源码与脱敏回放，不收集密钥、运行日志或原始 XML。"""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
TOP_FILES = (
    "README.md", "package.json", "server.mjs", ".env.example", ".gitignore", ".gitattributes", "CHANGELOG.md",
    "启动.cmd", "启动手机模式.cmd", "停止.cmd", "验证.cmd",
)
APP_DIRS = ("src", "public", "scripts", "docs", "tests")
DATA_FILES = ("data/equipment-aliases.json", "data/riot-equipment-names.json", "data/song-catalog.json",
              "data/replays/azusa-p3.json", "data/replays/azusa-p4.json",
              "data/replays/azusa-singing-p1.json", "data/replays/azusa-singing-p2.json")
REPORT_FILES = ("validation/replay-inspection.json",
                "validation/equipment-language-cases.json", "validation/mvp-live-check-result.json",
                "validation/mvp-ai-check-result.json", "validation/mvp-ai-flash-followup-result.json",
                "validation/mvp-load-result.json", "validation/hex-language-cases.json",
                "validation/hex-review-result.json", "validation/hex-ai-initial-result.json",
                "validation/hex-ai-check-result.json", "validation/hex-display-check-result.json",
                "validation/hex-ui-check-result.json", "validation/hex-review.mjs",
                "validation/hex-v03-profile.json", "validation/hex-v03-review-result.json",
                "validation/riot-item-16.19.1.json", "validation/equipment-expansion-sources.md",
                "validation/equipment-expansion-result.json", "validation/equipment-history-review.mjs",
                "validation/equipment-history-review-result.json", "validation/live-equipment-observation-result.json",
                "validation/live-equipment-observation-report.md", "validation/equipment-v03-ai-initial-result.json",
                "validation/equipment-v03-ai-assessment.mjs", "validation/equipment-v03-ai-assessment-result.json",
                "validation/desktop-v03-check-result.json", "validation/web-v03-check-result.json",
                "validation/automated-v03-check-result.json", "validation/song-catalog-sources.md",
                "validation/song-replay-inspection.json", "validation/song-replay-review.mjs",
                "validation/song-replay-review-result.json", "validation/song-v04-check-result.json", "validation/frontend-v05-check-result.json")
ASSET_FILES = ("public/assets/azusa-snack.jpg", "public/assets/azusa-brand.png",
               "public/assets/azusa-computer.png", "public/assets/azusa-panel-brand.png",
               "public/assets/azusa-cheer.gif", "public/assets/azusa-sing.gif",
               "public/assets/fonts/Manrope.ttf", "public/assets/fonts/OFL.txt")
EXTENSIONS = {".mjs", ".js", ".css", ".html", ".py", ".ps1", ".md", ".json"}
LOCAL_DOCUMENTS = {"docs/plan.md"}
LOCAL_NAMES = {"AGENTS.md", "CLAUDE.md", "GEMINI.md"}


def package_files(root=ROOT):
    files = {root / name for name in TOP_FILES + REPORT_FILES + DATA_FILES + ASSET_FILES}
    for directory in APP_DIRS:
        for path in (root / directory).rglob("*"):
            if (path.is_file() and path.suffix in EXTENSIONS and "__pycache__" not in path.parts
                    and path.name not in LOCAL_NAMES
                    and not {".agents", ".codex", ".claude", ".impeccable"}.intersection(path.parts)
                    and path.relative_to(root).as_posix() not in LOCAL_DOCUMENTS):
                files.add(path)
    for path in files:
        relative = path.relative_to(root)
        if path.is_symlink() or not path.is_file():
            raise ValueError("打包文件不存在。")
        if any(part in {".runtime", "node_modules", "dist", ".env.local"} for part in relative.parts):
            raise ValueError("打包范围包含不允许的文件。")
        if path.name.startswith(".env") and path.name != ".env.example":
            raise ValueError("打包范围包含私有配置。")
    return sorted(files, key=lambda path: path.relative_to(root).as_posix())


def build_package():
    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    archive = output / f"azusa-hexpick-{VERSION}.zip"
    prefix = f"azusa-hexpick-{VERSION}"
    entries = []
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as target:
        for path in package_files():
            content = path.read_bytes()
            relative = path.relative_to(ROOT).as_posix()
            entries.append({"path": relative, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()})
            target.writestr(prefix + "/" + relative, content)
        manifest = {"version": VERSION, "files": entries,
                    "requires": ["Node.js >= 22", "Windows desktop: Python >= 3.10 with Tkinter"],
                    "privateConfigIncluded": False, "originalXmlIncluded": False}
        target.writestr(prefix + "/package-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(archive) as check:
        if check.testzip() is not None:
            raise ValueError("压缩包校验失败。")
        expected = {prefix + "/" + item["path"] for item in entries} | {prefix + "/package-manifest.json"}
        if set(check.namelist()) != expected:
            raise ValueError("压缩包目录不匹配。")
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / (archive.name + ".sha256")).write_text(checksum + "  " + archive.name + "\n", encoding="utf-8")
    print(json.dumps({"archive": str(archive), "files": len(entries), "bytes": archive.stat().st_size,
                      "sha256": checksum, "privateConfigIncluded": False}, ensure_ascii=False))


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    build_package()
