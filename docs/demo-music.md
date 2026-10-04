# 演示配乐来源与制作说明

v0.7.1 的演示使用 Kevin MacLeod 提供的《Canon in D Major》录音，曲目编号为 `USUAN1100301`。作者官网的曲目页、曲目数据和音乐使用说明已于 2026 年 10 月 4 日核对；页面标注的许可为 CC BY 4.0。

- [曲目与署名信息](https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100301)。
- [作者音乐使用说明](https://incompetech.com/music/royalty-free/faq.html)。
- [作者提供的原录音](https://incompetech.com/music/royalty-free/mp3-royaltyfree/Canon%20in%20D%20Major.mp3)。
- [CC BY 4.0 许可](https://creativecommons.org/licenses/by/4.0/)。

这份许可针对上述录音。不能因为曲名也是《卡农》，就把它用于其他来源的演奏或录音。

## 视频和官网中的署名

> Canon in D Major — Kevin MacLeod（incompetech.com）。
> 许可：CC BY 4.0，https://creativecommons.org/licenses/by/4.0/。
> 节选开头 54 秒，降低音量，加入淡入与淡出；未作其他编曲修改。

视频末尾显示音乐作者、许可链接和剪辑说明，官网演示区域保留可点击的曲目及许可链接。该署名只说明音乐来源，不表示录音作者为软件背书。

## 原文件与处理参数

官网 MP3 为 11,851,012 字节，实际音频时长约 355.709 秒。SHA256 为：

```text
9377b058b8c132d87e977f6c1a7686b18c59e5f3a0ae457cd39005680363fadc
```

演示取开头 54 秒，音量系数为 0.18，开头淡入 1.2 秒，结尾淡出 2 秒。输出为 48 kHz 双声道 AAC，码率为 128 kbps；视频为 1920 × 1080、30 fps 的 H.264。制作脚本会核对原录音哈希、音视频轨道、时长及最终音量峰值。

原 MP3、官网页面存档和下载校验记录放在被忽略的 `.runtime/media/`，不进入源码仓库或软件包。视频仅包含已注明来源的节选配乐；公开交付的介绍页面保留上述署名。

## 重新制作

`scripts/make-demo.py` 从 `package.json` 读取版本。截图清单需标注相同的 `version`，并设置 `confirmed: true`，确认素材来自实际的新版本界面。准备好截图后，运行脚本的 `--manifest` 参数；`--render-only` 可以先检查静态画面，`--music` 可以指定上述已核实录音的本机位置。

脚本输出版本化 MP4、封面、SRT 及官网播放器使用的 VTT 字幕。`demo-source.json`、`demo-validation.json` 和 `keyframes/` 是本地制作与复核资料，不应直接作为使用教程展示。
