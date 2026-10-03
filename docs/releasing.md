# 版本发布约定

项目名为梓有妙选，英文名为 Azusa HexPick，仓库为 [Pardorfelis/AzusaHexPick](https://github.com/Pardorfelis/AzusaHexPick)。Git 历史从 v0.3.0 开始。v0.7.0 正常整合到 main，保留历史分支、提交和版本标签，不强制推送，不改已有发布标签。

## 两种包

**Windows 交付包** 面向 Windows 10／11 的 x64 用户。使用自包含 WPF 启动器，自带 Node 和桌面副屏运行环境，经 Velopack 打包后支持解压使用和应用内更新。

**源码包** 供开发及复核使用，通过 scripts/package.py 构建。它包含源码、文档、脱敏回放和测试，不自带完整运行环境，不能代替 Windows 交付包。GitHub 自动生成的 Source code 同样不是用户日常启动包。

## 构建前

1. 更新 package.json、launcher/AzusaHexPick.Launcher.csproj 的版本号，同步 CHANGELOG、使用、架构、教程与验证记录。
2. 查看 git status、git diff 和远端更新，确认已有用户修改以及本次提交范围。
3. 确认真实密钥、个人配置、导入背景、原始 XML／ASS、日志、本机截图和助手文件不在发布范围。
4. 运行 scripts/check.ps1；构建源码包并运行 scripts/verify-package.py，检查独立解压目录。
5. 准备 .NET 10 SDK、Python 打包环境、PyInstaller、Node 和 Velopack CLI。项目内默认工具路径位于被忽略的 .runtime/tools，也可通过构建脚本参数指定已有工具。
6. 构建前退出本项目服务和桌面窗，避免占用 dist/windows-stage。不要删除用户数据目录。

## 构建 Windows 应用

在项目目录运行：

```powershell
./scripts/build-windows.ps1
```

脚本先发布 win-x64 自包含启动器，再打包 Tkinter 副屏、复制 Node 及白名单应用文件，生成包内 SHA-256 清单，最后调用 Velopack。正式产物位于 dist/releases。仅本地查看启动器时可以加 -SkipPack，此时得到的是预览目录，不是可交付的自更新包。

发布目录必须保留 Velopack 生成的结构。首次交付优先提供便携 ZIP，让使用者完整解压后双击「梓有妙选.exe」；不要只发送一个 EXE，也不要将更新器所需文件拆散。

## 更新包与渠道

正式客户端读取本仓库稳定 Release，不保存 GitHub 访问令牌。草稿和预发布不进入正式更新通道。测试构建使用专用编译条件和独立本地或 HTTP 测试源，不上传到正式版本。

每次正式发布需要上传以下内容：

- Windows 便携包和完整更新 nupkg。
- Velopack 生成的 win 渠道版本清单及其他必需更新元数据。
- 有上一版基础包时生成的差量 nupkg；没有可用差量时客户端使用完整包。
- 对应 SHA-256 校验文件、版本说明及约定提供的源码包。

后续构建差量前，应取得上一正式版完整包及渠道元数据，放入相同构建渠道，再生成新版本。不要手工篡改清单的包大小或哈希。发布后从远端重新下载清单和包，核对版本、大小与校验；单纯推送 main 或标签不会触发客户端更新。

## 交付检查

使用与开发工作区独立的解压目录和用户数据目录进行验证。确认双击启动、重复启动唤回、控制台和副屏、托盘、全局快捷键、退出全部，以及教程和反馈都可用。验证目录使用合成 Key，不消耗真实额度。

应用内更新检查需要覆盖正常升级和跨版本，并检查收集期间阻止、下载取消或中断、损坏包、文件占用、磁盘空间不足及迁移失败。每项记录实际做法和结果，模拟检查与真实系统故障分开描述。

个人数据默认位于 `%LocalAppData%\AzusaHexPick\UserData`。更新前备份，更新后比对密钥、启动器偏好、AI 偏好、外观及长期黑名单，确认密钥仍可在当前用户下解密。不能只凭新窗口出现就认定升级完整成功。

反馈验收使用公开问卷 [腾讯问卷](https://wj.qq.com/s2/28082013/eqvo/)：实际提交测试反馈后，由维护者确认微信提醒。诊断遵循白名单，不发送真实 Key、完整弹幕、观众身份或私人路径。交付视频及私信由维护者本人发布和发送。

## 提交和正式发布

检查及文档完成后，正常整合远端更新，提交 main，建立与应用版本一致的附注标签，再推送分支和标签。发布标签创建后保持不变；之后的修复另建新版本。

```powershell
git status
git diff --stat
git fetch origin
git add README.md CHANGELOG.md docs public launcher src scripts tests server.mjs package.json delivery.json .gitignore
git commit -m "Release v0.7.0"
git tag -a v0.7.0 -m "梓有妙选 v0.7.0"
git push origin main
git push origin refs/tags/v0.7.0
git ls-remote origin refs/heads/main refs/tags/v0.7.0 'refs/tags/v0.7.0^{}'
```

上述提交范围是示例，实际发布前仍需逐项核对。随后创建 v0.7.0 正式 GitHub Release，使用 docs/release-v0.7.0.md 作为说明，上传构建产物。确认远端 main 与标签对应提交，并核对公开下载和更新清单后，才报告发布完成。登录或网络失败时保留本地提交，说明尚未同步的部分。

## 公开范围与素材

源码、脚本、文档、标准名目录及必要脱敏回归资料进入仓库。validation 使用显式白名单，新公开结果需要同步 .gitignore。真实环境配置、.runtime、dist、bin、obj、Python 缓存、原始回放和本地助手文件留在本机。

内置背景、启动器及网页素材、字体和必要许可随程序分发，个人导入图片不分发。应用不显示默认背景作者姓名，公开 README 的作者、版权及授权说明由维护者补充。

## 历史设计分支

v0.5.0 和 v0.5.1 曾在 design/v0.5.0 分支发布，v0.6.0 曾在 design/v0.6.0 发布，保留相应标签和包。v0.7.0 将主力交付版本归入 main，历史版本用于对比与回退，不改写当时验证报告，也不补造 v0.1 和 v0.2 的提交。
