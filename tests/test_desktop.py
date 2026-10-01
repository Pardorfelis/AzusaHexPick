"""桌面展示与快捷键逻辑检查，不注册真实快捷键，不注入键盘。"""

import importlib.util
import json
from pathlib import Path
import queue
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import hotkeys

specification = importlib.util.spec_from_file_location("desktop_panel", SCRIPTS / "desktop-panel.py")
desktop = importlib.util.module_from_spec(specification)
specification.loader.exec_module(desktop)


def state(mode="hex", **extra):
    snapshot = {
        "mode": mode, "connection": "connected", "status": "collecting",
        "roundId": 3, "remainingMs": 10500, "source": "live:4",
        "countingLabel": "按匿名标识去重（实验）", "pendingCount": 4,
        "hex": [{"key": key, "label": desktop.HEX_LABELS[key], "votes": 0} for key in desktop.HEX_KEYS],
        "equipment": {"top3": [], "against": []},
    }
    snapshot.update(extra)
    return {"snapshot": snapshot, "sourceKind": "live"}


def capture_draw(view, width=380, return_panel=False):
    class Font:
        def measure(self, label):
            return len(label) * 7
    class Canvas:
        def delete(self, _tag):
            pass
        def create_line(self, *_args, **_options):
            pass
    panel = desktop.DesktopPanel.__new__(desktop.DesktopPanel)
    panel.width = width
    panel.metrics = desktop.layout(width)
    panel.canvas = Canvas()
    panel.statistics_fonts = {9: Font(), 10: Font()}
    panel.helper_status = {"message": "快捷键未启用。", "active": False}
    panel.song_pending = set()
    panel.song_commands = queue.Queue(maxsize=16)
    texts, boxes = [], []
    panel.text = lambda x, y, label, size=12, color="text", **options: texts.append((x, y, label, size, options))
    panel.box = lambda rectangle, *args, **options: boxes.append(rectangle)
    panel.draw(view)
    return (texts, boxes, panel) if return_panel else (texts, boxes)


class ViewTests(unittest.TestCase):
    def test_artwork_fits_panel_bounds_without_changing_pixel_files(self):
        for _name, crop, bounds in desktop.ARTWORK.values():
            sample = desktop.artwork_sample(crop, bounds)
            self.assertGreaterEqual(sample, 1)
            self.assertLessEqual((crop[2] - crop[0] + sample - 1) // sample, bounds[0])
            self.assertLessEqual((crop[3] - crop[1] + sample - 1) // sample, bounds[1])
        self.assertEqual(desktop.artwork_sample((0, 0, 4, 4), (12, 12)), 1)

    def test_votes_are_finite_nonnegative_and_readable(self):
        for value in [None, {}, [], float("inf"), float("nan"), True, -3, "不是数字"]:
            self.assertEqual(desktop.format_votes(value), "0")
        self.assertEqual(desktop.format_votes(9999), "9999")
        self.assertEqual(desktop.format_votes(12345), "1.2 万")

    def test_hex_leader_tie_and_missing_keys(self):
        sample = state(hex=[{"key": "1", "label": "选 1", "votes": 5}, {"key": "2", "label": "选 2", "votes": 5}])
        view = desktop.build_view(sample)
        self.assertEqual(view["leader"], "并列：选 1／选 2")
        self.assertEqual(view["leader_votes"], 5)
        self.assertEqual(len(view["items"]), 10)
        self.assertEqual(view["items"][5]["votes"], 0)
        self.assertEqual(view["remaining"], 11)
        self.assertEqual(view["counting"], "按匿名标识去重（实验）")

    def test_multiple_ties_do_not_pretend_one_option_won(self):
        sample = state(hex=[{"key": key, "votes": 2} for key in desktop.HEX_KEYS])
        view = desktop.build_view(sample)
        self.assertEqual(view["leader"], "10 项并列")
        self.assertEqual(len(view["leaders"]), 10)

    def test_all_ten_actions_remain_visible_with_zero_votes(self):
        view = desktop.build_view(state(hex=[]))
        self.assertEqual(tuple(item["key"] for item in view["items"]), desktop.HEX_KEYS)
        self.assertEqual(desktop.HEX_EXTRA_KEYS, ("12d", "13d", "23d", "d"))
        self.assertTrue(all(item["votes"] == 0 for item in view["items"]))
        texts, boxes = capture_draw(view)
        self.assertEqual(len(boxes), 11)
        displayed = [item[2] for item in texts]
        for key in desktop.HEX_KEYS:
            self.assertIn(desktop.HEX_LABELS[key], displayed)

    def test_refresh_combinations_are_single_complete_actions(self):
        for key in desktop.HEX_EXTRA_KEYS:
            with self.subTest(key=key):
                view = desktop.build_view(state(hex=[{"key": key, "votes": 1}]))
                self.assertEqual(view["leader"], desktop.HEX_LABELS[key])
                self.assertEqual(view["leader_votes"], 1)
                self.assertEqual(sum(item["votes"] for item in view["items"]), 1)
                self.assertTrue(all(item["votes"] == 0 for item in view["items"] if item["key"] != key))
        tied = desktop.build_view(state(hex=[{"key": "1", "votes": 2}, {"key": "12d", "votes": 2}]))
        self.assertEqual(tied["leader"], "并列：选 1／刷新 1＋2")

    def test_equipment_support_and_against_stay_distinct(self):
        sample = state("equipment", equipment={"top3": [{"name": "中娅沙漏", "votes": 6}, {"name": "虚空之杖", "votes": 3}], "against": [{"name": "灭世者的死亡之帽", "votes": 7}]})
        view = desktop.build_view(sample)
        self.assertEqual(view["leader"], "中娅沙漏")
        self.assertEqual(view["leader_votes"], 6)
        self.assertEqual(view["pending"], 4)
        self.assertIn("反对：灭世者的死亡之帽 7", view["against"])
        self.assertEqual(len(view["items"]), 2)

    def test_unknown_equipment_is_evidence_and_never_a_leader(self):
        equipment = {"top3": [{"name": "中娅沙漏", "votes": 1}], "against": [],
                     "unknown": [{"term": "绿甲", "mentions": 30, "messageMentions": 40},
                                 {"term": "蓝盾", "mentions": 9}, {"term": "圆弧", "mentions": 6}]}
        view = desktop.build_view(state("equipment", equipment=equipment))
        self.assertEqual(view["leader"], "中娅沙漏")
        self.assertEqual(view["leader_votes"], 1)
        self.assertEqual(view["unknown"], [{"term": "绿甲", "mentions": 30}, {"term": "蓝盾", "mentions": 9}])
        self.assertEqual(len(view["items"]), 1)
        equipment["top3"] = []
        no_vote = desktop.build_view(state("equipment", equipment=equipment, validMessages=0))
        self.assertEqual(no_vote["leader"], "等待有效建议")
        self.assertEqual(no_vote["leader_votes"], 0)
        self.assertEqual(no_vote["included"], 0)
        displayed = [item[2] for item in capture_draw(no_vote)[0]]
        self.assertIn("待确认：绿甲 30", displayed)
        self.assertIn("待确认：蓝盾 9", displayed)

    def test_unknown_uses_selected_count_and_filters_bad_records(self):
        raw = [{"term": "绿甲", "messageMentions": 99, "anonymousMentions": 3, "mentions": 3},
               {"term": "蓝盾", "mentions": 2}, {"term": "", "mentions": 8}]
        view = desktop.build_view(state("equipment", equipment={"top3": [], "unknown": raw}))
        self.assertEqual(view["unknown"], [{"term": "绿甲", "mentions": 3}])
        self.assertEqual(desktop.unknown_line(view["unknown"][0]), "待确认：绿甲 3")
        self.assertEqual(desktop.build_view(state("equipment", equipment={"unknown": None}))["unknown"], [])
        self.assertEqual(desktop.build_view(state(hexDiagnostics={}, equipment={"unknown": raw}))["unknown"], [])

    def test_unknown_disconnect_hides_terms_and_locked_round_retains_evidence(self):
        equipment = {"top3": [], "unknown": [{"term": "绿甲", "mentions": 3}], "against": [{"name": "中娅沙漏", "votes": 2}]}
        sample = state("equipment", equipment=equipment)
        disconnected = [desktop.build_view(sample, online=False),
                        desktop.build_view(state("equipment", equipment=equipment, connection="disconnected", status="paused"))]
        for view in disconnected:
            self.assertEqual(view["unknown"], [])
            texts = [item[2] for item in capture_draw(view)[0]]
            self.assertFalse(any("绿甲" in text for text in texts))
            self.assertEqual(view["against"], "")
        locked = desktop.build_view(state("equipment", equipment=equipment, status="locked", lockReason="manual"))
        self.assertEqual(locked["unknown"], [{"term": "绿甲", "mentions": 3}])

    def test_unknown_and_against_stay_on_separate_bounded_lines(self):
        equipment = {"top3": [], "unknown": [{"term": "很长的待确认原始装备短语" * 4, "mentions": 8}, {"term": "蓝盾", "mentions": 4}],
                     "against": [{"name": "很长的确定反对装备名称", "votes": 20}, {"name": "另一件确定反对装备名称", "votes": 18}]}
        for width in (360, 380, 400):
            texts, _boxes = capture_draw(desktop.build_view(state("equipment", equipment=equipment)), width)
            unknown = [item for item in texts if item[2].startswith("待确认：")]
            against = [item for item in texts if item[2].startswith("反对：")]
            self.assertEqual([item[1] for item in unknown], list(desktop.layout(width)["unknown_y"]))
            self.assertEqual(len(against), 1)
            self.assertGreater(against[0][1], unknown[-1][1] + 17)
            self.assertLess(against[0][1] + 17, 402)
            self.assertTrue(all("width" not in item[4] for item in unknown + against))
            self.assertTrue(all(len(item[2]) * 7 <= width - 32 for item in unknown + against))
        self.assertEqual(desktop.fit_one_line("123456", 20, lambda label: len(label) * 5), "123…")
        self.assertEqual(desktop.fit_one_line("abc", 3, lambda label: len(label) * 5), "")

    def test_statistics_use_cumulative_messages_and_include_evicted_unresolved(self):
        sample = state(receivedMessages=35, validMessages=20, pendingTotal=5,
                       hexDiagnostics={"localVotes": 14, "aiVotes": 6, "pendingCount": 2},
                       hex=[{"key": "1", "votes": 1, "messageVotes": 20, "anonymousVotes": 1}])
        view = desktop.build_view(sample)
        self.assertEqual(view["received"], 35)
        self.assertEqual(view["included"], 20)
        self.assertEqual(view["unresolved"], 5)
        self.assertEqual(sum(item["votes"] for item in view["items"]), 1)
        self.assertEqual(desktop.statistics_line(view), "收到 35 · 计入 20 · 未决 5")

    def test_statistics_fallback_and_unknown_counts_are_explicit(self):
        view = desktop.build_view(state(hexDiagnostics={"pendingCount": 2}))
        self.assertIsNone(view["received"])
        self.assertIsNone(view["included"])
        self.assertEqual(view["unresolved"], 2)
        self.assertEqual(desktop.statistics_line(view), "收到 — · 计入 — · 未决 2")
        self.assertEqual(desktop.build_view(state())["unresolved"], 4)
        view = desktop.build_view(state(receivedMessages=-2, validMessages=float("nan"), pendingTotal=True, hexDiagnostics=[]))
        self.assertEqual(desktop.statistics_line(view), "收到 0 · 计入 0 · 未决 0")

    def test_equipment_statistics_do_not_use_hex_diagnostics(self):
        view = desktop.build_view(state("equipment", receivedMessages=16, validMessages=7,
                                        pendingCount=3, hexDiagnostics={"pendingCount": 99}))
        self.assertEqual(desktop.statistics_line(view), "收到 16 · 计入 7 · 未决 3")
        view = desktop.build_view(state("equipment", receivedMessages=16, validMessages=7, pendingTotal=8))
        self.assertEqual(view["unresolved"], 8)

    def test_disconnection_hides_statistics_and_locked_round_retains_them(self):
        sample = state(receivedMessages=21, validMessages=9, pendingTotal=3)
        offline = desktop.build_view(sample, online=False)
        paused = desktop.build_view(state(connection="disconnected", status="paused", receivedMessages=21, validMessages=9, pendingTotal=3))
        for view in (offline, paused):
            self.assertEqual(desktop.statistics_line(view), "收到 — · 计入 — · 未决 —")
        for reason, label in (("manual", "本轮已锁定"), ("timeout", "本轮已到期")):
            view = desktop.build_view(state(status="locked", lockReason=reason, receivedMessages=21, validMessages=9, pendingTotal=3))
            self.assertEqual(view["status"], label)
            self.assertEqual(desktop.statistics_line(view), "收到 21 · 计入 9 · 未决 3")

    def test_large_statistics_are_bounded_and_font_uses_measured_width(self):
        self.assertEqual(desktop.format_stat_count(None), "—")
        self.assertEqual(desktop.format_stat_count(12345), "1.2 万")
        self.assertEqual(desktop.format_stat_count(123456789), "1.2 亿")
        self.assertEqual(desktop.format_stat_count(9007199254740991), "9.0e+15")
        for value in (0, 9999, 99999999, 999999999999, 9007199254740991, 1e308):
            self.assertLessEqual(len(desktop.format_stat_count(value)), 9)
        calls = []
        def measure(label, size):
            calls.append((label, size))
            return 330 if size == 10 else 297
        summary = "收到 10000.0 万 · 计入 10000.0 万 · 未决 10000.0 万"
        self.assertEqual(desktop.statistics_font_size(summary, 360 - 32, measure), 9)
        self.assertEqual(desktop.statistics_font_size(summary, 400 - 32, measure), 10)
        self.assertTrue(all(label == summary and size == 10 for label, size in calls))

    def test_draw_keeps_statistics_on_one_footer_line(self):
        class Font:
            def measure(self, _label):
                return 340
        class Canvas:
            def delete(self, _tag):
                pass
            def create_line(self, *_args, **_options):
                pass
        panel = desktop.DesktopPanel.__new__(desktop.DesktopPanel)
        panel.width = 360
        panel.metrics = desktop.layout(360)
        panel.canvas = Canvas()
        panel.statistics_fonts = {9: Font(), 10: Font()}
        panel.helper_status = {"message": "快捷键未启用。", "active": False}
        texts = []
        panel.text = lambda x, y, label, size=12, color="text", **options: texts.append((x, y, label, size, options))
        panel.box = lambda *_args, **_options: None
        panel.draw(desktop.build_view(state(receivedMessages=100000, validMessages=80000, pendingTotal=2000)))
        statistics = [item for item in texts if item[2].startswith("收到 ")]
        self.assertEqual(len(statistics), 1)
        self.assertEqual(statistics[0][:4], (16, 425, "收到 10.0 万 · 计入 8.0 万 · 未决 2000", 9))
        self.assertNotIn("width", statistics[0][4])
        self.assertLess(statistics[0][1], 452)

    def test_server_failure_hides_stale_votes_immediately(self):
        sample = state(hex=[{"key": "1", "votes": 100}])
        view = desktop.build_view(sample, online=False)
        self.assertEqual(view["status"], "统计中断")
        self.assertEqual(view["leader_votes"], 0)
        self.assertEqual(view["leaders"], [])
        self.assertTrue(all(item["votes"] == 0 for item in view["items"]))
        equipment = desktop.build_view(state("equipment", equipment={"top3": [{"name": "中娅沙漏", "votes": 12}]}), online=False)
        self.assertEqual(equipment["items"], [])
        self.assertEqual(equipment["pending"], 0)

    def test_stream_disconnect_and_expiration_are_clear(self):
        paused = desktop.build_view(state(connection="disconnected", status="paused", hex=[{"key": "2", "votes": 5}]))
        self.assertEqual(paused["status"], "统计暂停")
        self.assertEqual(paused["leader_votes"], 0)
        expired = desktop.build_view(state(status="locked", lockReason="timeout", remainingMs=0))
        self.assertEqual(expired["status"], "本轮已到期")
        self.assertIsNone(expired["remaining"])
        local_expiry = desktop.build_view(state(remainingMs=500), elapsed_ms=600)
        self.assertEqual(local_expiry["status"], "本轮已到期")
        locked = desktop.build_view(state(status="locked", lockReason="manual"))
        self.assertEqual(locked["status"], "本轮已锁定")

    def test_replay_and_idle_are_not_presented_as_live_voting(self):
        sample = state(status="idle", roundId=0)
        sample["sourceKind"] = "replay"
        view = desktop.build_view(sample)
        self.assertEqual(view["source"], "回放验证")
        self.assertEqual(view["leader"], "等待开始新轮")
        self.assertIsNone(view["remaining"])
        self.assertEqual(desktop.build_view(None, online=False)["status"], "统计中断")

    def test_grid_fits_supported_widths_without_footer_overlap(self):
        for width in [360, 380, 400]:
            result = desktop.layout(width)
            self.assertEqual(len(result["cards"]), 6)
            self.assertEqual(len(result["extra_cards"]), 4)
            for left, top, right, bottom in result["cards"] + result["extra_cards"]:
                self.assertGreaterEqual(left, 16)
                self.assertLessEqual(right, width - 16)
                self.assertLess(top, bottom)
                self.assertLess(bottom, result["footer"][1])
            self.assertLess(max(card[3] for card in result["cards"]), result["extra_cards"][0][1])
            self.assertLess(result["equipment"][-1][3], result["unknown_y"][0])
            self.assertGreaterEqual(result["unknown_y"][1] - result["unknown_y"][0], 18)
            self.assertLess(result["unknown_y"][1] + 17, result["against_y"])
            self.assertLess(result["against_y"] + 17, 402)
            self.assertEqual(result["height"], 520)

    def test_secondary_work_area_and_primary_fallback(self):
        monitors = [{"left": 0, "top": 0, "right": 1920, "bottom": 1040, "primary": True}, {"left": -1920, "top": 0, "right": 0, "bottom": 1040, "primary": False}]
        self.assertEqual(desktop.choose_position(monitors), (-404, 24))
        self.assertEqual(desktop.choose_position(monitors[:1]), (1516, 24))
        self.assertEqual(desktop.choose_position([]), (1516, 24))

    def test_song_mode_keeps_low_counts_and_explicit_singles_separate(self):
        songs = {"items": [{"key": "a", "title": "晴天", "requests": 80, "known": True},
                            {"key": "b", "title": "听海", "requests": 2, "known": True},
                            {"key": "not-main", "title": "不进主列表", "requests": 1}],
                 "singles": [{"key": "c", "title": "今晚想听的歌", "requests": 1, "known": False},
                             {"key": "not-single", "title": "不是单次", "requests": 2}],
                 "totalRequests": 83, "uniqueSongs": 3, "grayCount": 4, "blackCount": 2,
                 "hiddenSingles": 6, "excludedRequests": 7}
        view = desktop.build_view(state("songs", songs=songs, validMessages=83, receivedMessages=100))
        self.assertEqual(view["mode"], "songs")
        self.assertEqual([item["key"] for item in view["songs"]["items"]], ["a", "b"])
        self.assertEqual([item["key"] for item in view["songs"]["singles"]], ["c"])
        self.assertEqual(view["leader"], "歌曲由你挑选")
        self.assertEqual(view["leaders"], [])
        self.assertEqual(view["leader_votes"], 0)
        self.assertEqual(view["songs"]["grayCount"], 4)
        self.assertEqual(view["counting"], "每条点歌均计入")
        texts, _boxes = capture_draw(view)
        labels = [item[2] for item in texts]
        self.assertIn("点歌列表 · 2 次及以上", labels)
        self.assertIn("单次候选 · 明确点歌", labels)
        self.assertIn("听海", labels)
        self.assertTrue(any(label.startswith("待确认 · ") for label in labels))
        self.assertFalse(any("80 票" in label or "获胜" in label for label in labels))

    def test_song_disconnect_hides_stale_choices_and_locked_round_retains_them(self):
        songs = {"items": [{"key": "a", "title": "晴天", "requests": 2, "known": True}], "singles": []}
        for view in (desktop.build_view(state("songs", songs=songs), online=False),
                     desktop.build_view(state("songs", songs=songs, connection="disconnected", status="paused"))):
            self.assertEqual(view["songs"]["items"], [])
            self.assertEqual(desktop.song_entries(view), [])
            self.assertEqual(desktop.song_page(view, 0, desktop.layout())["rows"], [])
            self.assertFalse(any("晴天" in item[2] for item in capture_draw(view)[0]))
        locked = desktop.build_view(state("songs", songs=songs, status="locked", lockReason="manual"))
        self.assertEqual(locked["songs"]["items"][0]["key"], "a")
        self.assertEqual(locked["status"], "本轮已锁定")
        self.assertEqual(desktop.build_view(state("songs", songs=[]))["songs"]["items"], [])

    def test_song_scroll_reaches_every_main_and_single_candidate_at_all_widths(self):
        songs = {"items": [{"key": f"main-{index}", "title": f"歌曲 {index}", "requests": 20 - index, "known": True} for index in range(12)],
                 "singles": [{"key": f"single-{index}", "title": f"候选 {index}", "requests": 1, "known": False} for index in range(9)]}
        view = desktop.build_view(state("songs", songs=songs))
        expected = {item["key"] for name in ("items", "singles") for item in view["songs"][name]}
        for width in (360, 380, 640):
            metrics = desktop.layout(width)
            maximum = desktop.song_page(view, 9999, metrics)["maxOffset"]
            shown = set()
            for offset in range(maximum + 1):
                page = desktop.song_page(view, offset, metrics)
                self.assertLessEqual(len(page["rows"]), desktop.SONG_VISIBLE_ROWS)
                for item in page["rows"]:
                    left, top, right, bottom = item["rectangle"]
                    self.assertGreaterEqual(left, 16)
                    self.assertLessEqual(right, width - 16)
                    self.assertLess(bottom, metrics["footer"][1])
                    if item["kind"] == "song":
                        shown.add(item["key"])
            self.assertEqual(shown, expected)
            self.assertEqual(desktop.song_page(view, -2, metrics)["offset"], 0)
        texts = capture_draw(view, 360)[0]
        self.assertTrue(any(item[2] == "梓有妙选｜Azusa HexPick" for item in texts))
        self.assertTrue(any(item[2] == "溣符雨 · 维护" for item in texts))

    def test_song_click_uses_displayed_key_and_round_and_never_the_row_index(self):
        songs = {"items": [{"key": f"main-{index}", "title": f"歌曲 {index}", "requests": 2, "known": True} for index in range(10)],
                 "singles": [{"key": "last-single", "title": "最后的单次候选", "requests": 1, "known": True}]}
        view = desktop.build_view(state("songs", songs=songs))
        _texts, _boxes, panel = capture_draw(view, return_panel=True)
        panel.move_song_page(1000)
        last = panel.song_visible_page["rows"][-1]
        left, top, right, bottom = last["button"]
        event = SimpleNamespace(x=(left + right) / 2, y=(top + bottom) / 2)
        panel.press(event)
        action = panel.song_commands.get_nowait()
        self.assertEqual(action, {"action": "song-gray-add", "key": "last-single", "roundId": 3})
        self.assertEqual(panel.song_pending, {(3, "last-single")})
        self.assertEqual(panel.last_view["songs"]["singles"][0]["key"], "last-single")
        panel.press(event)
        self.assertTrue(panel.song_commands.empty())
        self.assertIsNone(desktop.song_control_at(panel.song_visible_page, view, 20, event.y))
        disconnected = desktop.build_view(state("songs", songs=songs), online=False)
        self.assertIsNone(desktop.song_control_at(panel.song_visible_page, disconnected, event.x, event.y))
        panel.finish_song_control(action, False)
        self.assertEqual(panel.song_pending, set())
        self.assertIn("略过失败", panel.song_control_message)
        panel.finish_song_control(action, True)
        self.assertIn("已加入", panel.song_control_message)
        self.assertEqual(panel.last_view["songs"]["singles"][0]["key"], "last-single")

    def test_song_scroll_resets_on_new_round_and_button_can_page_without_wheel(self):
        songs = {"items": [{"key": f"main-{index}", "title": f"歌曲 {index}", "requests": 2} for index in range(20)]}
        view = desktop.build_view(state("songs", songs=songs))
        _texts, _boxes, panel = capture_draw(view, return_panel=True)
        left, top, right, bottom = panel.metrics["song_next"]
        panel.press(SimpleNamespace(x=(left + right) / 2, y=(top + bottom) / 2))
        self.assertEqual(panel.song_scroll, 3)
        panel.scroll_songs(SimpleNamespace(delta=-120, y=240))
        self.assertEqual(panel.song_scroll, 6)
        panel.scroll_songs(SimpleNamespace(delta=-120, y=30))
        self.assertEqual(panel.song_scroll, 6)
        next_round = desktop.build_view(state("songs", songs=songs, roundId=4))
        panel.draw(next_round)
        self.assertEqual(panel.song_scroll, 0)

    def test_song_gray_http_runs_on_worker_and_errors_reach_ui_without_local_removal(self):
        action = {"action": "song-gray-add", "key": "晴天", "roundId": 3}
        panel = desktop.DesktopPanel.__new__(desktop.DesktopPanel)
        panel.stop_event = threading.Event()
        panel.song_commands = queue.Queue()
        panel.queue = queue.Queue(maxsize=32)
        panel.options = SimpleNamespace(port=5180)
        panel.song_commands.put(action)
        calls = []
        def rejected(payload, port):
            calls.append((payload, port, threading.get_ident()))
            raise OSError("拒绝过期轮次。")
        with patch.object(desktop, "post_control", rejected):
            worker = threading.Thread(target=panel.song_control_worker)
            worker.start()
            try:
                kind, payload = panel.queue.get(timeout=1)
                self.assertEqual(kind, "song-control")
                self.assertEqual(payload, (action, False))
                self.assertEqual(calls[0][:2], (action, 5180))
                self.assertNotEqual(calls[0][2], threading.get_ident())
            finally:
                panel.stop_event.set()
                worker.join(timeout=1)
        self.assertFalse(worker.is_alive())


class FakeResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_arguments):
        return False

    def read(self, _limit):
        return b'{"ok":true}'


class FakeHotkeyAPI:
    def __init__(self, fail=0):
        self.fail = fail
        self.registered = []
        self.unregistered = []
        self.events = queue.Queue()
        self.quit_threads = []

    def prepare_queue(self):
        return 123

    def register(self, identifier, virtual_key):
        self.registered.append((identifier, virtual_key))
        return identifier != self.fail

    def unregister(self, identifier):
        self.unregistered.append(identifier)
        return True

    def next_key(self):
        return self.events.get(timeout=2.0)

    def quit(self, thread_id):
        self.quit_threads.append(thread_id)
        self.events.put(None)


class HotkeyTests(unittest.TestCase):
    def test_server_failure_grace_and_success_reset(self):
        health = hotkeys.ServerReachability()
        self.assertFalse(health.should_exit(100))
        health.failure(100)
        health.failure(104)
        self.assertFalse(health.should_exit(109.9))
        self.assertTrue(health.should_exit(110))
        health.success()
        self.assertFalse(health.should_exit(200))
        health.failure(200)
        self.assertFalse(health.should_exit(209))
        self.assertTrue(health.should_exit(210))

    def test_data_source_disconnect_does_not_mean_server_stopped(self):
        health = hotkeys.ServerReachability()
        health.failure(0)
        view = desktop.build_view(state(connection="disconnected", status="paused"))
        self.assertEqual(view["status"], "统计暂停")
        health.success()
        self.assertFalse(health.should_exit(20))

    def test_single_instance_name_is_scoped_to_project_and_port(self):
        project = SCRIPTS.parent
        first = hotkeys.mutex_name(project, 5178)
        self.assertTrue(first.startswith("Local\\AzusaSuggestionPanel-"))
        self.assertEqual(first, hotkeys.mutex_name(str(project).upper(), 5178))
        self.assertNotEqual(first, hotkeys.mutex_name(project, 5179))
        self.assertNotEqual(first, hotkeys.mutex_name(project / "another-project", 5178))
        self.assertNotIn(str(project), first)

    def test_mapping_adds_f6_and_preserves_f7_f8_f9_and_fresh_control_objects(self):
        self.assertEqual([(item[0], item[1]) for item in hotkeys.KEYS], [(1, 0x76), (2, 0x77), (3, 0x78), (4, 0x75)])
        self.assertEqual(hotkeys.control_for_key(1), {"action": "round", "mode": "hex"})
        self.assertEqual(hotkeys.control_for_key(2), {"action": "round", "mode": "equipment"})
        self.assertEqual(hotkeys.control_for_key(3), {"action": "lock"})
        self.assertEqual(hotkeys.control_for_key(4), {"action": "round", "mode": "songs", "seconds": 60, "counting": "messages"})
        copy = hotkeys.control_for_key(1)
        copy["mode"] = "changed"
        self.assertEqual(hotkeys.control_for_key(1)["mode"], "hex")
        self.assertIsNone(hotkeys.control_for_key(99))
        self.assertEqual(hotkeys.MOD_NOREPEAT, 0x4000)

    def test_post_is_local_and_has_required_header_and_json_action(self):
        calls = []
        def opener(request, timeout):
            calls.append((request, timeout))
            return FakeResponse()
        hotkeys.post_control({"action": "round", "mode": "hex"}, port=5180, opener=opener)
        request, timeout = calls[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:5180/api/control")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("X-panel-control"), "1")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(json.loads(request.data), {"action": "round", "mode": "hex"})
        self.assertEqual(timeout, 2.0)
        for invalid in [0, -1, 65536, "not-port"]:
            with self.assertRaises(ValueError):
                hotkeys.post_control({"action": "lock"}, invalid, opener=opener)
        self.assertEqual(len(calls), 1)
        action = {"action": "song-gray-add", "key": "song:晴天", "roundId": 3}
        hotkeys.post_control(action, port=5180, opener=opener)
        self.assertEqual(json.loads(calls[1][0].data), action)
        self.assertEqual(calls[1][0].get_header("X-panel-control"), "1")

    def test_redirects_are_not_followed(self):
        handler = hotkeys.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, "redirect", {}, "https://example.com"))

    def test_partial_registration_reports_inactive_and_unregisters_successes(self):
        api = FakeHotkeyAPI(fail=2)
        statuses = []
        posts = []
        helper = hotkeys.HotkeyHelper(on_status=statuses.append, api_factory=lambda: api, post=lambda *args: posts.append(args)).start()
        helper.thread.join(timeout=1.0)
        self.assertFalse(helper.active)
        self.assertFalse(statuses[0]["active"])
        self.assertIn("F8", statuses[0]["message"])
        self.assertEqual(sorted(api.unregistered), [1, 3, 4])
        self.assertEqual(helper.registered_count, 3)
        self.assertEqual(helper.released_count, 3)
        self.assertTrue(helper.cleanup_complete.is_set())
        self.assertEqual(posts, [])
        self.assertIsNone(helper.heartbeat_thread)

    def test_song_hotkey_conflict_releases_all_legacy_registrations(self):
        api = FakeHotkeyAPI(fail=4)
        statuses = []
        helper = hotkeys.HotkeyHelper(on_status=statuses.append, api_factory=lambda: api, post=lambda *_args: None).start()
        helper.thread.join(timeout=1)
        self.assertFalse(helper.active)
        self.assertIn("F6", statuses[0]["message"])
        self.assertEqual(sorted(api.unregistered), [1, 2, 3])
        self.assertEqual(helper.registered_count, 3)
        self.assertEqual(helper.released_count, 3)
        self.assertTrue(helper.cleanup_complete.is_set())

    def test_registered_keys_send_heartbeat_and_actions_then_unregister_on_stop(self):
        api = FakeHotkeyAPI()
        posts = []
        received = threading.Event()
        def post(action, port):
            posts.append((action, port))
            received.set()
        helper = hotkeys.HotkeyHelper(port=5180, on_status=lambda _status: None, api_factory=lambda: api, post=post).start()
        try:
            self.assertTrue(helper.active)
            self.assertTrue(received.wait(0.5))
            heartbeat = posts[0][0]
            self.assertEqual(heartbeat["action"], "helper-heartbeat")
            self.assertTrue(heartbeat["active"])
            self.assertEqual(heartbeat["registered"], 4)
            self.assertEqual(heartbeat["status"], "keys-registered")
            received.clear()
            api.events.put(3)
            self.assertTrue(received.wait(0.5))
            self.assertTrue(any(action == {"action": "lock"} for action, _port in posts))
            received.clear()
            api.events.put(4)
            self.assertTrue(received.wait(0.5))
            self.assertTrue(any(action == {"action": "round", "mode": "songs", "seconds": 60, "counting": "messages"} for action, _port in posts))
        finally:
            helper.stop()
        self.assertFalse(helper.active)
        self.assertEqual(api.quit_threads, [123])
        self.assertEqual(sorted(api.unregistered), [1, 2, 3, 4])
        self.assertEqual(helper.registered_count, 4)
        self.assertEqual(helper.released_count, 4)
        self.assertTrue(helper.cleanup_complete.is_set())
        before = len(posts)
        helper.enqueue({"action": "round", "mode": "hex"})
        time.sleep(0.05)
        self.assertEqual(len(posts), before)


if __name__ == "__main__":
    unittest.main()
