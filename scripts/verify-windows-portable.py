"""在独立用户目录启动 Windows 便携包，检查运行环境、短回放和完整退出。"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener
import zipfile

ROOT = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:5178"
HTTP = build_opener(ProxyHandler({}))


def request(path, data=None):
    headers = {"X-Panel-Control": "1"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    query = Request(BASE + path, json.dumps(data).encode() if data is not None else None, headers)
    with HTTP.open(query, timeout=3) as response:
        return json.load(response)


def wait_for(predicate, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except (URLError, OSError):
            pass
        time.sleep(.2)
    raise TimeoutError("最终便携包验证等待超时。")


def verify(archive, directory, version):
    directory = Path(directory).resolve()
    if not directory.is_relative_to(ROOT / ".runtime") or directory == ROOT / ".runtime" or directory.exists():
        raise ValueError("请指定 .runtime 内尚未使用的独立验证目录。")
    try:
        request("/api/health")
    except (URLError, OSError):
        pass
    else:
        raise ValueError("5178 已有服务，无法执行隔离验证。")
    spec = importlib.util.spec_from_file_location("portable_check", ROOT / "scripts/verify-site-portable.py")
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    checker.verify_portable(archive, version)
    directory.mkdir(parents=True)
    application = directory / "application"
    with zipfile.ZipFile(archive) as package:
        package.extractall(application)
    user = directory / "user"
    user.mkdir()
    (user / "launcher.json").write_text('{"PhoneMode":false,"OnboardingComplete":true}', encoding="utf-8")
    (user / "app-settings.json").write_text('{"enabled":false,"hexEnabled":false}', encoding="utf-8")
    environment = {**os.environ, "AZUSA_USER_DATA": str(user), "DEEPSEEK_API_KEY": "",
                   "PATH": str(Path(os.environ["SystemRoot"]) / "System32")}
    for name in ("DOTNET_ROOT", "PYTHONHOME", "PYTHONPATH", "NODE_OPTIONS", "AZUSA_TEST_UPDATE_FEED", "AZUSA_SMOKE_FAULT"):
        environment.pop(name, None)
    executable = application / "梓有妙选.exe"
    process = subprocess.Popen([str(executable), "--resume"], env=environment, creationflags=subprocess.CREATE_NO_WINDOW)
    result = {"version": version, "success": False, "paidApiCalls": 0}
    try:
        health = wait_for(lambda: request("/api/health"))
        if health.get("version") != version or health.get("aiConfigured"):
            raise ValueError("运行版本不符，或隔离测试意外配置了 AI。")
        helper = wait_for(lambda: request("/api/state").get("helperConnected"))
        application_state = request("/api/application")
        if not application_state.get("launcher", {}).get("available") or application_state["launcher"].get("version") != version:
            raise ValueError("最终便携包的启动器管理桥未连接。")
        repeat = subprocess.Popen([str(executable)], env=environment, creationflags=subprocess.CREATE_NO_WINDOW)
        repeat.wait(timeout=10)
        if repeat.returncode != 0 or request("/api/health")["version"] != version:
            raise ValueError("重复启动未能复用当前程序。")
        modes = []
        for mode, dataset, position in [("hex", "azusa-p3", 6830), ("equipment", "azusa-p3", 6830),
                                         ("songs", "azusa-singing-p1", 2790)]:
            request("/api/control", {"action": "replay-load", "dataset": dataset, "position": position, "speed": 4})
            request("/api/control", {"action": "replay-play", "mode": mode, "seconds": 10})
            state = wait_for(lambda: request("/api/state"))
            if state["mode"] != mode or state["status"] != "collecting":
                raise ValueError("最终便携包无法进入统计模式。")
            time.sleep(2)
            state = request("/api/control", {"action": "replay-pause"})
            if state["status"] != "locked" or state.get("ai", {}).get("requests") != 0:
                raise ValueError("回放未锁定，或出现非预期模型请求。")
            modes.append({"mode": mode, "received": state["receivedMessages"], "valid": state["validMessages"], "locked": True})
        result.update({"success": True, "selfContainedStart": True, "desktopConnected": bool(helper),
                       "launcherBridgeConnected": True, "repeatStartReused": True, "modes": modes})
    finally:
        try:
            health = request("/api/health")
            if health.get("app") == "azusa-validation":
                request("/api/control", {"action": "exit-all"})
        except (URLError, OSError):
            pass
        for _ in range(60):
            try:
                request("/api/health")
            except (URLError, OSError):
                result["serviceExited"] = True
                break
            time.sleep(.2)
        else:
            result["success"] = False
            result["serviceExited"] = False
        if process.poll() is None:
            process.wait(timeout=15)
        (directory / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if not result["success"]:
        raise ValueError("最终便携包验证未完成，请检查本机报告。")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    parser.add_argument("--directory", required=True)
    parser.add_argument("--version", default="0.7.1")
    args = parser.parse_args()
    verify(args.archive, args.directory, args.version)
