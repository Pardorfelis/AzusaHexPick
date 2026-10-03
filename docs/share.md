# 试用介绍与分享

项目发起与维护：溣符雨（B 站）。介绍入口统一使用 [项目首页](https://github.com/Pardorfelis/AzusaHexPick)，下载放在正式版本页，教程随程序一起提供。视频发布后，可把演示链接补到首页；私信只需要放这一个介绍入口。

## 演示内容

已提供 54 秒的实际界面截图字幕演示，以及封面和独立字幕。前面先给结果，再展示怎么启动，避免花很多时间解释配置。它是截图字幕演示，不是鼠标录屏；回放来源全程标明。

[演示视频](https://github.com/Pardorfelis/AzusaHexPick/releases/download/v0.7.0/AzusaHexPick-v0.7.0-demo.mp4)、[封面](https://github.com/Pardorfelis/AzusaHexPick/releases/download/v0.7.0/cover.png) 和 [字幕](https://github.com/Pardorfelis/AzusaHexPick/releases/download/v0.7.0/demo.srt) 随正式版本发布。后续在 B 站发布视频时，把视频链接补到项目首页即可。

| 顺序 | 画面 | 要让人看懂什么 |
| --- | --- | --- |
| 海克斯 | 回放弹幕与副屏的选择、刷新统计 | 弹幕太快时可以直接看哪项更多 |
| 点歌 | 主列表、单次候选及点击「略过」 | 想唱哪首自己挑，唱过的本场先不再显示 |
| 出装 | 装备昵称归并后的结果 | 绿甲、蓝盾等常见称呼可汇总到一起 |
| 开始使用 | 双击 EXE、点击开始、托盘入口 | 无需安装开发工具，日常只有一个入口 |
| 后续维护 | 反馈与更新按钮 | 遇到问题有地方反馈，新版点一下更新 |

回放画面始终标明「回放演示」，不把离线样本描述成实时直播测试。避免展示真实 API Key、配对令牌、私人路径及未脱敏的观众身份。字幕无需夸大效果，展示实际统计和操作即可。

重做演示时修改 `scripts/make-demo.py` 的 `SCENES` 文案，准备确认有效的截图清单，使用 `--manifest` 指定该 JSON 文件。清单包含 `confirmed: true` 和 `sources`，每项提供项目内 `path`，可选 `crop` 为左、上、右、下四个像素坐标；来源键为 hex、songs、equipment、launcher、panel、feedback、update。需要 Pillow、微软雅黑字体，以及脚本 `TOOLS` 指向的 FFmpeg。输出位于 `dist/delivery`，只发布 MP4、cover.png、demo.srt。

## 一条微博私信参考

> 梓神你好，我是溣符雨。做了个「梓有妙选」，想帮你看清刷得很快的弹幕：海克斯选几、刷新哪些，大家点了什么歌，还有出装昵称，都能汇总到副屏。按快捷键就能开一轮，点歌唱过的点一下略过。完整解压后双击就能用，后续更新也不用重下。有问题可以直接在软件里给我反馈，我会继续维护。这里放了演示、教程和下载，你方便时看看就好：https://github.com/Pardorfelis/AzusaHexPick

这段可以按自己的说话方式再改。演示发布前先补好介绍页，优先让她点开后很快看到效果和启动方法。账号发布和私信发送由维护者本人完成。
