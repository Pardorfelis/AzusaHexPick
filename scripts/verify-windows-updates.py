"""在隔离目录验证 Windows 更新包、故障回退和个人配置，不调用付费模型。"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from urllib.parse import urlparse
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def verify(base, target, cases):
    feed = ROOT / ".runtime/update-test-feed"
    source = json.loads((feed / "releases.win.json").read_text(encoding="utf-8"))
    asset = next(item for item in source["Assets"] if item["Version"] == target and item["Type"] == "Full")
    archive = feed / f"portable-{base}.zip"
    results = []
    for case in cases:
        folder = ROOT / ".runtime" / f"update-matrix-{base}-{target}-{case}"
        folder.mkdir(parents=True, exist_ok=True)
        application = folder / "application"
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(application)
        user = folder / "user"
        if (user / "smoke-result.json").exists():
            raise ValueError("该验证目录已有结果，请换用新的测试版本。")

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                path = urlparse(self.path).path
                if path.endswith("/releases.win.json"):
                    content = json.dumps({"Assets": [asset]}).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
                elif path.endswith("/" + asset["FileName"]):
                    self.send_response(200)
                    self.send_header("Content-Length", str(asset["Size"]))
                    self.end_headers()
                    try:
                        with (feed / asset["FileName"]).open("rb") as package:
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
    (ROOT / ".runtime/v07-update-matrix.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="0.7.905")
    parser.add_argument("--target", default="0.7.906")
    parser.add_argument("--cases", nargs="+", default=["corrupt", "interrupt", "cancel", "new-round"])
    options = parser.parse_args()
    verify(options.base, options.target, options.cases)
