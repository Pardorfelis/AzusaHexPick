"""副屏建议面板，后台取快照及提交操作，Tk 主线程绘图，窗口不激活。"""

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

from hotkeys import KEYS, HotkeyHelper, NoRedirect, ProjectMutex, ServerReachability, port_number, post_control

COLORS = {"background": "#11151d", "card": "#1b222e", "border": "#384455",
          "text": "#f1f4fa", "muted": "#aab5c5", "credit": "#f6b6d5",
          "purple": "#a1aaff", "brand": "#7d89fb", "selection": "#272f4d", "header": "#242e3e",
          "teal": "#8bd4bc", "amber": "#e8bb86", "red": "#f1a4ae"}

def load_themes():
    try:
        value = json.loads((Path(__file__).resolve().parent.parent / "public/themes.json").read_text(encoding="utf-8"))
        return {item["id"]: item for item in value if all(name in item["native"] for name in COLORS)}
    except (OSError, ValueError, TypeError, KeyError):
        return {}


def system_light():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as key:
            return bool(winreg.QueryValueEx(key, "AppsUseLightTheme")[0])
    except (ImportError, OSError):
        return False


def desktop_theme(value, themes, light=False):
    settings = value.get("settings", {}) if isinstance(value, dict) else {}
    settings = settings if isinstance(settings, dict) else {}
    desktop = settings.get("desktop", {})
    desktop = desktop if isinstance(desktop, dict) else {}
    requested = desktop.get("theme", "mist")
    requested = requested if isinstance(requested, str) else "mist"
    if requested == "system":
        requested = "fluent" if light else "mist"
    return themes.get(requested, themes.get("mist", {"id": "classic", "native": COLORS, "radius": 0, "material": "classic"}))

ARTWORK = {"logo": ("azusa-panel-brand.png", (56, 51, 988, 342), (104, 34)),
           "computer": ("azusa-computer.png", (48, 15, 503, 487), (74, 74)),
           "computer-small": ("azusa-computer.png", (48, 15, 503, 487), (42, 42))}


def artwork_sample(crop, bounds):
    width, height = crop[2] - crop[0], crop[3] - crop[1]
    return max(1, math.ceil(max(width / bounds[0], height / bounds[1])))


def load_artwork(root, zoom=1):
    images = {}
    assets = Path(__file__).resolve().parent.parent / "public" / "assets"
    for key, (name, crop, bounds) in ARTWORK.items():
        try:
            original = tk.PhotoImage(master=root, file=str(assets / name))
            content = tk.PhotoImage(master=root)
            content.tk.call(str(content), "copy", str(original), "-from", *crop)
            sample = artwork_sample(crop, tuple(size * zoom for size in bounds))
            images[key] = content.subsample(sample, sample)
        except (OSError, tk.TclError):
            continue
    return images

HEX_PRIMARY_KEYS = ("1", "2", "3", "1d", "2d", "3d")
HEX_EXTRA_KEYS = ("12d", "13d", "23d", "d")
HEX_KEYS = HEX_PRIMARY_KEYS + HEX_EXTRA_KEYS
HEX_LABELS = {"1": "选 1", "2": "选 2", "3": "选 3", "1d": "刷新 1", "2d": "刷新 2", "3d": "刷新 3",
              "12d": "刷新 1＋2", "13d": "刷新 1＋3", "23d": "刷新 2＋3", "d": "全部刷新"}
PANEL_HEIGHT = 560
SONG_ROW_HEIGHT = 38
DISPLAY_DEFAULTS = {"width": 480, "height": 760, "zoom": 1.25}


def display_settings(value, max_width=2560, max_height=2160):
    """尺寸与字号独立，先保证最小布局，再限制在可用屏幕内。"""
    value = value if isinstance(value, dict) else {}
    raw_zoom = value.get("zoom", DISPLAY_DEFAULTS["zoom"])
    try:
        zoom = float(raw_zoom)
        if isinstance(raw_zoom, bool) or not math.isfinite(zoom):
            raise ValueError()
    except (ValueError, TypeError, OverflowError):
        zoom = DISPLAY_DEFAULTS["zoom"]
    maximum_zoom = max(1, math.floor(min(2, max_width / 360, max_height / PANEL_HEIGHT) * 4) / 4)
    zoom = min(maximum_zoom, max(1, round(zoom * 4) / 4))
    result = {"zoom": zoom}
    for name, minimum, maximum in (("width", 360, max_width), ("height", PANEL_HEIGHT, max_height)):
        raw = value.get(name, DISPLAY_DEFAULTS[name])
        number = nonnegative(raw)
        number = number or DISPLAY_DEFAULTS[name]
        result[name] = max(math.ceil(minimum * zoom), min(maximum, number))
    return result


def read_display_settings(path):
    try:
        if path.stat().st_size > 4096:
            return dict(DISPLAY_DEFAULTS)
        return display_settings(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError):
        return dict(DISPLAY_DEFAULTS)


def write_display_settings(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(display_settings(value)), encoding="utf-8")
    temporary.replace(path)


def resize_edge(x, y, width, height):
    horizontal = "w" if x <= 7 else "e" if x >= width - 7 else ""
    vertical = "n" if y <= 7 else "s" if y >= height - 7 else ""
    if x >= width - 22 and y >= height - 22:
        return "se"
    return vertical + horizontal


def resized_rectangle(start, edge, dx, dy, minimum, maximum):
    x, y, width, height = start
    new_width = min(maximum[0], max(minimum[0], width + (dx if "e" in edge else -dx if "w" in edge else 0)))
    new_height = min(maximum[1], max(minimum[1], height + (dy if "s" in edge else -dy if "n" in edge else 0)))
    return (x + width - new_width if "w" in edge else x,
            y + height - new_height if "n" in edge else y, new_width, new_height)


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


def layout(width=380, height=PANEL_HEIGHT):
    width = max(360, min(2560, int(width)))
    height = max(PANEL_HEIGHT, min(2160, int(height)))
    margin, gap = 16, 0
    cell = (width - margin * 2 - gap * 2) / 3
    small_gap = 0
    small_cell = (width - margin * 2 - small_gap * 3) / 4
    return {
        "width": width, "height": height,
        "header": (0, 0, width, 44), "leader": (16, 76, width - 16, 182),
        "cards": [(margin + (index % 3) * (cell + gap), 214 + (index // 3) * 62,
                   margin + ((index % 3) + 1) * (width - margin * 2) / 3, 276 + (index // 3) * 62) for index in range(6)],
        "extra_cards": [(margin + index * (small_cell + small_gap), 342,
                         margin + index * (small_cell + small_gap) + small_cell, 390) for index in range(4)],
        "equipment": [(16, 214 + index * 44, width - 16, 250 + index * 44) for index in range(3)],
        "unknown_y": (344, 362), "against_y": 381,
        "song_summary": (16, 76, width - 16, 135),
        "song_list": (16, 171, width - 16, height - 150),
        "song_rows": max(1, (height - 150 - 171) // SONG_ROW_HEIGHT),
        "song_previous": (width - 76, 141, width - 47, 165),
        "song_next": (width - 45, 141, width - 16, 165),
        "footer": (16, height - 139, width - 16, height - 79),
        "zoom_out": (68, height - 76, 100, height - 44),
        "zoom_in": (160, height - 76, 192, height - 44),
        "zoom_reset": (206, height - 76, 256, height - 44),
    }


def build_view(state, online=True, elapsed_ms=0):
    state = state if isinstance(state, dict) else {}
    snapshot = state.get("snapshot", state)
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    mode = snapshot.get("mode") if snapshot.get("mode") in ("equipment", "songs") else "hex"
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
    elif mode == "equipment":
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
    if mode == "songs" and connected:
        leader = "歌曲由你挑选"
        leaders = []
        maximum = 0
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
    raw_songs = snapshot.get("songs", {})
    raw_songs = raw_songs if isinstance(raw_songs, dict) else {}
    songs = {name: nonnegative(raw_songs.get(name)) for name in
             ("totalRequests", "uniqueSongs", "hiddenSingles", "grayCount", "blackCount", "excludedRequests")}
    for name in ("items", "singles"):
        rows = raw_songs.get(name, [])
        songs[name] = []
        if mode == "songs" and connected and isinstance(rows, list):
            for item in rows:
                if not isinstance(item, dict) or not isinstance(item.get("key"), str) or not item["key"].strip() or not isinstance(item.get("title"), str) or not item["title"].strip():
                    continue
                requests = nonnegative(item.get("requests"))
                qualified = requests >= 2 if name == "items" else requests == 1
                if qualified:
                    songs[name].append({"key": item["key"], "title": item["title"].strip()[:200],
                                        "requests": requests, "known": item.get("known") is True})
    return {"mode": mode, "round": nonnegative(snapshot.get("roundId")), "connected": connected,
            "status": status_label, "expired": expired, "source": source_label, "leader": leader,
            "leaders": leaders if connected else [], "leader_votes": maximum if connected else 0,
            "items": items, "remaining": math.ceil(remaining / 1000) if connected and status == "collecting" and not expired else None,
            "pending": nonnegative(snapshot.get("pendingCount")) if connected else 0,
            "received": received, "included": included, "unresolved": unresolved,
            "counting": "每条点歌均计入" if mode == "songs" else str(snapshot.get("countingLabel") or "有效弹幕条数"),
            "against": against_label, "unknown": unknown, "songs": songs}


def song_entries(view):
    """两个区均可完整滚动，单次候选不会因排名靠后而无法查看。"""
    if not view.get("connected") or view.get("mode") != "songs":
        return []
    entries = []
    for name, label in (("items", "点歌列表 · 2 次及以上"), ("singles", "单次候选 · 明确点歌")):
        items = view["songs"][name]
        if items:
            entries.append({"kind": "heading", "label": label})
            entries.extend({"kind": "song", **item} for item in items)
    return entries


def song_page(view, offset, metrics):
    entries = song_entries(view)
    capacity = metrics["song_rows"]
    maximum = max(0, len(entries) - capacity)
    offset = min(maximum, nonnegative(offset))
    left, top, right, _bottom = metrics["song_list"]
    visible = []
    for index, item in enumerate(entries[offset:offset + capacity]):
        rectangle = (left, top + index * SONG_ROW_HEIGHT, right, top + index * SONG_ROW_HEIGHT + 36)
        visible.append({**item, "rectangle": rectangle,
                        "button": (right - 60, rectangle[1], right, rectangle[3])})
    return {"rows": visible, "offset": offset, "maxOffset": maximum, "total": len(entries)}


def song_control_at(page, view, x, y):
    if view.get("mode") != "songs" or not view.get("connected"):
        return None
    for item in page["rows"]:
        left, top, right, bottom = item["button"]
        if item["kind"] == "song" and left <= x <= right and top <= y <= bottom:
            return {"action": "song-gray-add", "key": item["key"], "roundId": view["round"]}
    return None


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

    def resize(self, hwnd, x, y, width, height):
        if not self.user32.SetWindowPos(hwnd, -1, x, y, width, height, 0x0010):
            raise OSError("无法调整副屏窗口大小。")

    def position(self, hwnd):
        rect = wintypes.RECT()
        self.user32.GetWindowRect(hwnd, ctypes.byref(rect))
        return rect.left, rect.top


class DesktopPanel:
    def __init__(self, options):
        self.options = options
        self.themes = load_themes()
        self.theme_id = "classic"
        self.theme_radius = 0
        self.material = "classic"
        self._palette = COLORS.copy()
        self.system_checked = 0
        self.system_is_light = False
        self.native = WinPanelAPI()
        self.before_foreground = self.native.foreground()
        self.root = tk.Tk()
        self.root.title("梓有妙选｜Azusa HexPick")
        self.root.withdraw()
        self.root.overrideredirect(True)
        self.root.configure(background=self.colors["background"])
        self.display_path = Path(__file__).resolve().parent.parent / ".runtime" / f"desktop-display-{options.port}.json"
        monitors = self.native.monitors()
        self.work_area = next((item for item in monitors if not item.get("primary")), monitors[0] if monitors else
                              {"left": 0, "top": 0, "right": 1920, "bottom": 1080})
        settings = dict(DISPLAY_DEFAULTS) if options.smoke_test else read_display_settings(self.display_path)
        settings.update({name: getattr(options, name) for name in ("width", "height", "zoom") if getattr(options, name) is not None})
        settings = display_settings(settings, *self.display_limits())
        self.zoom = settings["zoom"]
        self.pixel_width, self.pixel_height = settings["width"], settings["height"]
        self.metrics = layout(self.pixel_width / self.zoom, self.pixel_height / self.zoom)
        self.width, self.height = self.metrics["width"], self.metrics["height"]
        self.make_fonts()
        x, y = choose_position(monitors, self.pixel_width, self.pixel_height)
        x = options.x if options.x is not None else x
        y = options.y if options.y is not None else y
        self.root.geometry(f"{self.pixel_width}x{self.pixel_height}{x:+d}{y:+d}")
        self.canvas = tk.Canvas(self.root, width=self.pixel_width, height=self.pixel_height, highlightthickness=0, background=self.colors["background"])
        self.canvas.pack(fill="both", expand=True)
        self.artwork_images = load_artwork(self.root, self.zoom)
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
        self.resize_start = None
        self.song_scroll = 0
        self.song_view_identity = None
        self.song_pending = set()
        self.song_control_message = ""
        self.song_control_until = 0
        self.song_commands = queue.Queue(maxsize=16)
        self.canvas.bind("<Button-1>", self.press)
        self.canvas.bind("<B1-Motion>", self.drag)
        self.canvas.bind("<ButtonRelease-1>", self.release)
        self.canvas.bind("<Motion>", self.hover)
        self.canvas.bind("<Leave>", lambda _event: self.canvas.configure(cursor="arrow"))
        self.canvas.bind("<MouseWheel>", self.scroll_songs)
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.draw(build_view({}, online=False))
        # 直接以不激活方式显示，避免 Tk 的 deiconify 在 Windows 上主动请求焦点。
        self.native.show(self.hwnd, x, y, self.pixel_width, self.pixel_height)
        if not options.no_hotkeys:
            self.helper = HotkeyHelper(options.port, lambda status: self.push(("helper", status))).start()
        threading.Thread(target=self.poll_state, name="panel-state-http", daemon=True).start()
        threading.Thread(target=self.song_control_worker, name="panel-song-http", daemon=True).start()
        self.root.after(50, self.update)
        if options.smoke_test:
            self.root.after(3000, self.close)

    @property
    def colors(self):
        return getattr(self, "_palette", COLORS)

    def apply_theme(self, appearance):
        now = time.monotonic()
        if now - self.system_checked > 2:
            self.system_checked = now
            self.system_is_light = system_light()
        theme = desktop_theme(appearance, self.themes, self.system_is_light)
        if theme["id"] == self.theme_id:
            return
        self.theme_id = theme["id"]
        self._palette = theme["native"]
        self.theme_radius = min(16, max(0, theme.get("radius", 0)))
        self.material = theme.get("material", "classic")
        self.canvas.configure(background=self.colors["background"])
        try:
            dwm = ctypes.WinDLL("dwmapi")
            dwm.DwmSetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
            preference = ctypes.c_int(2 if self.material != "classic" else 1)
            dwm.DwmSetWindowAttribute(self.hwnd, 33, ctypes.byref(preference), ctypes.sizeof(preference))
        except (OSError, AttributeError):
            pass

    def display_limits(self):
        area = getattr(self, "work_area", {"left": 0, "top": 0, "right": 1920, "bottom": 1080})
        return (max(360, min(2560, area["right"] - area["left"])),
                max(PANEL_HEIGHT, min(2160, area["bottom"] - area["top"])))

    def make_fonts(self):
        zoom = getattr(self, "zoom", 1)
        self.statistics_fonts = {size: tkfont.Font(root=self.root, family="Microsoft YaHei UI", size=round(size * zoom))
                                 for size in (9, 10, 12)}

    def measure(self, label, size=10):
        return self.statistics_fonts[size].measure(label) / getattr(self, "zoom", 1)

    def apply_display(self, width, height, zoom, x=None, y=None):
        settings = display_settings({"width": width, "height": height, "zoom": zoom}, *self.display_limits())
        if settings["zoom"] != self.zoom:
            self.zoom = settings["zoom"]
            self.make_fonts()
            self.artwork_images = load_artwork(self.root, self.zoom)
        self.pixel_width, self.pixel_height = settings["width"], settings["height"]
        self.metrics = layout(self.pixel_width / self.zoom, self.pixel_height / self.zoom)
        self.width, self.height = self.metrics["width"], self.metrics["height"]
        old_x, old_y = self.native.position(self.hwnd)
        x, y = old_x if x is None else x, old_y if y is None else y
        self.root.geometry(f"{self.pixel_width}x{self.pixel_height}{x:+d}{y:+d}")
        self.native.resize(self.hwnd, x, y, self.pixel_width, self.pixel_height)
        self.draw(self.last_view)

    def set_zoom(self, zoom=None):
        x, y = self.native.position(self.hwnd)
        center = (x + self.pixel_width / 2, y + self.pixel_height / 2)
        self.work_area = next((area for area in self.native.monitors() if area["left"] <= center[0] < area["right"] and
                              area["top"] <= center[1] < area["bottom"]), self.work_area)
        desired = display_settings({"zoom": zoom}, *self.display_limits())["zoom"] if zoom is not None else DISPLAY_DEFAULTS["zoom"]
        if zoom is not None and desired == self.zoom:
            return
        ratio = desired / self.zoom
        width, height = (round(self.pixel_width * ratio), round(self.pixel_height * ratio)) if zoom is not None else (DISPLAY_DEFAULTS["width"], DISPLAY_DEFAULTS["height"])
        settings = display_settings({"width": width, "height": height, "zoom": desired}, *self.display_limits())
        area = self.work_area
        x = max(area["left"], min(x, area["right"] - settings["width"]))
        y = max(area["top"], min(y, area["bottom"] - settings["height"]))
        self.apply_display(settings["width"], settings["height"], settings["zoom"], x, y)
        self.save_display()

    def save_display(self):
        if self.options.smoke_test:
            return
        try:
            write_display_settings(self.display_path, {"width": self.pixel_width, "height": self.pixel_height, "zoom": self.zoom})
        except OSError:
            self.helper_status["message"] = "显示设置未能保存，本次调整仍有效。"

    def release(self, _event):
        changed = self.resize_start is not None
        if self.drag_start is not None:
            x, y = self.native.position(self.hwnd)
            self.work_area = next((area for area in self.native.monitors() if area["left"] <= x + self.pixel_width / 2 < area["right"] and
                                  area["top"] <= y + self.pixel_height / 2 < area["bottom"]), self.work_area)
        self.drag_start = self.resize_start = None
        if changed:
            self.save_display()

    def hover(self, event):
        edge = resize_edge(event.x, event.y, self.pixel_width, self.pixel_height)
        cursor = {"w": "size_we", "e": "size_we", "n": "size_ns", "s": "size_ns",
                  "nw": "size_nw_se", "se": "size_nw_se", "ne": "size_ne_sw", "sw": "size_ne_sw"}.get(edge, "arrow")
        self.canvas.configure(cursor=cursor)

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

    def song_control_worker(self):
        while not self.stop_event.is_set():
            try:
                action = self.song_commands.get(timeout=0.25)
            except queue.Empty:
                continue
            if self.stop_event.is_set():
                return
            try:
                post_control(action, self.options.port)
                self.push(("song-control", (action, True)))
            except (OSError, ValueError):
                self.push(("song-control", (action, False)))

    def finish_song_control(self, action, successful):
        self.song_pending.discard((action["roundId"], action["key"]))
        self.song_control_message = "已加入本场灰名单。" if successful else "略过失败，请确认轮次与连接后重试。"
        self.song_control_until = time.monotonic() + (4 if successful else 10)

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
            elif kind == "song-control":
                self.finish_song_control(*payload)
        elapsed = (time.monotonic() - self.last_received) * 1000 if self.last_received is not None else 0
        online = self.online and elapsed < 2000
        self.apply_theme(self.state.get("appearance", {}))
        self.draw(build_view(self.state, online=online, elapsed_ms=elapsed))
        if self.server_health.should_exit(time.monotonic()):
            self.close()
            return
        self.root.after(100, self.update)

    def text(self, x, y, text, size=12, color="text", anchor="nw", bold=False, width=None):
        zoom = getattr(self, "zoom", 1)
        return self.canvas.create_text(x * zoom, y * zoom, text=text, fill=self.colors[color], font=("Microsoft YaHei UI", round(size * zoom), "bold" if bold else "normal"), anchor=anchor, width=(width or 0) * zoom)

    def line(self, *coordinates, **options):
        zoom = getattr(self, "zoom", 1)
        return self.canvas.create_line(*(value * zoom for value in coordinates), **options)

    def box(self, rectangle, outline="border", fill="card"):
        zoom = getattr(self, "zoom", 1)
        material = getattr(self, "material", "classic")
        radius = getattr(self, "theme_radius", 0)
        if material == "classic" or radius == 0:
            return self.canvas.create_rectangle(*(value * zoom for value in rectangle), fill=self.colors[fill], outline=self.colors[outline], width=1)
        left, top, right, bottom = rectangle
        # 相邻票格保留原有边界与命中区，只有材质改变。
        radius = min(radius, (right - left) / 4, (bottom - top) / 4)
        if material == "paper":
            radius = min(5, radius)
        color = self.colors[fill]
        stroke = color if material in ("paper", "graphite") else self.colors[outline]
        points = (left+radius,top,right-radius,top,right,top,right,top+radius,
                  right,bottom-radius,right,bottom,right-radius,bottom,left+radius,bottom,
                  left,bottom,left,bottom-radius,left,top+radius,left,top)
        return self.canvas.create_polygon(*(value * zoom for value in points), fill=color, outline=stroke, width=1, smooth=True, splinesteps=20)

    def artwork(self, key, x, y):
        image = getattr(self, "artwork_images", {}).get(key)
        if image is None:
            return False
        zoom = getattr(self, "zoom", 1)
        self.canvas.create_image(x * zoom, y * zoom, image=image, anchor="nw")
        return True

    def draw(self, view):
        self.canvas.delete("all")
        self.last_view = view
        material = getattr(self, "material", "classic")
        if material in ("fluent", "sakura", "mint"):
            zoom = getattr(self, "zoom", 1)
            self.canvas.create_rectangle(0, 0, self.width * zoom, 39 * zoom, fill=self.colors["header"], outline="")
        self.text(16, 13, "梓有妙选｜Azusa HexPick", 13, bold=True)
        self.line(self.width - 28, 15, self.width - 16, 27, fill=self.colors["muted"], width=1.5)
        self.line(self.width - 28, 27, self.width - 16, 15, fill=self.colors["muted"], width=1.5)
        self.line(16, 39, self.width - 16, 39, fill=self.colors["border"])
        title = {"hex": "海克斯选择", "equipment": "出装建议", "songs": "弹幕点歌"}[view["mode"]]
        title_line = fit_one_line(f"{title} · 第 {view['round']} 轮", self.width - 112, self.measure)
        self.text(16, 49, title_line, 10, "text", bold=True)
        source_color = "amber" if view["source"] == "回放验证" else "teal"
        self.text(self.width - 16, 49, view["source"], 10, source_color, anchor="ne")
        if view["mode"] == "songs":
            self.draw_songs(view)
            self.draw_footer(view)
            return
        self.box(self.metrics["leader"], "border")
        status_text = view["status"] + (f" · 剩余 {view['remaining']} 秒" if view["remaining"] is not None else "")
        self.text(28, 87, status_text, 10, "teal" if view["connected"] else "red")
        has_art = self.artwork("computer", 28, 109)
        leader_x = 120 if has_art else 28
        leader_width = self.width - leader_x - 28
        leader_size = 32 if view["mode"] == "hex" and len(view["leader"]) <= 3 and view["leader_votes"] else 18 if len(view["leader"]) <= 7 else 12 if len(view["leader"]) > 15 else 14
        self.text(leader_x, 112, view["leader"], leader_size, "purple" if view["leader_votes"] else "text", bold=True, width=leader_width)
        if view["leader_votes"]:
            self.text(self.width - 28, 158, format_votes(view["leader_votes"]) + " 票", 12, "purple", anchor="ne", bold=True)
        self.text(16, 194, "选择与刷新支持" if view["mode"] == "hex" else "当前推荐前三项", 10, "muted")
        if view["mode"] == "hex":
            for rectangle, item in zip(self.metrics["cards"], view["items"][:6]):
                lead = item["label"] in view["leaders"]
                self.box(rectangle, "border", "selection" if lead else "card")
                left, top, right, _bottom = rectangle
                self.text((left + right) / 2, top + 6, item["label"], 10, "teal" if item["key"].endswith("d") else "text", anchor="n")
                self.text((left + right) / 2, top + 25, format_votes(item["votes"]), 17, "purple" if lead else "text", anchor="n", bold=True)
            for rectangle, item in zip(self.metrics["extra_cards"], view["items"][6:]):
                lead = item["label"] in view["leaders"]
                self.box(rectangle, "border", "selection" if lead else "card")
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
                    label = fit_one_line(unknown_line(item), self.width - 32, lambda text: self.measure(text, 9))
                    self.text(16, y, label, 9, "amber")
                if not view["unknown"]:
                    self.text(16, self.metrics["unknown_y"][0], "待确认：暂无重复原词", 9, "muted")
            against = fit_one_line(view["against"], self.width - 32, lambda text: self.measure(text, 9))
            self.text(16, self.metrics["against_y"], against, 9, "amber")
        self.draw_footer(view)

    def draw_songs(self, view):
        identity = (view["mode"], view["round"])
        if identity != getattr(self, "song_view_identity", None):
            self.song_scroll = 0
            self.song_view_identity = identity
        self.song_visible_page = song_page(view, getattr(self, "song_scroll", 0), self.metrics)
        self.song_scroll = self.song_visible_page["offset"]
        self.box(self.metrics["song_summary"], "border")
        has_art = self.artwork("computer-small", 28, 84)
        summary_x = 84 if has_art else 28
        status = view["status"] + (f" · 剩余 {view['remaining']} 秒" if view["remaining"] is not None else "")
        self.text(summary_x, 87, status, 10, "teal" if view["connected"] else "red")
        songs = view["songs"]
        counts = f"点歌 {format_votes(songs['totalRequests'])} 次 · 本场略过 {format_votes(songs['grayCount'])} 首 · 拉黑 {format_votes(songs['blackCount'])} 首"
        if not view["connected"]:
            counts = "连接恢复后显示本轮点歌。"
        self.text(summary_x, 112, fit_one_line(counts, self.width - summary_x - 28, lambda text: self.measure(text, 9)), 9, "muted")
        self.text(16, 140, "自主挑歌 · 点击略过仅限本场", 9, "muted")
        self.text(16, 156, "点歌列表可滚轮翻页", 9, "muted")
        for name, symbol in (("song_previous", "↑"), ("song_next", "↓")):
            left, top, right, _bottom = self.metrics[name]
            self.box(self.metrics[name])
            center = (left + right) / 2
            tip_y, tail_y = (top + 7, top + 17) if symbol == "↑" else (top + 17, top + 7)
            self.line(center, tail_y, center, tip_y, fill=self.colors["teal"], width=1.5)
            edge_y = tip_y + 4 if symbol == "↑" else tip_y - 4
            self.line(center - 4, edge_y, center, tip_y, center + 4, edge_y, fill=self.colors["teal"], width=1.5)
        rows = self.song_visible_page["rows"]
        if not rows:
            message = "等待点歌弹幕" if view["connected"] else "等待恢复统计"
            self.text(28, 208, message, 15, "muted")
            self.text(28, 243, "主列表：2 次起；明确点歌 1 次进候选区。", 9, "muted", width=self.width - 56)
        for item in rows:
            left, top, right, _bottom = item["rectangle"]
            if item["kind"] == "heading":
                self.text(left + 10, top + 7, item["label"], 9, "muted")
                continue
            self.box(item["rectangle"])
            title = ("待确认 · " if not item["known"] else "") + item["title"]
            requests = format_votes(item["requests"])
            title_width = right - 66 - (left + 10) - self.measure(requests, 12) - 14
            title = fit_one_line(title, title_width, lambda text: self.measure(text, 12))
            self.text(left + 10, top + 7, title, 12, "text" if item["known"] else "amber")
            self.text(right - 66, top + 7, requests, 12, "purple", anchor="ne")
            pending = (view["round"], item["key"]) in getattr(self, "song_pending", set())
            self.text(right - 9, top + 8, "提交中" if pending else "略过", 10, "muted" if pending else "teal", anchor="ne")

    def draw_footer(self, view):
        bottom = getattr(self, "height", self.metrics["height"])
        self.text(16, bottom - 136, view["counting"], 10, "muted")
        self.line(16, bottom - 141, self.width - 16, bottom - 141, fill=self.colors["border"])
        self.text(self.width - 16, bottom - 136, "溣符雨 · 维护", 10, "credit", anchor="ne", bold=True)
        summary = statistics_line(view)
        summary_size = statistics_font_size(summary, self.width - 32, self.measure)
        self.text(16, bottom - 113, summary, summary_size, "muted")
        helper = self.helper_status.get("message", "快捷键不可用")
        helper_ok = self.helper_status.get("active") and "不可达" not in helper
        if view["mode"] == "songs" and getattr(self, "song_control_until", 0) > time.monotonic():
            helper = self.song_control_message
            helper_ok = helper.startswith("已加入")
        helper = fit_one_line(helper, self.width - 32, lambda text: self.measure(text, 9))
        self.text(16, bottom - 91, helper, 9, "teal" if helper_ok else "amber")
        self.text(16, bottom - 69, "显示", 10, "muted")
        zoom = getattr(self, "zoom", 1)
        self.text(130, bottom - 69, f"{zoom:.0%}", 10, "text", anchor="n")
        for name, enabled in (("zoom_out", zoom > 1), ("zoom_in", display_settings({"zoom": zoom + .25}, *self.display_limits())["zoom"] > zoom), ("zoom_reset", True)):
            left, top, right, lower = self.metrics[name]
            self.box((left, top, right, lower))
            if name == "zoom_reset":
                self.text((left + right) / 2, top + 7, "默认", 10, "teal", anchor="n")
            else:
                cx, cy = (left + right) / 2, (top + lower) / 2
                color = self.colors["teal" if enabled else "muted"]
                self.line(cx - 5, cy, cx + 5, cy, fill=color, width=1.5)
                if name == "zoom_in":
                    self.line(cx, cy - 5, cx, cy + 5, fill=color, width=1.5)
        self.text(16, bottom - 38, "Ctrl＋Alt：F6 点歌　F7 海克斯", 9, "muted")
        self.text(16, bottom - 20, "F8 出装　F9 锁定", 9, "muted")
        self.artwork("logo", self.width - 120, bottom - 41)
        for offset in (5, 10, 15):
            self.line(self.width - offset - 3, bottom - 3, self.width - 3, bottom - offset - 3, fill=self.colors["muted"])

    def move_song_page(self, change):
        page = self.song_visible_page
        self.song_scroll = min(page["maxOffset"], max(0, page["offset"] + change))
        self.draw(self.last_view)

    def scroll_songs(self, event):
        y = event.y / getattr(self, "zoom", 1)
        if getattr(self, "last_view", {}).get("mode") != "songs" or not 141 <= y <= self.metrics["song_list"][3] or not event.delta:
            return
        self.move_song_page(3 if event.delta < 0 else -3)

    def press(self, event):
        zoom = getattr(self, "zoom", 1)
        edge = resize_edge(event.x, event.y, getattr(self, "pixel_width", self.width * zoom), getattr(self, "pixel_height", self.metrics["height"] * zoom))
        if edge:
            x, y = self.native.position(self.hwnd)
            self.resize_start = (edge, event.x_root, event.y_root, x, y, self.pixel_width, self.pixel_height)
            return
        px, py = event.x / zoom, event.y / zoom
        for name, amount in (("zoom_out", -.25), ("zoom_in", .25), ("zoom_reset", None)):
            left, top, right, bottom = self.metrics[name]
            if left <= px <= right and top <= py <= bottom:
                self.set_zoom(zoom + amount if amount is not None else None)
                return
        if py > 44:
            view = getattr(self, "last_view", {})
            if view.get("mode") != "songs":
                return
            for name, change in (("song_previous", -3), ("song_next", 3)):
                left, top, right, bottom = self.metrics[name]
                if left <= px <= right and top <= py <= bottom:
                    self.move_song_page(change)
                    return
            action = song_control_at(self.song_visible_page, view, px, py)
            if action and (action["roundId"], action["key"]) not in self.song_pending:
                try:
                    self.song_commands.put_nowait(action)
                    self.song_pending.add((action["roundId"], action["key"]))
                    self.song_control_message = "正在加入本场灰名单……"
                    self.song_control_until = time.monotonic() + 5
                except queue.Full:
                    self.song_control_message = "操作过快，请稍候重试。"
                    self.song_control_until = time.monotonic() + 5
            return
        if px >= self.width - 40:
            self.close()
            return
        x, y = self.native.position(self.hwnd)
        self.drag_start = (event.x_root, event.y_root, x, y)

    def drag(self, event):
        if getattr(self, "resize_start", None):
            edge, mouse_x, mouse_y, x, y, width, height = self.resize_start
            x, y, width, height = resized_rectangle((x, y, width, height), edge, event.x_root - mouse_x, event.y_root - mouse_y,
                                                   (math.ceil(360 * self.zoom), math.ceil(PANEL_HEIGHT * self.zoom)), self.display_limits())
            self.apply_display(width, height, self.zoom, x, y)
        elif self.drag_start:
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
                successful = successful and active and registered == len(KEYS) and released == len(KEYS) and keys_released
            self.exit_code = 0 if successful else 2

    def run(self):
        self.root.mainloop()
        return getattr(self, "exit_code", 0)


def main():
    parser = argparse.ArgumentParser(description="梓有妙选副屏建议面板")
    parser.add_argument("--port", type=int, default=5178)
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("--zoom", type=float, help="显示倍率，1 至 2，按 0.25 分档；受屏幕可用高度限制")
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
