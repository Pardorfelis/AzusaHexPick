"""用已确认的真实界面截图制作字幕演示与封面，不模拟鼠标录屏。"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist/delivery"
TOOLS = ROOT / ".runtime/tools/ffmpeg/ffmpeg-9.0.2-essentials_build/bin"
WIDTH, HEIGHT = 1920, 1080
COLORS = {"background": "#F3F5FC", "text": "#202840", "muted": "#586580", "brand": "#7D89FB",
          "brand_text": "#515DA7", "line": "#CAD1E5", "credit": "#A24872", "white": "#FFFFFF"}

SCENES = [
    {"id": "hex", "seconds": 8, "number": "01", "category": "海克斯选择", "title": ["选哪项，", "看一眼弹幕意见。"],
     "body": "按 Ctrl＋Alt＋F7 开始一轮统计。选 1、2、3，或刷新，都能看到支持次数。",
     "caption": "海克斯：按 Ctrl＋Alt＋F7 开始统计，数字选择与刷新建议实时显示。",
     "source": "hex", "details": ["选 1／选 2／选 3", "单项刷新／组合刷新／全部刷新"]},
    {"id": "songs", "seconds": 8, "number": "02", "category": "弹幕点歌", "title": ["想听哪些歌，", "慢慢挑就好。"],
     "body": "按 Ctrl＋Alt＋F6 收集点歌。相同歌名汇到一起，主列表之外也保留单次候选。",
     "caption": "点歌：按 Ctrl＋Alt＋F6 开始收集，查看歌名、点歌次数和单次候选。",
     "source": "songs", "details": ["重复点歌都计入次数", "歌曲由阿梓自行挑选"]},
    {"id": "skip", "seconds": 6, "number": "03", "category": "本场略过", "title": ["唱过了，", "就点一下略过。"],
     "body": "唱过或今天不想唱的歌，在副屏点「略过」。后续轮次不再显示，下一场重新开始。",
     "caption": "点歌列表中点「略过」，该歌本场不再出现；下一场的略过名单重新开始。",
     "source": "panel", "details": ["只影响本场歌回", "长期不想唱的歌可另设黑名单"]},
    {"id": "equipment", "seconds": 8, "number": "04", "category": "出装建议", "title": ["装备叫法不同，", "一起看推荐。"],
     "body": "按 Ctrl＋Alt＋F8 收集出装建议。常见别称会归并；复杂表达可选择 AI 辅助识别。",
     "caption": "出装：按 Ctrl＋Alt＋F8 收集建议，常见装备别称归并显示，可选 AI 辅助。",
     "source": "equipment", "details": ["同一装备的常见别称归并", "结果供主播参考与选择"]},
    {"id": "launcher", "seconds": 7, "number": "05", "category": "开始使用", "title": ["双击打开，", "点开始使用。"],
     "body": "首次完整解压后，双击「梓有妙选.exe」。点「开始使用」，控制台和副屏一起打开。",
     "caption": "完整解压后，双击「梓有妙选.exe」，点「开始使用」打开控制台和桌面副屏。",
     "source": "launcher", "details": ["不用另装开发工具", "设置和长期名单会保存"]},
    {"id": "shortcuts", "seconds": 6, "number": "06", "category": "游戏中也能用", "title": ["不用切出游戏，", "扭头看副屏。"],
     "body": "用快捷键开始收集或锁定结果。副屏支持拖动、调整大小和字号，摆在顺眼的位置。",
     "caption": "Ctrl＋Alt＋F6 点歌、F7 海克斯、F8 出装、F9 锁定；副屏可调整位置与字号。",
     "source": "panel", "details": ["Ctrl＋Alt＋F6：点歌", "Ctrl＋Alt＋F7：海克斯", "Ctrl＋Alt＋F8：出装", "Ctrl＋Alt＋F9：锁定"]},
    {"id": "feedback", "seconds": 6, "number": "07", "category": "问题反馈", "title": ["哪里不好用，", "在这里告诉我。"],
     "body": "在控制台展开「问题反馈」，填写并提交。溣符雨收到后继续维护。",
     "caption": "在控制台的「问题反馈」填写并提交，溣符雨可收到新增反馈提醒。",
     "source": "feedback", "details": ["不要求手机号或邮箱", "诊断信息可选择附带"]},
    {"id": "update", "seconds": 5, "number": "08", "category": "应用内更新", "title": ["有新版时，", "点一下更新。"],
     "body": "发现新版本后，点「更新并重新打开」。程序下载并替换，个人设置会保留。",
     "caption": "发现新版后，点「更新并重新打开」；无需再次手动下载解压，个人设置保留。",
     "source": "update", "details": ["由你决定何时更新", "收集期间不会应用更新"]},
]


def font(size, bold=False):
    return ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc", size)


def wrapped(draw, text, face, width):
    lines, current = [], ""
    for character in text:
        if character == "\n":
            lines.append(current)
            current = ""
        elif current and draw.textlength(current + character, font=face) > width:
            if character in "，。！？；：、）》】」』”’":
                current += character
            elif current[-1] in "（《【「『“‘":
                lines.append(current[:-1])
                current = current[-1] + character
            else:
                lines.append(current)
                current = character.lstrip()
        else:
            current += character
    if current:
        lines.append(current)
    return lines


def draw_lines(draw, lines, xy, face, color, line_height):
    x, y = xy
    for line in lines:
        draw.text((x, y), line, font=face, fill=color)
        y += line_height
    return y


def background():
    image = Image.new("RGB", (WIDTH, HEIGHT), COLORS["background"])
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, WIDTH, 8), fill=COLORS["brand"])
    draw.text((88, 46), "梓有妙选｜Azusa HexPick", font=font(31, True), fill=COLORS["text"])
    draw.text((88, 98), "v0.7.0 · 字幕演示", font=font(22), fill=COLORS["muted"])
    draw.rounded_rectangle((1624, 46, 1832, 103), radius=11, fill=COLORS["white"], outline=COLORS["line"], width=2)
    draw.text((1655, 58), "回放演示", font=font(28, True), fill=COLORS["brand_text"])
    draw.line((88, 1008, 1832, 1008), fill=COLORS["line"], width=2)
    draw.text((88, 1028), "弹幕意见供参考，最后由阿梓挑选。", font=font(21), fill=COLORS["muted"])
    credit = "溣符雨 · 维护"
    draw.text((1832 - draw.textlength(credit, font=font(25, True)), 1023), credit, font=font(25, True), fill=COLORS["credit"])
    return image


def source_image(specification):
    path = (ROOT / specification["path"]).resolve()
    if not path.is_relative_to(ROOT):
        raise ValueError("界面截图必须位于项目目录。")
    image = Image.open(path).convert("RGB")
    crop = specification.get("crop")
    if crop:
        left, top, right, bottom = crop
        if not (0 <= left < right <= image.width and 0 <= top < bottom <= image.height):
            raise ValueError("截图裁切范围超出原始图片。")
        image = image.crop(tuple(crop))
    return image


def place_screenshot(canvas, screenshot, center=(1310, 564), bounds=(1050, 814)):
    fitted = ImageOps.contain(screenshot, bounds, Image.Resampling.LANCZOS)
    x, y = round(center[0] - fitted.width / 2), round(center[1] - fitted.height / 2)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((x - 3, y - 3, x + fitted.width + 3, y + fitted.height + 3), outline=COLORS["line"], width=2)
    canvas.paste(fitted, (x, y))
    return x, y, fitted.width, fitted.height


def scene_image(scene, manifest):
    canvas = background()
    draw = ImageDraw.Draw(canvas)
    draw.text((88, 198), scene["number"], font=font(24, True), fill=COLORS["brand_text"])
    draw.line((140, 215, 178, 215), fill=COLORS["brand"], width=3)
    draw.text((198, 196), scene["category"], font=font(26, True), fill=COLORS["brand_text"])
    draw_lines(draw, scene["title"], (88, 270), font(53, True), COLORS["text"], 78)
    lines = wrapped(draw, scene["body"], font(29), 550)
    end = draw_lines(draw, lines, (88, 464), font(29), COLORS["muted"], 49)
    for index, detail in enumerate(scene["details"]):
        y = max(706, end + 38) + index * 52
        draw.line((88, y + 17, 108, y + 17), fill=COLORS["brand"], width=4)
        draw.text((125, y), detail, font=font(25, True), fill=COLORS["brand_text"])
    specification = manifest["sources"][scene["source"]]
    place_screenshot(canvas, source_image(specification))
    if scene["id"] == "update":
        draw.text((1310, 736), "确认后：下载 → 替换 → 重新打开", font=font(30, True), fill=COLORS["brand_text"], anchor="ma")
    note = "真实界面局部 · 回放演示" if specification.get("crop") else "真实界面 · 回放演示"
    draw.text((1308, 975), note, font=font(19), fill=COLORS["muted"], anchor="ma")
    return canvas


def cover_image(manifest):
    canvas = background()
    draw = ImageDraw.Draw(canvas)
    draw.text((88, 200), "海克斯 · 出装 · 点歌", font=font(55, True), fill=COLORS["text"])
    draw.text((88, 294), "把弹幕建议放到眼前。", font=font(35), fill=COLORS["muted"])
    tiles = [("hex", "海克斯选择", 92), ("songs", "弹幕点歌", 687), ("equipment", "出装建议", 1282)]
    for key, title, x in tiles:
        source = source_image(manifest["sources"][key])
        fitted = ImageOps.contain(source, (540, 531), Image.Resampling.LANCZOS)
        xx, yy = round(x + (540 - fitted.width) / 2), 425
        canvas.paste(fitted, (xx, yy))
        draw.rectangle((xx - 2, yy - 2, xx + fitted.width + 2, yy + fitted.height + 2), outline=COLORS["line"], width=2)
        draw.text((x + 270, 368), title, font=font(27, True), fill=COLORS["brand_text"], anchor="ma")
    return canvas


def timestamp(seconds):
    total = round(seconds * 1000)
    return f"{total // 3600000:02d}:{total // 60000 % 60:02d}:{total // 1000 % 60:02d},{total % 1000:03d}"


def encode(frames):
    for index, scene in enumerate(SCENES):
        duration = scene["seconds"]
        command = [str(TOOLS / "ffmpeg.exe"), "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "30",
                   "-i", str(frames / f"scene-{index:02d}.png"), "-t", str(duration),
                   "-vf", f"fade=t=in:st=0:d=0.18:color=0xF3F5FC,fade=t=out:st={duration - .18}:d=0.18:color=0xF3F5FC", "-an",
                   "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "4",
                   "-r", "30", str(frames / f"scene-{index:02d}.mp4")]
        subprocess.run(command, check=True)
        print(json.dumps({"scene": scene["id"], "seconds": duration}), flush=True)
    playlist = frames / "concat.txt"
    playlist.write_text("\n".join(f"file 'scene-{index:02d}.mp4'" for index in range(len(SCENES))), encoding="ascii")
    subprocess.run([str(TOOLS / "ffmpeg.exe"), "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
                    "-i", str(playlist), "-c", "copy", "-movflags", "+faststart",
                    str(OUTPUT / "AzusaHexPick-v0.7.0-demo.mp4")], check=True)


def verify_video():
    movie = OUTPUT / "AzusaHexPick-v0.7.0-demo.mp4"
    completed = subprocess.run([str(TOOLS / "ffprobe.exe"), "-v", "error", "-show_entries",
                                "stream=codec_name,width,height,pix_fmt,r_frame_rate", "-show_entries",
                                "format=duration,size", "-of", "json", str(movie)], capture_output=True, text=True, check=True)
    probe = json.loads(completed.stdout)
    if len(probe["streams"]) != 1:
        raise ValueError("演示应仅包含视频轨道。")
    video = probe["streams"][0]
    expected = {"codec_name": "h264", "width": WIDTH, "height": HEIGHT, "pix_fmt": "yuv420p", "r_frame_rate": "30/1"}
    if any(video.get(key) != value for key, value in expected.items()) or abs(float(probe["format"]["duration"]) - 54) > .1:
        raise ValueError("视频时长或编码参数不符合交付要求。")
    keyframes = OUTPUT / "keyframes"
    keyframes.mkdir(exist_ok=True)
    for moment, label in ((4, "hex"), (12, "songs"), (18, "skip"), (26, "equipment"), (34, "launcher"),
                         (40, "shortcuts"), (46, "feedback"), (51, "update")):
        subprocess.run([str(TOOLS / "ffmpeg.exe"), "-hide_banner", "-loglevel", "error", "-y", "-ss", str(moment),
                        "-i", str(movie), "-frames:v", "1", str(keyframes / f"{label}.png")], check=True)
    value = {"success": True, "durationSeconds": float(probe["format"]["duration"]), "video": video,
             "audioTracks": 0, "sizeBytes": movie.stat().st_size, "sha256": hashlib.sha256(movie.read_bytes()).hexdigest(),
             "type": "真实截图字幕演示，非鼠标录屏", "visualEvidence": "keyframes/"}
    (OUTPUT / "demo-validation.json").write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(value, ensure_ascii=True), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path, help="已确认有效截图的 JSON 清单，支持只裁切真实界面。")
    parser.add_argument("--render-only", action="store_true")
    options = parser.parse_args()
    manifest = json.loads(options.manifest.read_text(encoding="utf-8"))
    if not manifest.get("confirmed"):
        raise ValueError("请先确认素材为真实且有效的当前界面。")
    frames = OUTPUT / "frames"
    frames.mkdir(parents=True, exist_ok=True)
    cover_image(manifest).save(OUTPUT / "cover.png")
    captions, cursor = [], 0
    for index, scene in enumerate(SCENES):
        scene_image(scene, manifest).save(frames / f"scene-{index:02d}.png")
        captions.append(f"{index + 1}\n{timestamp(cursor)} --> {timestamp(cursor + scene['seconds'])}\n【回放演示】{scene['caption']}\n")
        cursor += scene["seconds"]
    (OUTPUT / "demo.srt").write_text("\n".join(captions), encoding="utf-8-sig")
    (OUTPUT / "demo-source.json").write_text(json.dumps({"duration": cursor, "type": "真实截图字幕演示，非鼠标录屏",
                                                          "audio": "无音乐、无音轨", "sources": manifest["sources"],
                                                          "scenes": SCENES}, ensure_ascii=False, indent=2), encoding="utf-8")
    if not options.render_only:
        encode(frames)
        verify_video()
    print(json.dumps({"durationSeconds": cursor, "output": str(OUTPUT), "renderOnly": options.render_only}), flush=True)


if __name__ == "__main__":
    main()
