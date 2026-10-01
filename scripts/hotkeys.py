"""Windows 全局快捷键辅助程序，不模拟按键，不改变前台窗口。

注册失败时仍可使用网页控制台。控制服务持续不可达约 10 秒后自动退出。
"""

import argparse
import ctypes
from ctypes import wintypes
from hashlib import sha256
import json
from pathlib import Path
import queue
import sys
import threading
import time
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_NOREPEAT = 0x4000
WM_HOTKEY = 0x0312
WM_QUIT = 0x0012
KEYS = (
    (1, 0x76, "F7", {"action": "round", "mode": "hex"}),
    (2, 0x77, "F8", {"action": "round", "mode": "equipment"}),
    (3, 0x78, "F9", {"action": "lock"}),
    (4, 0x75, "F6", {"action": "round", "mode": "songs", "seconds": 60, "counting": "messages"}),
)


class ServerReachability:
    """只依据 HTTP 成败计时，普通直播数据源断连不属于服务器失联。"""
    def __init__(self, timeout=10.0):
        self.timeout = timeout
        self.first_failure_at = None

    def success(self):
        self.first_failure_at = None

    def failure(self, now):
        if self.first_failure_at is None:
            self.first_failure_at = now

    def should_exit(self, now):
        return self.first_failure_at is not None and now - self.first_failure_at >= self.timeout


def mutex_name(project, port):
    identity = sha256(str(Path(project).resolve()).casefold().encode("utf-8")).hexdigest()[:16]
    return f"Local\\AzusaSuggestionPanel-{identity}-{port_number(port)}"


class ProjectMutex:
    def __init__(self, port):
        self.name = mutex_name(Path(__file__).resolve().parent.parent, port)
        self.kernel32 = None
        self.handle = None

    def acquire(self):
        if sys.platform != "win32":
            raise OSError("桌面单实例控制仅支持 Windows。")
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel32.CreateMutexW.restype = wintypes.HANDLE
        self.kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel32.CloseHandle.restype = wintypes.BOOL
        ctypes.set_last_error(0)
        handle = self.kernel32.CreateMutexW(None, False, self.name)
        if not handle:
            raise OSError("无法建立桌面单实例控制。")
        if ctypes.get_last_error() == 183:
            self.kernel32.CloseHandle(handle)
            return False
        self.handle = handle
        return True

    def close(self):
        if self.handle:
            self.kernel32.CloseHandle(self.handle)
            self.handle = None


def port_number(value):
    try:
        port = int(value)
    except (ValueError, TypeError):
        raise ValueError("端口必须是 1 至 65535 之间的整数。") from None
    if not 1 <= port <= 65535:
        raise ValueError("端口必须是 1 至 65535 之间的整数。")
    return port


def control_for_key(identifier):
    for key_id, _, _, action in KEYS:
        if identifier == key_id:
            return dict(action)
    return None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def post_control(action, port=5178, opener=None):
    """只向固定回环地址请求，无代理、Cookie 或跨地址重定向。"""
    port = port_number(port)
    data = json.dumps(action, ensure_ascii=False).encode("utf-8")
    request = Request(
        f"http://127.0.0.1:{port}/api/control",
        data=data,
        headers={"Content-Type": "application/json", "X-Panel-Control": "1"},
        method="POST",
    )
    send = opener or build_opener(ProxyHandler({}), NoRedirect()).open
    with send(request, timeout=2.0) as response:
        if not 200 <= response.status < 300:
            raise OSError("本机控制服务拒绝了请求。")
        response.read(4096)


def report_status(status):
    line = json.dumps({"time": time.strftime("%Y-%m-%d %H:%M:%S"), **status}, ensure_ascii=False)
    if sys.stderr is not None:
        print(line, file=sys.stderr, flush=True)
    else:
        try:
            destination = Path(__file__).resolve().parent.parent / "logs" / "hotkeys.log"
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists() and destination.stat().st_size > 256 * 1024:
                destination.write_text("", encoding="utf-8")
            with destination.open("a", encoding="utf-8") as stream:
                stream.write(line + "\n")
        except OSError:
            pass


class WinHotkeyAPI:
    def __init__(self):
        if sys.platform != "win32":
            raise OSError("全局快捷键辅助程序仅支持 Windows。")
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.user32.RegisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT]
        self.user32.RegisterHotKey.restype = wintypes.BOOL
        self.user32.UnregisterHotKey.argtypes = [wintypes.HWND, ctypes.c_int]
        self.user32.UnregisterHotKey.restype = wintypes.BOOL
        self.user32.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
        self.user32.PeekMessageW.restype = wintypes.BOOL
        self.user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
        self.user32.GetMessageW.restype = ctypes.c_int
        self.user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, ctypes.c_size_t, ctypes.c_ssize_t]
        self.user32.PostThreadMessageW.restype = wintypes.BOOL
        self.kernel32.GetCurrentThreadId.argtypes = []
        self.kernel32.GetCurrentThreadId.restype = wintypes.DWORD

    def prepare_queue(self):
        message = wintypes.MSG()
        self.user32.PeekMessageW(ctypes.byref(message), None, 0, 0, 0)
        return int(self.kernel32.GetCurrentThreadId())

    def register(self, identifier, virtual_key):
        return bool(self.user32.RegisterHotKey(None, identifier, MOD_ALT | MOD_CONTROL | MOD_NOREPEAT, virtual_key))

    def unregister(self, identifier):
        return bool(self.user32.UnregisterHotKey(None, identifier))

    def next_key(self):
        message = wintypes.MSG()
        result = self.user32.GetMessageW(ctypes.byref(message), None, 0, 0)
        if result < 0:
            raise OSError("Windows 消息循环发生错误。")
        if result == 0:
            return None
        return int(message.wParam) if message.message == WM_HOTKEY else 0

    def quit(self, thread_id):
        if thread_id:
            self.user32.PostThreadMessageW(thread_id, WM_QUIT, 0, 0)


class HotkeyHelper:
    def __init__(self, port=5178, on_status=None, api_factory=WinHotkeyAPI, post=post_control):
        self.port = port_number(port)
        self.on_status = on_status or report_status
        self.api_factory = api_factory
        self.post = post
        self.stop_event = threading.Event()
        self.ready = threading.Event()
        self.commands = queue.Queue(maxsize=32)
        self.thread = None
        self.http_thread = None
        self.heartbeat_thread = None
        self.api = None
        self.thread_id = None
        self.active = False
        self.registered_count = 0
        self.released_count = 0
        self.cleanup_complete = threading.Event()
        self.server_health = ServerReachability()

    def status(self, active, message, registered=0):
        self.active = bool(active)
        self.on_status({"active": self.active, "message": message, "registered": registered})

    def start(self):
        if self.thread and self.thread.is_alive():
            return self
        self.stop_event.clear()
        self.ready.clear()
        self.cleanup_complete.clear()
        self.registered_count = 0
        self.released_count = 0
        self.server_health = ServerReachability()
        self.commands = queue.Queue(maxsize=32)
        self.thread = threading.Thread(target=self.run, name="panel-hotkeys", daemon=True)
        self.thread.start()
        self.ready.wait(2.0)
        return self

    def enqueue(self, action):
        if not self.active or self.stop_event.is_set():
            return
        try:
            self.commands.put_nowait(action)
        except queue.Full:
            self.status(True, "快捷键操作过快，请稍候。", len(KEYS))

    def http_worker(self):
        while not self.stop_event.is_set():
            if self.server_health.should_exit(time.monotonic()):
                self.status(False, "控制服务持续不可达，辅助程序已停止。")
                self.stop_event.set()
                self.api.quit(self.thread_id)
                return
            try:
                action = self.commands.get(timeout=0.25)
            except queue.Empty:
                continue
            if self.stop_event.is_set() or not self.active:
                continue
            try:
                self.post(action, self.port)
                self.server_health.success()
            except (OSError, ValueError):
                self.server_health.failure(time.monotonic())
                if not self.stop_event.is_set() and self.active:
                    self.status(True, "快捷键已注册，控制服务暂不可达。", len(KEYS))

    def heartbeat_worker(self):
        while not self.stop_event.is_set() and self.active:
            self.enqueue({"action": "helper-heartbeat", "active": True, "status": "keys-registered", "registered": len(KEYS)})
            if self.stop_event.wait(5.0):
                return

    def run(self):
        registered = []
        try:
            self.api = self.api_factory()
            self.thread_id = self.api.prepare_queue()
            failed = []
            for identifier, virtual_key, label, _ in KEYS:
                if self.api.register(identifier, virtual_key):
                    registered.append(identifier)
                    self.registered_count += 1
                else:
                    failed.append(label)
            if failed:
                self.status(False, "快捷键无法注册：" + "、".join(failed) + "。仍可使用网页控制台。", len(registered))
                return
            if self.stop_event.is_set():
                return
            self.status(True, "全局快捷键已启用。", len(registered))
            self.http_thread = threading.Thread(target=self.http_worker, name="panel-control-http", daemon=True)
            self.heartbeat_thread = threading.Thread(target=self.heartbeat_worker, name="panel-helper-heartbeat", daemon=True)
            self.http_thread.start()
            self.heartbeat_thread.start()
            self.ready.set()
            while not self.stop_event.is_set():
                identifier = self.api.next_key()
                if identifier is None:
                    break
                action = control_for_key(identifier)
                if action:
                    self.enqueue(action)
        except OSError:
            self.status(False, "全局快捷键启动失败，请检查本机权限与快捷键占用。", len(registered))
        finally:
            was_active = self.active
            self.active = False
            self.stop_event.set()
            for identifier in registered:
                try:
                    if self.api.unregister(identifier):
                        self.released_count += 1
                except OSError:
                    pass
            self.cleanup_complete.set()
            self.ready.set()
            if was_active:
                self.status(False, "全局快捷键已停止。")

    def stop(self):
        self.active = False
        self.stop_event.set()
        if self.api and self.thread_id:
            self.api.quit(self.thread_id)
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=2.0)
        released = self.cleanup_complete.is_set() and self.registered_count == self.released_count
        self.status(False, "全局快捷键已停止。" if released else "全局快捷键释放尚未确认。")


def main():
    parser = argparse.ArgumentParser(description="阿梓建议面板全局快捷键辅助程序")
    parser.add_argument("--port", type=int, default=5178)
    options = parser.parse_args()
    helper = HotkeyHelper(options.port).start()
    try:
        if not helper.active:
            return 1
        while helper.thread.is_alive():
            helper.thread.join(timeout=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        helper.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
