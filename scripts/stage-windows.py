"""为 Windows 交付包写入明确白名单内的应用资源，不复制个人数据。"""
import hashlib
import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent

def stage(destination):
    destination = Path(destination).resolve()
    if destination != ROOT / "dist" / "windows-stage":
        raise ValueError("交付目录必须位于项目的固定构建目录。")
    app = destination / "app"
    files = [ROOT / name for name in ("server.mjs", "package.json", "delivery.json", "README.md", "CHANGELOG.md",
             "data/equipment-aliases.json", "data/riot-equipment-names.json", "data/song-catalog.json",
             "scripts/migrate-user-data.mjs", "validation/replay-inspection.json")]
    for directory, extensions in (("public", {".js", ".css", ".html", ".json", ".png", ".jpg", ".gif", ".ttf", ".txt", ".md"}),
                                  ("src", {".mjs"}), ("data/replays", {".json"}), ("docs", {".md"})):
        for path in (ROOT / directory).rglob("*"):
            if path.is_file() and path.suffix in extensions and path.name not in {"AGENTS.md", "plan.md"}:
                if directory == "data/replays" and path.name not in {"azusa-p3.json", "azusa-p4.json", "azusa-singing-p1.json", "azusa-singing-p2.json"}:
                    continue
                files.append(path)
    for path in files:
        if not path.is_file() or path.is_symlink():
            raise ValueError("交付资源缺失或不支持符号链接。")
        target = app / path.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    licenses = destination / "licenses"
    licenses.mkdir(exist_ok=True)
    shutil.copyfile(ROOT / "launcher/Assets/README.md", licenses / "launcher-assets.md")
    python_license = Path(sys.base_prefix) / "LICENSE.txt"
    if not python_license.is_file():
        raise ValueError("Python 许可文件缺失。")
    shutil.copyfile(python_license, licenses / "Python.txt")
    node_license = ROOT / ".runtime/tools/node-LICENSE.txt"
    if not node_license.is_file():
        raise ValueError("Node 许可文件缺失。")
    shutil.copyfile(node_license, licenses / "Node.txt")
    # Velopack 会排除该运行时诊断工具；预先移除，让清单与交付文件一致。
    crash_dump = destination / "createdump.exe"
    if crash_dump.is_file():
        crash_dump.unlink()
    entries = [{"path": p.relative_to(destination).as_posix(), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
               for p in destination.rglob("*") if p.is_file() and p.name != "package-manifest.json"]
    manifest = {"version": json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"],
                "platform": "win-x64", "selfContained": True, "personalDataIncluded": False, "files": entries}
    (destination / "package-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"files": len(entries), "selfContained": True}))

if __name__ == "__main__":
    stage(sys.argv[1])
