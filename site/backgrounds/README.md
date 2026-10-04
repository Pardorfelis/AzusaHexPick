# 官网背景配置

背景由维护者在本地管理，公开网页没有上传或切换入口。

将自选静态 JPG、PNG 或 WebP 放入本目录的 local 文件夹，在被忽略的 site/config.local.json 中填写 backgrounds 列表和选中的 background。file 相对于 site 目录，不能越出项目目录。保留图片作者、来源及授权记录，仅使用允许公开展示的素材。

```json
{
  "background": "my-background",
  "backgrounds": [
    { "id": "my-background", "file": "backgrounds/local/my-image.jpg", "name": "我的背景", "position": "center" },
    { "id": "none", "file": "", "name": "无背景", "position": "center" }
  ]
}
```

运行 node scripts/build-site.mjs 后，本次选中图片被复制到 dist/site。重新部署即可更换背景。未选中的本地素材、配置文件、私人路径不会被上传；config.local.json 与 local 文件夹也不进入 Git 或源码包。
