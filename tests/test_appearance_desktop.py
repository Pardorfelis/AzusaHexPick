"""共享主题与桌面材质检查，不注册快捷键或注入输入。"""
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("appearance_desktop", ROOT / "scripts/desktop-panel.py")
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


class AppearanceDesktopTests(unittest.TestCase):
    def test_shared_theme_library_has_complete_native_tokens(self):
        themes = desktop.load_themes()
        self.assertEqual(set(themes), {"mist", "fluent", "paper", "sakura", "mint", "graphite", "classic"})
        for theme in themes.values():
            self.assertEqual(set(theme["native"]), set(desktop.COLORS))
            self.assertTrue(all(len(color) == 7 and color.startswith("#") for color in theme["native"].values()))

    def test_system_style_and_malformed_snapshot_fallback(self):
        themes = desktop.load_themes()
        state = {"settings": {"desktop": {"theme": "system"}}}
        self.assertEqual(desktop.desktop_theme(state, themes, True)["id"], "fluent")
        self.assertEqual(desktop.desktop_theme(state, themes, False)["id"], "mist")
        for bad in (None, [], {"settings": None}, {"settings": {"desktop": []}}, {"settings": {"desktop": {"theme": []}}}):
            self.assertEqual(desktop.desktop_theme(bad, themes)["id"], "mist")

    def test_material_shapes_preserve_original_rectangle_bounds_and_zoom(self):
        class Canvas:
            def create_polygon(self, *points, **options):
                self.points, self.options = points, options
                return 1
        panel = desktop.DesktopPanel.__new__(desktop.DesktopPanel)
        panel.canvas = Canvas()
        panel._palette = desktop.load_themes()["fluent"]["native"]
        panel.theme_radius = 12
        panel.material = "fluent"
        rectangle = (16, 214, 126, 276)
        for zoom in (1, 1.25, 1.5, 1.75, 2):
            panel.zoom = zoom
            panel.box(rectangle)
            xs, ys = panel.canvas.points[0::2], panel.canvas.points[1::2]
            self.assertEqual((min(xs), min(ys), max(xs), max(ys)), tuple(value * zoom for value in rectangle))
            self.assertEqual(panel.canvas.options["fill"], panel._palette["card"])
        panel.material = "paper"
        panel.box(rectangle)
        self.assertEqual(panel.canvas.options["outline"], panel._palette["card"])

    def test_theme_changes_do_not_change_song_hit_rectangles(self):
        themes = desktop.load_themes()
        metrics = desktop.layout(400, 780)
        for theme in themes:
            desktop.desktop_theme({"settings": {"desktop": {"theme": theme}}}, themes)
            self.assertEqual(desktop.layout(400, 780), metrics)


if __name__ == "__main__":
    unittest.main()
