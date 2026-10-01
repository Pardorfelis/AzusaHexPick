# 版本发布约定

项目中文名为梓有妙选，英文名为 Azusa HexPick，仓库为 [Pardorfelis/AzusaHexPick](https://github.com/Pardorfelis/AzusaHexPick)。本地历史及 GitHub 历史从 v0.3.0 开始，日常主分支为 main。

较大版本更新应同时维护版本号、文档与 CHANGELOG.md。应用检查及便携包复核通过后，同步提交到 GitHub 并建立对应版本标签。

## 发布顺序

1. 更新 package.json 的版本号和 CHANGELOG.md，对齐使用、架构及验证文档。
2. 查看 git status 和 git diff，复核新增、修改和删除文件。
3. 运行 scripts/check.ps1；构建便携包，再运行 scripts/verify-package.py，核查解压目录的完整套件。
4. 检查当前 main 分支、origin 地址和远端更新。远端有新提交时，先正常整合并再次验证，禁止用强制推送覆盖。
5. 提交当前版本，建立与 package.json 对应的附注标签，再推送 main 和该标签。发布标签创建后保持不变，修复通过新提交及新版本发布。
6. 从远端读取分支和标签，确认与本地提交一致，再报告同步成功。

下面以首个版本为例，后续应替换为实际版本号。Git 作者身份和登录使用本机已有配置，令牌不写入文件或命令行。

```powershell
git status
git diff --stat
git add -A
git commit -m "Release v0.3.0"
git tag -a v0.3.0 -m "梓有妙选 v0.3.0"
git push -u origin main
git push origin refs/tags/v0.3.0
git ls-remote origin refs/heads/main refs/tags/v0.3.0 'refs/tags/v0.3.0^{}'
```

## 提交范围

源码、脚本、文档、标准名资料及必要的脱敏回归资料进入仓库。validation 使用显式白名单；新增可公开报告需同时更新 .gitignore，保持必要测试资料可用。

.env.local、其他真实环境配置、.runtime、dist、Python 缓存、原始 XML／ASS、本机截图和本地工作记录忽略。便携包在本地构建，GitHub 标签提供可复核的源码快照。

## 历史记录

此前的验证报告记录当时的名称、文件清单与测试结果，不因更名改写。当前展示名和新包名前缀统一为梓有妙选及 azusa-hexpick。重建 v0.3.0 时，旧包报告先保留为更名前的历史文件，新结果单独记录。
