# 官网背景配置

背景由维护者在本地管理，公开网页没有上传或切换入口。

当前官网默认背景是维护者提供的 AI 生成图片「月夜荷塘」，文件为 `azusa-moonlit-lotus.png`。保存原图，显示时沿用网站遮罩和轻微鼠标视差。控制台背景独立设置。

完整操作步骤见 [自行更换官网背景教程](../../docs/changing-website-background.md)。

将自选静态 JPG、PNG 或 WebP 放入本目录的 `local` 文件夹，在被忽略的 `site/config.local.json` 中填写 `backgrounds` 列表和选中的 `background`。`file` 相对于 `site` 目录，不能越出项目目录。保留图片作者、来源及授权记录，仅使用允许公开展示的素材。

```json
{
  "background": "my-background",
  "backgrounds": [
    { "id": "my-background", "file": "backgrounds/local/my-image.jpg", "name": "我的背景", "position": "center" },
    { "id": "none", "file": "", "name": "无背景", "position": "center" }
  ]
}
```

运行 `node scripts/build-site.mjs --release` 生成正式网站，本次选中图片被复制到 `dist/site`。确认预览后，运行 `scripts/publish-site.ps1 -Publish` 重新部署。未选中的本地素材、配置文件、私人路径不会被上传；`config.local.json` 与 `local` 文件夹也不进入 Git 或源码包。
