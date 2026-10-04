# 版本发布约定

项目名为梓有妙选，英文名为 Azusa HexPick，仓库为 [Pardorfelis/AzusaHexPick](https://github.com/Pardorfelis/AzusaHexPick)。Git 历史从 v0.3.0 开始。主力版本发布到 main，保留历史分支、提交和版本标签，不强制推送，不改已有发布标签。

本节记录 2026 年 10 月 5 日的发布前最终检查，正式发布状态以 [GitHub 发布页](https://github.com/Pardorfelis/AzusaHexPick/releases) 为准。[官网](https://azusa510.top/) 已上传至香港 COS，DNS、严格 HTTPS、两种公开下载的大小与 SHA-256、远端安装向导原生安装，以及真实 COS 完整／差量更新均已核验。HTTP 实际返回 301，跳转到同域 HTTPS，交付入口使用 HTTPS。已核验的 v0.7.1 安装向导、便携包及完整／差量更新包位于 `dist/releases`，旧版产物保存在 `dist/archive/v0.7.0`。`dist/site` 清单为 `formal: true`；独立预览目录中的产物不进入正式渠道。

## 用户交付与源码包

**Windows 交付包** 面向 Windows 10／11 的 x64 用户。使用自包含 WPF 启动器，自带 Node 和桌面副屏运行环境，经 Velopack 打包后支持应用内更新。官网提供两个选择：推荐的安装向导「AzusaHexPick-0.7.1-Setup.exe」，以及完整解压使用的便携 ZIP。安装向导提供安装位置和桌面快捷方式设置；内部 Velopack Setup、更新 NUPKG 和 feed 不作为用户手动安装入口。

**源码包** 供开发及复核使用，通过 scripts/package.py 构建。它包含源码、文档、脱敏回放和测试，不自带完整运行环境，不能代替 Windows 交付包。GitHub 自动生成的 Source code 同样不是用户日常启动包。

## 构建前

1. 更新 package.json、launcher/AzusaHexPick.Launcher.csproj 的版本号，同步 CHANGELOG、使用、架构、教程与验证记录。
2. 查看 git status、git diff 和远端更新，确认已有用户修改以及本次提交范围。
3. 确认真实密钥、个人配置、导入背景、原始 XML／ASS、日志、本机截图和助手文件不在发布范围。
4. 运行 scripts/check.ps1；构建源码包并运行 scripts/verify-package.py，检查独立解压目录。
5. 准备 .NET 10 SDK、Python 打包环境、PyInstaller、Node 和 Velopack CLI。项目内默认工具路径位于被忽略的 .runtime/tools，也可通过构建脚本参数指定已有工具。
6. 构建前退出本项目服务和桌面窗，避免占用 dist/windows-stage。不要删除用户数据目录。
7. 正式构建前，确定已经完成解析及 HTTPS 的实际官网地址。`site/config.local.json` 中的 `baseUrl`、`delivery.json` 中的 `introductionUrl` 必须指向同一官网，`updateBaseUrl` 必须为该官网下的 `updates/`。正式客户端携带这份配置，不能等打完包后只改官网地址。

## 本地预览

域名和正式更新源未就绪时，可以继续检查界面和安装流程，但必须使用独立预览目录：

```powershell
./scripts/build-windows.ps1 -AllowUnconfiguredSite -ReleaseDirectory .runtime/v071-preview-releases
node scripts/build-site.mjs --with-downloads --preview-releases .runtime/v071-preview-releases
```

这些命令不部署官网。预览安装向导的证据清单会标记 `preview: true`，官网构建的 `site-manifest.json` 标记 `formal: false`。预览可以验证布局、快捷方式和本地流程，不能证明正式 HTTPS 下载或客户端更新已通过。仅查看编译后的启动器可使用 `-SkipPack`，其输出 `dist/windows-stage` 同样不是交付包。

## 构建 Windows 应用

在项目目录运行：

```powershell
./scripts/build-windows.ps1
```

以上正式命令仅在域名及交付配置就绪后运行，不使用 `-AllowUnconfiguredSite`。脚本先发布 win-x64 自包含启动器，再打包 Tkinter 副屏、复制 Node 及白名单应用文件，生成包内 SHA-256 清单，最后调用 Velopack 和安装向导构建。当前 v0.7.1 正式格式产物已位于 `dist/releases`，完成安装载荷、便携包内容及独立解压启动检查；版本依据证据清单与包内清单核对，不依据同名便携 ZIP 的文件名判断。

安装向导的 `AzusaHexPick-0.7.1-Setup.exe.manifest.json` 绑定安装向导哈希、内部 Setup 载荷、同一次构建的完整 NUPKG、版本及 `delivery.json`。便携包则核对内部 `package-manifest.json`、每个应用文件的哈希和包内官网／更新地址。不能把旧内部 Setup、新网页或另一份完整包拼成正式安装向导。

发布目录必须保留 Velopack 生成的结构。首次交付优先提供安装向导；使用便携版时完整解压后从根目录打开「梓有妙选.exe」。不要只发送一个 EXE，也不要将更新器所需文件拆散。

## 更新包与渠道

v0.7.1 正式客户端优先读取同站 COS HTTPS 更新源，GitHub 正式 Release 保留为备用，不保存 GitHub 访问令牌。v0.7.0 原客户端仍需通过 GitHub 获得这次过渡版本。草稿、预发布和本地测试版本不进入正式更新通道；测试构建使用独立本地或 HTTP 测试源。

本次 COS 实测分别完成正式 v0.7.0 基础包到 v0.7.1 的完整下载与差量更新，使用原样 v0.7.1 校验程序集及 v0.7.0 原版更新器。差量只下载 2,240,631 字节差量包，没有回退完整包；两项均重新打开并保留六份个人设置和可解密的合成密钥。该检查不表示 v0.7.0 原生界面能够直连 COS。正式 v0.7.1 客户端另已实际读取 COS，显示当前版本，无 GitHub 回退。

每次正式发布需要上传以下内容：

- 安装向导 `AzusaHexPick-0.7.1-Setup.exe`、安装向导证据清单，以及便携包 `AzusaHexPickApp-win-Portable.zip`。
- 当前版本的完整更新包 `AzusaHexPickApp-0.7.1-full.nupkg`。
- 基于已发布 v0.7.0 完整基础包生成的 v0.7.1 差量 NUPKG。本次已生成差量，并使用正式 v0.7.0 更新器实际重建 v0.7.1，1,673 个文件逐一核对一致；客户端无法使用差量时仍可下载完整包。
- Velopack 生成的 win 渠道 `releases.win.json`，以及其中引用的全部完整／差量包。
- 对应 SHA-256 校验文件、版本说明、演示与字幕、配乐许可及约定提供的源码包。

后续构建差量前，应取得上一正式版完整包及渠道元数据，放入相同构建渠道，再生成新版本。不要手工篡改清单的包大小或哈希。发布后从远端重新下载清单和包，核对版本、大小与校验；单纯推送 main 或标签不会触发客户端更新。

## 官网正式构建与部署

完成同一版本的正式安装向导、便携版、完整／差量包及视频后，运行：

```powershell
node scripts/build-site.mjs --release
python scripts/deploy-cos.py
```

正式官网构建只读取 `dist/releases`，拒绝 `--preview-releases`。它检查官网与客户端的实际 HTTPS 地址一致，安装向导证据清单没有预览标记，便携包版本、内容哈希和包内发布地址正确，更新 feed 引用的包全部齐全。安装版、便携版或演示未就绪时不能生成可发布官网。

构建后的 `dist/site/site-manifest.json` 记录正式标记、版本、域名、白名单文件、大小和 SHA-256。部署脚本默认只做本地预检；按 [香港 COS 部署说明](hosting-cos.md) 配置账号及凭据后，显式加 `--publish` 才上传。不能手工修改清单后绕过校验。

上传顺序为软件包及静态资源在先，实际回读核对大小和哈希后提交更新 feed，最后提交 `release.json` 和首页。同名软件包不覆盖，旧版本不能覆盖远端较新 feed；不批量删除对象。域名实名、解析、HTTPS 和远端下载仍需实际验收，不能只凭本地构建成功就报告上线。

## 交付检查

使用与开发工作区独立的解压目录和用户数据目录进行验证。确认双击启动、重复启动唤回、控制台和副屏、托盘、全局快捷键、退出全部，以及教程和反馈都可用。验证目录使用合成 Key，不消耗真实额度。

应用内更新检查需要覆盖正常升级和跨版本，并检查收集期间阻止、下载取消或中断、损坏包、文件占用、磁盘空间不足及迁移失败。每项记录实际做法和结果，模拟检查与真实系统故障分开描述。

个人数据默认位于 `%LocalAppData%\AzusaHexPick\UserData`。更新前备份，更新后比对密钥、启动器偏好、AI 偏好、外观及长期黑名单，确认密钥仍可在当前用户下解密。不能只凭新窗口出现就认定升级完整成功。

反馈验收使用公开问卷 [腾讯问卷](https://wj.qq.com/s2/28082013/eqvo/)：实际提交测试反馈后，由我确认微信提醒。诊断遵循白名单，不发送真实 Key、完整弹幕、观众身份或私人路径。交付视频及私信由我本人发布和发送。

## 提交和正式发布

正式 HTTPS 官网可用，安装版与便携版完成实际下载及安装验收，COS 更新源的完整／差量升级通过，文档记录真实结果后，才将源码正常整合并推送到 main、建立新标签及 GitHub Release。本次远端资源、下载哈希、最终原生安装、COS 更新及 HTTP 到 HTTPS 的 301 跳转已通过，记录是 GitHub 发布前的验收快照；官网及客户端均使用已验证的 HTTPS 地址。发布标签创建后保持不变；之后的修复另建新版本。

```powershell
git status
git diff --stat
git fetch origin
git diff --cached --stat
git commit -m "Release v0.7.1"
git tag -a v0.7.1 -m "梓有妙选 v0.7.1"
git push origin main
git push origin refs/tags/v0.7.1
git ls-remote origin refs/heads/main refs/tags/v0.7.1 'refs/tags/v0.7.1^{}'
```

命令仅用于验收通过后的正式发布，不是现在就执行。执行前先逐项核对并暂存本次公开文件；不要使用宽泛暂存把本地截图、私人配置或助手记录混入提交。随后创建 v0.7.1 正式 GitHub Release，使用 `docs/release-v0.7.1.md` 作为说明，上传已经与 COS 核对一致的构建产物。确认远端 main 与标签对应提交，并核对公开下载和更新清单后，才报告发布完成。登录或网络失败时保留本地提交，说明尚未同步的部分。

## 公开范围与素材

源码、脚本、文档、标准名目录及必要脱敏回归资料进入仓库。validation 使用显式白名单，新公开结果需要同步 .gitignore。真实环境配置、.runtime、dist、bin、obj、Python 缓存、原始回放和本地助手文件留在本机。

内置背景、启动器及网页素材、字体和必要许可随程序分发，个人导入图片不分发。应用不显示默认背景作者姓名，公开 README 的作者、版权及授权说明由维护者补充。

## 历史设计分支

v0.5.0 和 v0.5.1 曾在 design/v0.5.0 分支发布，v0.6.0 曾在 design/v0.6.0 发布，保留相应标签和包。v0.7.0 将主力交付版本归入 main，历史版本用于对比与回退，不改写当时验证报告，也不补造 v0.1 和 v0.2 的提交。
