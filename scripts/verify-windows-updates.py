"""在隔离目录验证 Windows 更新包、故障回退和个人配置，不调用付费模型。"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import shutil
from pathlib import Path
import subprocess
import threading
import time
from urllib.parse import urlparse
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def verify(base, target, cases, test_directory=None):
    test_root = Path(test_directory).resolve() if test_directory else ROOT / ".runtime/update-v071-test"
    if not test_root.is_relative_to(ROOT / ".runtime") or test_root == ROOT / ".runtime":
        raise ValueError("更新测试目录必须位于本项目的 .runtime 内。")
    feed = test_root / "feed"
    source = json.loads((feed / "releases.win.json").read_text(encoding="utf-8"))
    asset = next(item for item in source["Assets"] if item["Version"] == target and item["Type"] == "Full")
    archive = feed / f"portable-{base}.zip"
    results = []
    for case in cases:
        folder = test_root / f"matrix-{base}-{target}-{case}"
        folder.mkdir(parents=True, exist_ok=True)
        application = folder / "application"
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(application)
        user = folder / "user"
        if (user / "smoke-result.json").exists():
            raise ValueError("该验证目录已有结果，请换用新的测试版本。")
        published = [asset]
        downloads = []
        if case == "delta":
            version_parts = lambda value: tuple(int(part) for part in value.split('.'))
            published = [item for item in source['Assets'] if version_parts(base) <= version_parts(item['Version']) <= version_parts(target)]
            cached = next(item for item in published if item['Version'] == base and item['Type'] == 'Full')
            (application / 'packages').mkdir(exist_ok=True)
            shutil.copyfile(feed / cached['FileName'], application / 'packages' / cached['FileName'])

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                path = urlparse(self.path).path
                if path.endswith("/releases.win.json"):
                    content = json.dumps({"Assets": published}).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
                elif requested := next((item for item in published if path.endswith('/' + item['FileName'])), None):
                    downloads.append(requested['FileName'])
                    self.send_response(200)
                    self.send_header("Content-Length", str(requested["Size"]))
                    self.end_headers()
                    try:
                        with (feed / requested["FileName"]).open("rb") as package:
                            first = True
                            while chunk := package.read(256 * 1024):
                                if case == "corrupt" and first:
                                    chunk = bytes([chunk[0] ^ 255]) + chunk[1:]
                                self.wfile.write(chunk)
                                self.wfile.flush()
                                if case == "interrupt":
                                    self.close_connection = True
                                    return
                                first = False
                                if case in {"cancel", "new-round"}:
                                    time.sleep(.006)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        pass
                else:
                    self.send_error(404)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        environment = {**os.environ, "AZUSA_USER_DATA": str(user),
                       "AZUSA_TEST_UPDATE_FEED": f"http://127.0.0.1:{server.server_port}",
                       "AZUSA_SMOKE_FAULT": "download" if case in {"interrupt", "corrupt"} else case,
                       "DEEPSEEK_API_KEY": "", "PATH": str(Path(os.environ["SystemRoot"]) / "System32")}
        for name in ("DOTNET_ROOT", "PYTHONHOME", "PYTHONPATH", "NODE_OPTIONS"):
            environment.pop(name, None)
        process = subprocess.Popen([str(application / "current/梓有妙选.exe"), "--smoke-update"], env=environment,
                                   creationflags=subprocess.CREATE_NO_WINDOW, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        report = user / "smoke-result.json"
        deadline = time.monotonic() + 120
        try:
            while not report.exists() and time.monotonic() < deadline:
                time.sleep(.3)
            if not report.exists():
                if process.poll() is None:
                    process.terminate()
                raise TimeoutError("隔离更新验证超时。")
            value = json.loads(report.read_text(encoding="utf-8"))
            if case == 'delta':
                if not any(name.endswith('-delta.nupkg') for name in downloads) or any(name.endswith('-full.nupkg') for name in downloads):
                    raise ValueError('差量验证没有实际下载差量包，或回退了完整包。')
                value['deltaDownloads'] = downloads
            results.append({"case": case, **value})
            if not value.get("success"):
                raise ValueError(json.dumps(value, ensure_ascii=False))
            for _ in range(30):
                if process.poll() is not None:
                    break
                time.sleep(.1)
            print(json.dumps({"case": case, "success": True, "paidApiCalls": 0}), flush=True)
        finally:
            server.shutdown()
            server.server_close()
    (test_root / f"matrix-{base}-{target}.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="0.7.911")
    parser.add_argument("--target", default="0.7.912")
    parser.add_argument("--test-directory")
    parser.add_argument("--cases", nargs="+", default=["corrupt", "interrupt", "cancel", "new-round"])
    options = parser.parse_args()
    verify(options.base, options.target, options.cases, options.test_directory)
