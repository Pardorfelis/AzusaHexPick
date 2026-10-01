"""副屏只读面板，后台取快照，Tk 主线程绘图，窗口不激活。"""

import argparse
import ctypes
from ctypes import wintypes
import json
import math
from pathlib import Path
import queue
import struct
import sys
import threading
import time
import tkinter as tk
from tkinter import font as tkfont
from urllib.request import ProxyHandler, Request, build_opener

from hotkeys import HotkeyHelper, NoRedirect, ProjectMutex, ServerReachability, port_number

COLORS = {"background": "#0e1125", "card": "#171a32", "border": "#30304d", "text": "#efedf8", "muted": "#b0abc8", "credit": "#868cac", "purple": "#a782ff", "teal": "#5eead4", "amber": "#fbbf24", "red": "#fb7185"}
HEX_PRIMARY_KEYS = ("1", "2", "3", "1d", "2d", "3d")
HEX_EXTRA_KEYS = ("12d", "13d", "23d", "d")
HEX_KEYS = HEX_PRIMARY_KEYS + HEX_EXTRA_KEYS
HEX_LABELS = {"1": "选 1", "2": "选 2", "3": "选 3", "1d": "刷新 1", "2d": "刷新 2", "3d": "刷新 3",
              "12d": "刷新 1＋2", "13d": "刷新 1＋3", "23d": "刷新 2＋3", "d": "全部刷新"}
PANEL_HEIGHT = 520


def nonnegative(value):
    if isinstance(value, bool):
        return 0
    try:
        number = float(value)
        return max(0, int(number)) if math.isfinite(number) else 0
    except (ValueError, TypeError, OverflowError):
        return 0


def format_votes(value):
    number = nonnegative(value)
    return str(number) if number < 10000 else f"{number / 10000:.1f} 万"


def format_stat_count(value):
    if value is None:
        return "—"
    number = nonnegative(value)
    if number < 100000000:
        return format_votes(number)
    if number < 1000000000000:
        return f"{number / 100000000:.1f} 亿"
    return f"{number:.1e}"


def statistics_line(view):
    return " · ".join(f"{label} {format_stat_count(view.get(key))}" for label, key in
                      (("收到", "received"), ("计入", "included"), ("未决", "unresolved")))


def statistics_font_size(label, available_width, measure):
    return 10 if measure(label, 10) <= available_width else 9


def unknown_line(item):
    term = item["term"]
    term = term if len(term) <= 14 else term[:14] + "…"
    return f"待确认：{term} {format_stat_count(item['mentions'])}"


def fit_one_line(label, available_width, measure):
    if measure(label) <= available_width:
        return label
    if measure("…") > available_width:
        return ""
    left, right = 0, len(label)
    while left < right:
        middle = (left + right + 1) // 2
        if measure(label[:middle].rstrip() + "…") <= available_width:
            left = middle
        else:
            right = middle - 1
    return label[:left].rstrip() + "…"


def choose_position(monitors, width=380, height=PANEL_HEIGHT):
    usable = [monitor for monitor in monitors if monitor.get("right", 0) > monitor.get("left", 0) and monitor.get("bottom", 0) > monitor.get("top", 0)]
    chosen = next((monitor for monitor in usable if not monitor.get("primary")), usable[0] if usable else {"left": 0, "top": 0, "right": 1920, "bottom": 1080})
    x = max(chosen["left"], chosen["right"] - width - 24)
    y = max(chosen["top"], min(chosen["top"] + 24, chosen["bottom"] - height))
    return x, y


def layout(width=380):
    width = max(360, min(640, int(width)))
    margin, gap = 16, 10
    cell = (width - margin * 2 - gap * 2) / 3
    small_gap = 8
    small_cell = (width - margin * 2 - small_gap * 3) / 4
    return {
        "width": width, "height": PANEL_HEIGHT,
        "header": (0, 0, width, 44), "leader": (16, 76, width - 16, 182),
        "cards": [(margin + (index % 3) * (cell + gap), 214 + (index // 3) * 62,
                   margin + (index % 3) * (cell + gap) + cell, 268 + (index // 3) * 62) for index in range(6)],
        "extra_cards": [(margin + index * (small_cell + small_gap), 338,
                         margin + index * (small_cell + small_gap) + small_cell, 386) for index in range(4)],
        "equipment": [(16, 214 + index * 44, width - 16, 250 + index * 44) for index in range(3)],
        "unknown_y": (344, 362), "against_y": 381,
        "footer": (16, 399, width - 16, 456), "helper_y": 471,
    }


def build_view(state, online=True, elapsed_ms=0):
    state = state if isinstance(state, dict) else {}
    snapshot = state.get("snapshot", state)
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    mode = "equipment" if snapshot.get("mode") == "equipment" else "hex"
    connected = online and snapshot.get("connection") == "connected"
    status = str(snapshot.get("status", "idle"))
    remaining = max(0, nonnegative(snapshot.get("remainingMs")) - nonnegative(elapsed_ms))
    expired = status == "expired" or snapshot.get("lockReason") == "timeout" or status == "collecting" and nonnegative(snapshot.get("roundId")) > 0 and remaining == 0
    if not online:
        status_label = "统计中断"
    elif not connected:
        status_label = "等待连接" if snapshot.get("connection") == "connecting" else "统计暂停"
    elif expired:
        status_label = "本轮已到期"
    else:
        status_label = {"collecting": "收集中", "locked": "本轮已锁定", "paused": "统计暂停", "idle": "等待新轮"}.get(status, "等待新轮")
    source = str(state.get("sourceKind", snapshot.get("source", "")))
    source_label = "回放验证" if source.startswith("replay") else "实时弹幕" if source.startswith("live") else "未连接"
    items = []
    if mode == "hex":
        raw = snapshot.get("hex", [])
        raw = raw if isinstance(raw, list) else []
        indexed = {str(item.get("key")): item for item in raw if isinstance(item, dict)}
        items = [{"key": key, "label": str(indexed.get(key, {}).get("label") or HEX_LABELS[key]),
                  "votes": nonnegative(indexed.get(key, {}).get("votes")) if connected else 0} for key in HEX_KEYS]
    else:
        equipment = snapshot.get("equipment", {})
        equipment = equipment if isinstance(equipment, dict) else {}
        raw = equipment.get("top3", [])
        if connected and isinstance(raw, list):
            items = [{"label": str(item.get("name", "未知装备"))[:50], "votes": nonnegative(item.get("votes"))} for item in raw[:3] if isinstance(item, dict)]
    maximum = max((item["votes"] for item in items), default=0)
    leaders = [item["label"] for item in items if item["votes"] == maximum and maximum > 0]
    if not connected:
        leader = "等待恢复统计" if not online else "等待直播连接"
    elif not leaders:
        leader = "等待有效建议" if status == "collecting" and not expired else "等待开始新轮" if status == "idle" else "本轮没有有效建议"
    elif len(leaders) == 1:
        leader = leaders[0]
    elif len(leaders) <= 2:
        leader = "并列：" + "／".join(leaders)
    else:
        leader = f"{len(leaders)} 项并列"
    equipment = snapshot.get("equipment", {})
    against = equipment.get("against", []) if isinstance(equipment, dict) else []
    against = against if isinstance(against, list) else []
    against_label = "反对：" + "、".join(str(item.get("name", ""))[:12] + " " + format_votes(item.get("votes")) for item in against[:2] if isinstance(item, dict)) if connected and mode == "equipment" and against else ""
    raw_unknown = equipment.get("unknown", []) if isinstance(equipment, dict) else []
    unknown = []
    if connected and mode == "equipment" and isinstance(raw_unknown, list):
        for item in raw_unknown[:3]:
            if not isinstance(item, dict) or not isinstance(item.get("term"), str) or not item["term"].strip():
                continue
            mentions = nonnegative(item.get("mentions", item.get("messageMentions")))
            if mentions >= 3:
                unknown.append({"term": item["term"].strip()[:80], "mentions": mentions})
        unknown = unknown[:2]
    diagnostics = snapshot.get("hexDiagnostics", {})
    diagnostics = diagnostics if isinstance(diagnostics, dict) else {}
    pending = snapshot.get("pendingTotal", diagnostics.get("pendingCount", snapshot.get("pendingCount"))) if mode == "hex" else snapshot.get("pendingTotal", snapshot.get("pendingCount"))
    # 累计计入使用消息数，不能与匿名最新建议的动作票数混用。
    received = nonnegative(snapshot["receivedMessages"]) if connected and "receivedMessages" in snapshot else None
    included = nonnegative(snapshot["validMessages"]) if connected and "validMessages" in snapshot else None
    unresolved = nonnegative(pending) if connected and pending is not None else None
    return {"mode": mode, "round": nonnegative(snapshot.get("roundId")), "connected": connected,
            "status": status_label, "expired": expired, "source": source_label, "leader": leader,
            "leaders": leaders if connected else [], "leader_votes": maximum if connected else 0,
            "items": items, "remaining": math.ceil(remaining / 1000) if connected and status == "collecting" and not expired else None,
            "pending": nonnegative(snapshot.get("pendingCount")) if connected else 0,
            "received": received, "included": included, "unresolved": unresolved,
            "counting": str(snapshot.get("countingLabel") or "有效弹幕条数"), "against": against_label, "unknown": unknown}


class WinPanelAPI:
    def __init__(self):
        if sys.platform != "win32":
            raise OSError("桌面副屏面板仅支持 Windows。")
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.user32.GetParent.argtypes = [wintypes.HWND]
        self.user32.GetParent.restype = wintypes.HWND
        self.user32.GetForegroundWindow.argtypes = []
        self.user32.GetForegroundWindow.restype = wintypes.HWND
        self.user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        self.user32.GetWindowRect.restype = wintypes.BOOL
        getter = "GetWindowLongPtrW" if ctypes.sizeof(ctypes.c_void_p) == 8 else "GetWindowLongW"
        setter = "SetWindowLongPtrW" if ctypes.sizeof(ctypes.c_void_p) == 8 else "SetWindowLongW"
        self.get_style = getattr(self.user32, getter)
        self.get_style.argtypes = [wintypes.HWND, ctypes.c_int]
        self.get_style.restype = ctypes.c_ssize_t
        self.set_style = getattr(self.user32, setter)
        self.set_style.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
        self.set_style.restype = ctypes.c_ssize_t
        self.user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        self.user32.SetWindowPos.restype = wintypes.BOOL
        self.user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        self.user32.ShowWindow.restype = wintypes.BOOL
        self.user32.IsWindowVisible.argtypes = [wintypes.HWND]
        self.user32.IsWindowVisible.restype = wintypes.BOOL

    def visible(self, hwnd):
        return bool(self.user32.IsWindowVisible(hwnd))

    def capture(self, hwnd, path):
        """仅通过本程序 HWND 的 PrintWindow 导出 BMP，没有屏幕抓取后备路径。"""
        destination = Path(path)
        if destination.suffix.lower() != ".bmp":
            raise ValueError("窗口捕获路径必须使用 BMP 扩展名。")
        rect = wintypes.RECT()
        if not self.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            raise OSError("无法取得本程序窗口尺寸。")
        width, height = rect.right - rect.left, rect.bottom - rect.top
        if not 1 <= width <= 4096 or not 1 <= height <= 4096:
            raise OSError("本程序窗口尺寸超出捕获范围。")
        gdi = ctypes.WinDLL("gdi32", use_last_error=True)
        self.user32.GetWindowDC.argtypes = [wintypes.HWND]
        self.user32.GetWindowDC.restype = wintypes.HDC
        self.user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
        self.user32.ReleaseDC.restype = ctypes.c_int
        self.user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
        self.user32.PrintWindow.restype = wintypes.BOOL
        gdi.CreateCompatibleDC.argtypes = [wintypes.HDC]
        gdi.CreateCompatibleDC.restype = wintypes.HDC
        gdi.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
        gdi.CreateCompatibleBitmap.restype = wintypes.HANDLE
        gdi.SelectObject.argtypes = [wintypes.HDC, wintypes.HANDLE]
        gdi.SelectObject.restype = wintypes.HANDLE
        gdi.GetDIBits.argtypes = [wintypes.HDC, wintypes.HANDLE, wintypes.UINT, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT]
        gdi.GetDIBits.restype = ctypes.c_int
        gdi.DeleteObject.argtypes = [wintypes.HANDLE]
        gdi.DeleteObject.restype = wintypes.BOOL
        gdi.DeleteDC.argtypes = [wintypes.HDC]
        gdi.DeleteDC.restype = wintypes.BOOL
        window_dc = self.user32.GetWindowDC(hwnd)
        memory_dc = bitmap = old_bitmap = None
        try:
            if not window_dc:
                raise OSError("无法取得本程序绘图资源。")
            memory_dc = gdi.CreateCompatibleDC(window_dc)
            bitmap = gdi.CreateCompatibleBitmap(window_dc, width, height)
            if not memory_dc or not bitmap:
                raise OSError("无法创建本程序捕获资源。")
            old_bitmap = gdi.SelectObject(memory_dc, bitmap)
            if not self.user32.PrintWindow(hwnd, memory_dc, 2):
                raise OSError("本程序窗口捕获失败。")
            gdi.SelectObject(memory_dc, old_bitmap)
            pixels = ctypes.create_string_buffer(width * height * 4)
            header = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 32, 0, len(pixels), 0, 0, 0, 0)
            info = ctypes.create_string_buffer(header + bytes(4))
            if gdi.GetDIBits(memory_dc, bitmap, 0, height, pixels, info, 0) != height:
                raise OSError("本程序窗口像素转换失败。")
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(struct.pack("<2sIHHI", b"BM", 54 + len(pixels), 0, 0, 54) + header + pixels.raw)
        finally:
            if old_bitmap and memory_dc:
                gdi.SelectObject(memory_dc, old_bitmap)
            if bitmap:
                gdi.DeleteObject(bitmap)
            if memory_dc:
                gdi.DeleteDC(memory_dc)
            if window_dc:
                self.user32.ReleaseDC(hwnd, window_dc)

    def foreground(self):
        return self.user32.GetForegroundWindow()

    def monitors(self):
        class MonitorInfo(ctypes.Structure):
            _fields_ = [("size", wintypes.DWORD), ("monitor", wintypes.RECT), ("work", wintypes.RECT), ("flags", wintypes.DWORD)]
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HANDLE, wintypes.HDC, ctypes.POINTER(wintypes.RECT), ctypes.c_ssize_t)
        self.user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MonitorInfo)]
        self.user32.GetMonitorInfoW.restype = wintypes.BOOL
        self.user32.EnumDisplayMonitors.argtypes = [wintypes.HDC, ctypes.POINTER(wintypes.RECT), callback_type, ctypes.c_ssize_t]
        self.user32.EnumDisplayMonitors.restype = wintypes.BOOL
        monitors = []
        def collect(handle, _dc, _rect, _data):
            info = MonitorInfo()
            info.size = ctypes.sizeof(info)
            if self.user32.GetMonitorInfoW(handle, ctypes.byref(info)):
                monitors.append({"left": info.work.left, "top": info.work.top, "right": info.work.right, "bottom": info.work.bottom, "primary": bool(info.flags & 1)})
            return True
        self.user32.EnumDisplayMonitors(None, None, callback_type(collect), 0)
        return monitors

    def prepare(self, child):
        hwnd = self.user32.GetParent(child) or child
        old = self.get_style(hwnd, -20)
        new = (old | 0x08000000 | 0x00000080) & ~0x00040000
        ctypes.set_last_error(0)
        previous = self.set_style(hwnd, -20, new)
        if previous == 0 and ctypes.get_last_error():
            raise OSError("无法设置不激活的窗口样式。")
        if self.get_style(hwnd, -20) & 0x08000080 != 0x08000080:
            raise OSError("无法确认不激活的窗口样式。")
        return hwnd

    def show(self, hwnd, x, y, width, height):
        if not self.user32.SetWindowPos(hwnd, -1, x, y, width, height, 0x0010 | 0x0020):
            raise OSError("无法设置副屏窗口位置。")
        self.user32.ShowWindow(hwnd, 4)  # SW_SHOWNOACTIVATE

    def move(self, hwnd, x, y):
        self.user32.SetWindowPos(hwnd, -1, x, y, 0, 0, 0x0010 | 0x0001)

    def position(self, hwnd):
        rect = wintypes.RECT()
        self.user32.GetWindowRect(hwnd, ctypes.byref(rect))
        return rect.left, rect.top


class DesktopPanel:
    def __init__(self, options):
        self.options = options
        self.native = WinPanelAPI()
        self.before_foreground = self.native.foreground()
        self.root = tk.Tk()
        self.root.withdraw()
        self.root.overrideredirect(True)
        self.root.configure(background=COLORS["background"])
        self.metrics = layout(options.width)
        self.width = self.metrics["width"]
        self.height = self.metrics["height"]
        self.statistics_fonts = {size: tkfont.Font(root=self.root, family="Microsoft YaHei UI", size=size) for size in (9, 10)}
        x, y = choose_position(self.native.monitors(), self.width, self.height)
        x = options.x if options.x is not None else x
        y = options.y if options.y is not None else y
        self.root.geometry(f"{self.width}x{self.height}{x:+d}{y:+d}")
        self.canvas = tk.Canvas(self.root, width=self.width, height=self.height, highlightthickness=0, background=COLORS["background"])
        self.canvas.pack(fill="both", expand=True)
        self.root.update_idletasks()
        self.hwnd = self.native.prepare(self.root.winfo_id())
        self.state = {}
        self.last_received = None
        self.online = False
        self.closed = False
        self.smoke_scheduled = False
        self.queue = queue.Queue(maxsize=32)
        self.stop_event = threading.Event()
        self.server_health = ServerReachability()
        self.helper_status = {"active": False, "message": "快捷键未启用。" if options.no_hotkeys else "快捷键准备中。"}
        self.helper = None
        self.drag_start = None
        self.canvas.bind("<Button-1>", self.press)
        self.canvas.bind("<B1-Motion>", self.drag)
        self.canvas.bind("<ButtonRelease-1>", lambda _event: setattr(self, "drag_start", None))
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.draw(build_view({}, online=False))
        # 直接以不激活方式显示，避免 Tk 的 deiconify 在 Windows 上主动请求焦点。
        self.native.show(self.hwnd, x, y, self.width, self.height)
        if not options.no_hotkeys:
            self.helper = HotkeyHelper(options.port, lambda status: self.push(("helper", status))).start()
        threading.Thread(target=self.poll_state, name="panel-state-http", daemon=True).start()
        self.root.after(50, self.update)
        if options.smoke_test:
            self.root.after(3000, self.close)

    def push(self, event):
        try:
            self.queue.put_nowait(event)
        except queue.Full:
            try:
                self.queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self.queue.put_nowait(event)
            except queue.Full:
                pass

    def poll_state(self):
        opener = build_opener(ProxyHandler({}), NoRedirect())
        while not self.stop_event.is_set():
            try:
                request = Request(f"http://127.0.0.1:{self.options.port}/api/state", method="GET")
                with opener.open(request, timeout=1.2) as response:
                    data = response.read(1024 * 1024 + 1)
                if len(data) > 1024 * 1024:
                    raise ValueError("状态数据过大。")
                state = json.loads(data)
                if not isinstance(state, dict):
                    raise ValueError("状态格式无效。")
                self.push(("state", (state, time.monotonic())))
            except (OSError, ValueError):
                self.push(("error", time.monotonic()))
            self.stop_event.wait(0.25)

    def update(self):
        if self.closed:
            return
        while True:
            try:
                kind, payload = self.queue.get_nowait()
            except queue.Empty:
                break
            if kind == "state":
                self.state, self.last_received = payload
                self.online = True
                self.server_health.success()
                if self.options.smoke_test and not self.smoke_scheduled:
                    self.smoke_scheduled = True
                    self.root.after(1000, self.close)
            elif kind == "error":
                self.online = False
                self.state = {}
                self.server_health.failure(payload)
            elif kind == "helper":
                self.helper_status = payload
        elapsed = (time.monotonic() - self.last_received) * 1000 if self.last_received is not None else 0
        online = self.online and elapsed < 2000
        self.draw(build_view(self.state, online=online, elapsed_ms=elapsed))
        if self.server_health.should_exit(time.monotonic()):
            self.close()
            return
        self.root.after(100, self.update)

    def text(self, x, y, text, size=12, color="text", anchor="nw", bold=False, width=None):
        return self.canvas.create_text(x, y, text=text, fill=COLORS[color], font=("Microsoft YaHei UI", size, "bold" if bold else "normal"), anchor=anchor, width=width or 0)

    def box(self, rectangle, outline="border", fill="card"):
        return self.canvas.create_rectangle(*rectangle, fill=COLORS[fill], outline=COLORS[outline], width=1)

    def draw(self, view):
        self.canvas.delete("all")
        self.text(16, 13, "梓有妙选｜Azusa HexPick", 13, bold=True)
        self.text(self.width - 19, 12, "×", 18, "muted", anchor="ne")
        title = "海克斯选择" if view["mode"] == "hex" else "出装建议"
        self.text(16, 49, f"{title} · 第 {view['round']} 轮", 10, "muted")
        source_color = "amber" if view["source"] == "回放验证" else "teal"
        self.text(self.width - 16, 49, view["source"], 10, source_color, anchor="ne")
        self.box(self.metrics["leader"], "purple" if view["connected"] else "red")
        status_text = view["status"] + (f" · 剩余 {view['remaining']} 秒" if view["remaining"] is not None else "")
        self.text(28, 87, status_text, 10, "teal" if view["connected"] else "red")
        leader_size = 22 if len(view["leader"]) <= 7 else 14 if len(view["leader"]) > 15 else 16
        self.text(28, 113, view["leader"], leader_size, "text", bold=True, width=self.width - 56)
        if view["leader_votes"]:
            self.text(self.width - 28, 158, format_votes(view["leader_votes"]) + " 票", 12, "purple", anchor="ne", bold=True)
        self.text(16, 194, "选择与刷新支持" if view["mode"] == "hex" else "当前推荐前三项", 10, "muted")
        if view["mode"] == "hex":
            for rectangle, item in zip(self.metrics["cards"], view["items"][:6]):
                lead = item["label"] in view["leaders"]
                self.box(rectangle, "purple" if lead else "border")
                left, top, right, _bottom = rectangle
                self.text((left + right) / 2, top + 6, item["label"], 10, "teal" if item["key"].endswith("d") else "text", anchor="n")
                self.text((left + right) / 2, top + 25, format_votes(item["votes"]), 17, "purple" if lead else "text", anchor="n", bold=True)
            for rectangle, item in zip(self.metrics["extra_cards"], view["items"][6:]):
                lead = item["label"] in view["leaders"]
                self.box(rectangle, "purple" if lead else "border")
                left, top, right, _bottom = rectangle
                self.text((left + right) / 2, top + 5, item["label"], 9, "teal", anchor="n")
                self.text((left + right) / 2, top + 22, format_votes(item["votes"]), 16, "purple" if lead else "text", anchor="n", bold=True)
        else:
            for index, rectangle in enumerate(self.metrics["equipment"]):
                self.box(rectangle)
                item = view["items"][index] if index < len(view["items"]) else {"label": "等待建议", "votes": 0}
                self.text(27, rectangle[1] + 8, item["label"], 12, "text", width=self.width - 104)
                self.text(self.width - 28, rectangle[1] + 7, format_votes(item["votes"]), 14, "purple", anchor="ne", bold=True)
            if view["connected"]:
                for y, item in zip(self.metrics["unknown_y"], view["unknown"]):
                    label = fit_one_line(unknown_line(item), self.width - 32, self.statistics_fonts[9].measure)
                    self.text(16, y, label, 9, "amber")
                if not view["unknown"]:
                    self.text(16, self.metrics["unknown_y"][0], "待确认：暂无重复原词", 9, "muted")
            against = fit_one_line(view["against"], self.width - 32, self.statistics_fonts[9].measure)
            self.text(16, self.metrics["against_y"], against, 9, "amber")
        self.text(16, 402, view["counting"], 10, "muted")
        self.text(self.width - 16, 402, "溣符雨 · 维护", 9, "credit", anchor="ne")
        summary = statistics_line(view)
        summary_size = statistics_font_size(summary, self.width - 32, lambda label, size: self.statistics_fonts[size].measure(label))
        self.text(16, 425, summary, summary_size, "muted")
        helper = self.helper_status.get("message", "快捷键不可用")
        helper_ok = self.helper_status.get("active") and "不可达" not in helper
        self.text(16, 452, helper, 9, "teal" if helper_ok else "amber", width=self.width - 32)
        self.text(16, 480, "Ctrl + Alt + F7：新海克斯轮", 9, "muted")
        self.text(16, 498, "F8：新出装轮　F9：锁定（均需 Ctrl + Alt）", 9, "muted")

    def press(self, event):
        if event.y > 44:
            return
        if event.x >= self.width - 40:
            self.close()
            return
        x, y = self.native.position(self.hwnd)
        self.drag_start = (event.x_root, event.y_root, x, y)

    def drag(self, event):
        if self.drag_start:
            mouse_x, mouse_y, x, y = self.drag_start
            self.native.move(self.hwnd, x + event.x_root - mouse_x, y + event.y_root - mouse_y)

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.stop_event.set()
        mapped = bool(self.canvas.winfo_ismapped())
        visible = self.native.visible(self.hwnd)
        captured = False
        if self.options.capture:
            try:
                self.native.capture(self.hwnd, self.options.capture)
                captured = True
            except (OSError, ValueError):
                captured = False
        active = bool(self.helper and self.helper.active)
        if self.helper:
            self.helper.stop()
        registered = self.helper.registered_count if self.helper else 0
        released = self.helper.released_count if self.helper else 0
        keys_released = not self.helper or self.helper.cleanup_complete.is_set() and registered == released and not self.helper.thread.is_alive()
        self.root.destroy()
        if self.options.smoke_test:
            diagnostic = {"foregroundUnchanged": self.before_foreground == self.native.foreground(), "hotkeysActive": active, "serverConnected": self.online,
                          "canvasMapped": mapped, "windowVisible": visible,
                          "registeredHotkeys": registered, "releasedHotkeys": released, "hotkeysReleased": keys_released}
            if self.options.capture:
                diagnostic["captureSucceeded"] = captured
            if sys.stdout is not None:
                print(json.dumps(diagnostic), flush=True)
            successful = diagnostic["foregroundUnchanged"] and diagnostic["serverConnected"] and mapped and visible and (captured or not self.options.capture)
            if not self.options.no_hotkeys:
                successful = successful and active and registered == 3 and released == 3 and keys_released
            self.exit_code = 0 if successful else 2

    def run(self):
        self.root.mainloop()
        return getattr(self, "exit_code", 0)


def main():
    parser = argparse.ArgumentParser(description="阿梓副屏只读建议面板")
    parser.add_argument("--port", type=int, default=5178)
    parser.add_argument("--width", type=int, default=380)
    parser.add_argument("--x", type=int)
    parser.add_argument("--y", type=int)
    parser.add_argument("--no-hotkeys", action="store_true")
    parser.add_argument("--smoke-test", action="store_true")
    parser.add_argument("--capture", metavar="PATH.bmp", help="仅捕获本程序窗口，使用 PrintWindow 输出 BMP，不捕获桌面或其他窗口")
    options = parser.parse_args()
    mutex = None
    try:
        options.port = port_number(options.port)
        mutex = ProjectMutex(options.port)
        if not mutex.acquire():
            if sys.stdout is not None:
                print(json.dumps({"alreadyRunning": True}), flush=True)
            return 0
        return DesktopPanel(options).run()
    except (OSError, ValueError, tk.TclError):
        if sys.stderr is not None:
            print("副屏面板无法启动，请检查 Windows 环境及窗口配置。", file=sys.stderr, flush=True)
        return 1
    finally:
        if mutex:
            mutex.close()


if __name__ == "__main__":
    raise SystemExit(main())
