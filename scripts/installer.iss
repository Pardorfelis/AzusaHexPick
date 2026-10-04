; 外层只提供目录与快捷方式选择，应用安装、更新和卸载由 Velopack 管理。
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef Payload
  #error Payload is required
#endif
#ifndef OutputDirectory
  #error OutputDirectory is required
#endif
#ifndef WizardArtwork
  #error WizardArtwork is required
#endif
#define AppName "梓有妙选"
#define PackageId "AzusaHexPickApp"
#define MainExe "梓有妙选.exe"

[Setup]
AppId=AzusaHexPickInstallWizard
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=溣符雨
DefaultDirName={localappdata}\Programs\AzusaHexPick
DisableProgramGroupPage=yes
DisableDirPage=no
DisableWelcomePage=no
DisableReadyPage=no
UsePreviousAppDir=no
UsePreviousTasks=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
MinVersion=10.0
Uninstallable=no
CreateUninstallRegKey=no
CreateAppDir=yes
CloseApplications=no
RestartApplications=no
AllowNetworkDrive=no
AllowUNCPath=no
AppendDefaultDirName=no
DirExistsWarning=no
SetupMutex=AzusaHexPick.InstallWizard
WizardStyle=modern light windows11
WizardSizePercent=115
WizardImageFile={#WizardArtwork}
WizardSmallImageFile=..\launcher\Assets\hero.png
WizardImageStretch=yes
WizardImageBackColor=$F4F6FC
SetupIconFile=..\launcher\Assets\app.ico
OutputDir={#OutputDirectory}
OutputBaseFilename=AzusaHexPick-{#AppVersion}-Setup
Compression=lzma2/fast
SolidCompression=yes
DiskSpanning=no
ExtraDiskSpaceRequired=900000000
SetupLogging=yes

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Default.isl"

[LangOptions]
LanguageName=简体中文
LanguageID=$0804
LanguageCodePage=0
DialogFontName=Microsoft YaHei UI
DialogFontSize=9
WelcomeFontName=Microsoft YaHei UI
WelcomeFontSize=16

[Messages]
SetupAppTitle=安装
SetupWindowTitle=安装梓有妙选
InformationTitle=提示
ConfirmTitle=确认
ErrorTitle=安装未完成
WelcomeLabel1=把弹幕里的建议，放到眼前。
WelcomeLabel2=海斗选哪个技能？下一首唱什么？%n%n这几步会把梓有妙选装到你的电脑，并添加方便下次打开的入口。%n%n不需要另外安装开发工具。个人设置与名单会独立保存。
ClickNext=点击“下一步”继续，也可以先取消。
ButtonBack=上一步
ButtonNext=下一步
ButtonInstall=安装
ButtonOK=确定
ButtonCancel=取消
ButtonYes=是
ButtonNo=否
ButtonFinish=完成
ButtonBrowse=浏览…
ButtonWizardBrowse=浏览…
ButtonNewFolder=新建文件夹
BrowseDialogTitle=选择安装文件夹
BrowseDialogLabel=选好文件夹后点击“确定”。
NewFolderName=新建文件夹
WizardSelectDir=装在哪里？
SelectDirDesc=可以保留默认位置，也可以选择其他磁盘。
SelectDirLabel3=软件会安装在下面的文件夹中。
SelectDirBrowseLabel=个人设置另存于 Windows 用户目录，之后更新软件会保留。
DiskSpaceGBLabel=需要至少 [gb] GB 可用空间。
DiskSpaceMBLabel=需要至少 [mb] MB 可用空间。
WizardSelectTasks=下次怎样打开？
SelectTasksDesc=桌面快捷方式更容易找到。
SelectTasksLabel2=勾选后，安装完成就会在桌面看到梓有妙选。
WizardReady=准备好了
ReadyLabel1=点击“安装”，稍等片刻就好。
ReadyLabel2a=下面是这次的选择：
ReadyMemoDir=安装位置：
ReadyMemoTasks=快捷方式：
WizardInstalling=正在安装
InstallingLabel=正在准备程序和运行环境，请稍等片刻。
StatusExtractFiles=正在准备安装文件…
StatusRunProgram=正在安装梓有妙选…
FinishedHeadingLabel=准备好试一试了。
FinishedLabel=点击“完成”后可以打开梓有妙选。%n%n以后从桌面快捷方式或开始菜单打开即可。需要更新时，软件会提醒你。
FinishedLabelNoIcons=点击“完成”后可以打开梓有妙选。以后也可以从开始菜单找到它。
ClickFinish=点击“完成”关闭安装向导。
ExitSetupTitle=暂时不安装了吗？
ExitSetupMessage=安装还没完成。现在退出的话，可以稍后再打开这个安装包。%n%n确认退出吗？
SetupAlreadyRunning=另一个安装向导已经打开，请先完成或关闭它。
SetupFileCorrupt=安装包文件不完整，请重新下载后再试。
SetupFileCorruptOrWrongVer=安装包文件不完整，请重新下载后再试。
ErrorCreatingDir=无法创建文件夹“%1”，请换一个安装位置。
InvalidPath=请输入带有盘符的完整文件夹路径，例如 D:\Apps\AzusaHexPick。
InvalidDrive=这个磁盘暂时无法访问，请换一个位置。
InvalidDirName=文件夹名称不符合 Windows 的要求，请换一个名称。
CannotInstallToNetworkDrive=请选择这台电脑上的磁盘。
CannotInstallToUNCPath=请选择这台电脑上的磁盘。
BeveledLabel=溣符雨 · 维护

[Tasks]
Name: "desktopicon"; Description: "在桌面添加“梓有妙选”快捷方式"; Flags: checkedonce

[Files]
Source: "{#Payload}"; DestDir: "{tmp}"; DestName: "AzusaHexPick-internal-Setup.exe"; Flags: deleteafterinstall

[Run]
Filename: "{app}\{#MainExe}"; Description: "打开梓有妙选"; Flags: postinstall nowait skipifsilent

[Code]
const
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#PackageId}';
  FileAttributeReparsePoint = $400;
var
  RegisteredDirectory: String;
  InstallationGate: THandle;

function GetFileAttributes(Name: String): Cardinal;
  external 'GetFileAttributesW@kernel32.dll stdcall';
function OpenMutex(Access: Cardinal; Inherit: Boolean; Name: String): THandle;
  external 'OpenMutexW@kernel32.dll stdcall';
function CloseHandle(Handle: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';
function CreateMutex(Attributes: Integer; Owner: Boolean; Name: String): THandle;
  external 'CreateMutexW@kernel32.dll stdcall';
function WaitForSingleObject(Handle: THandle; Milliseconds: Cardinal): Cardinal;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function ReleaseMutex(Handle: THandle): Boolean;
  external 'ReleaseMutex@kernel32.dll stdcall';

procedure ReleaseInstallationGate();
begin
  if InstallationGate <> 0 then begin
    ReleaseMutex(InstallationGate);
    CloseHandle(InstallationGate);
    InstallationGate := 0;
  end;
end;

function NormalPath(Value: String): String;
begin
  Result := RemoveBackslashUnlessRoot(ExpandFileName(Value));
end;

function SamePath(Left, Right: String): Boolean;
begin
  Result := CompareText(NormalPath(Left), NormalPath(Right)) = 0;
end;

function UserDataPath(): String;
begin
  Result := GetEnv('AZUSA_USER_DATA');
  if Result = '' then Result := ExpandConstant('{localappdata}\AzusaHexPick\UserData');
end;

function AtOrBelow(Path, Parent: String): Boolean;
begin
  Result := SamePath(Path, Parent) or
    (Pos(Lowercase(AddBackslash(NormalPath(Parent))), Lowercase(AddBackslash(NormalPath(Path)))) = 1);
end;

function ContainsFiles(Path: String): Boolean;
var Entry: TFindRec;
begin
  Result := False;
  if FindFirst(AddBackslash(Path) + '*', Entry) then begin
    try
      repeat
        if (Entry.Name <> '.') and (Entry.Name <> '..') then begin
          Result := True;
          Break;
        end;
      until not FindNext(Entry);
    finally
      FindClose(Entry);
    end;
  end;
end;

function ReadPackage(Path: String; var Version: String): Boolean;
var Xml, Item: Variant;
begin
  Result := False;
  try
    if FileExists(AddBackslash(Path) + '.portable') or
      not FileExists(AddBackslash(Path) + 'Update.exe') or
      not FileExists(AddBackslash(Path) + '{#MainExe}') then Exit;
    Xml := CreateOleObject('Msxml2.DOMDocument.6.0');
    Xml.async := False;
    Xml.resolveExternals := False;
    Xml.setProperty('ProhibitDTD', True);
    if not Xml.load(AddBackslash(Path) + 'current\sq.version') then Exit;
    Item := Xml.selectSingleNode('//*[local-name()="metadata"]/*[local-name()="id"]');
    if VarIsNull(Item) or (Item.text <> '{#PackageId}') then Exit;
    Item := Xml.selectSingleNode('//*[local-name()="metadata"]/*[local-name()="channel"]');
    if VarIsNull(Item) or (Item.text <> 'win') then Exit;
    Item := Xml.selectSingleNode('//*[local-name()="metadata"]/*[local-name()="mainExe"]');
    if VarIsNull(Item) or (Item.text <> '{#MainExe}') then Exit;
    Item := Xml.selectSingleNode('//*[local-name()="metadata"]/*[local-name()="version"]');
    if VarIsNull(Item) then Exit;
    Version := Item.text;
    Result := Version <> '';
  except
    Result := False;
  end;
end;

function RunningProject(): Boolean;
var Request: Variant;
    Handle: THandle;
    Response: String;
    Status: Integer;
begin
  Handle := OpenMutex($00100000, False, 'Local\AzusaHexPick.Launcher');
  Result := Handle <> 0;
  if Result then CloseHandle(Handle);
  if Result then Exit;
  try
    Request := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    Request.SetTimeouts(500, 500, 500, 500);
    Request.SetProxy(1);
    Request.Open('GET', 'http://127.0.0.1:5178/api/health', False);
    Request.Send();
    Response := Request.ResponseText;
    Status := Request.Status;
    Result := (Status = 200) and (Pos('azusa-validation', Response) > 0);
  except
    Result := False;
  end;
end;

function DirectoryProblem(Path: String): String;
var Parent, NextParent, Version: String;
    Attributes: Cardinal;
    CurrentVersion, TargetVersion: Int64;
begin
  Result := '';
  Path := NormalPath(Path);
  Log('Validating installation directory: ' + Path);
  Log('Windows: ' + ExpandConstant('{win}') + '; programs: ' + ExpandConstant('{commonpf}') + '; data: ' + ExpandConstant('{commonappdata}'));
  if (Length(Path) < 4) or (ExtractFileDrive(Path) = '') or
    (Pos('\\', Path) = 1) or (Length(Path) > 170) then begin
    Result := '请选择一个路径较短的本机文件夹，例如 D:\Apps\AzusaHexPick。'; Exit;
  end;
  if AtOrBelow(Path, ExpandConstant('{win}')) or
    AtOrBelow(Path, ExpandConstant('{commonpf}')) or
    AtOrBelow(Path, ExpandConstant('{commonpf64}')) or
    AtOrBelow(Path, ExpandConstant('{commonappdata}')) or
    AtOrBelow(Path, ExpandConstant('{localappdata}\AzusaHexPick\UserData')) or
    AtOrBelow(Path, UserDataPath()) or
    AtOrBelow(GetEnv('USERPROFILE'), Path) or
    AtOrBelow(ExpandConstant('{localappdata}\AzusaHexPick\UserData'), Path) or
    AtOrBelow(UserDataPath(), Path) then begin
    Result := '这里是系统或个人数据的位置，请选择一个独立的程序文件夹。'; Exit;
  end;
  Parent := Path;
  repeat
    Attributes := GetFileAttributes(Parent);
    if (Attributes <> $FFFFFFFF) and ((Attributes and FileAttributeReparsePoint) <> 0) then begin
      Result := '这个位置经过了文件夹链接，请选择普通的本机文件夹。'; Exit;
    end;
    if FileExists(AddBackslash(Parent) + '.portable') then begin
      Result := '这里是便携版文件夹。请另选一个安装位置，便携版会保持原样。'; Exit;
    end;
    if not SamePath(Parent, Path) and ReadPackage(Parent, Version) then begin
      Result := '这里属于已有安装版的文件夹，请保留原位置或选择独立的新文件夹。'; Exit;
    end;
    NextParent := RemoveBackslashUnlessRoot(ExtractFileDir(Parent));
    if SamePath(Parent, NextParent) then Break;
    Parent := NextParent;
  until Parent = '';
  if RegisteredDirectory <> '' then begin
    if not SamePath(Path, RegisteredDirectory) then begin
      Result := '已经找到安装版，这次会继续使用原来的位置。要换位置，请先卸载原来的安装版。'; Exit;
    end;
    if not ReadPackage(Path, Version) then begin
      Result := '原安装目录的程序文件不完整。请先卸载旧安装记录，再重新安装；个人设置会保留。'; Exit;
    end;
    if StrToVersion(Version, CurrentVersion) and StrToVersion('{#AppVersion}', TargetVersion) and
      (ComparePackedVersion(CurrentVersion, TargetVersion) > 0) then begin
      Result := '电脑上的版本更新，请使用现有软件中的“检查更新”。'; Exit;
    end;
  end else if DirExists(Path) and ContainsFiles(Path) then begin
    Result := '这个文件夹已经有其他文件，请选一个新的或空的文件夹。'; Exit;
  end;
end;

function InitializeSetup(): Boolean;
var Version, Found: String;
begin
  Result := True;
  RegisteredDirectory := '';
  if RegQueryStringValue(HKCU, UninstallKey, 'InstallLocation', Found) then begin
    if ReadPackage(Found, Version) then RegisteredDirectory := NormalPath(Found)
    else begin
      SuppressibleMsgBox('找到了旧安装记录，但程序文件不完整。请先在 Windows 设置中卸载旧安装版，再运行这个安装包。个人设置会保留。', mbError, MB_OK, IDOK);
      Result := False;
    end;
  end;
end;

procedure InitializeWizard();
begin
  if RegisteredDirectory <> '' then begin
    WizardForm.DirEdit.Text := RegisteredDirectory;
    WizardForm.DirEdit.Enabled := False;
    WizardForm.DirBrowseButton.Enabled := False;
    WizardForm.SelectDirBrowseLabel.Caption := '已经找到安装版，这次继续使用原来的位置。个人设置会保留。';
  end;
  WizardForm.BeveledLabel.Font.Color := $BD5377;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var Problem: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then begin
    Problem := DirectoryProblem(WizardDirValue());
    if Problem <> '' then begin SuppressibleMsgBox(Problem, mbError, MB_OK, IDOK); Result := False; end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var Target, Probe: String;
    WaitResult: Cardinal;
begin
  Result := DirectoryProblem(WizardDirValue());
  if Result <> '' then Exit;
  if InstallationGate = 0 then begin
    InstallationGate := CreateMutex(0, False, 'Local\AzusaHexPick.Installing');
    if InstallationGate = 0 then begin Result := '暂时无法开始安装，请关闭其他安装向导后重试。'; Exit; end;
    WaitResult := WaitForSingleObject(InstallationGate, 0);
    if (WaitResult <> 0) and (WaitResult <> $80) then begin
      CloseHandle(InstallationGate); InstallationGate := 0;
      Result := '软件正在启动或安装，请稍后重试。'; Exit;
    end;
  end;
  if RunningProject() then begin
    Result := '梓有妙选还在运行。请在启动器、控制台或托盘选择“退出全部”，然后点击“重试”。本轮收集不会被强制打断。'; ReleaseInstallationGate(); Exit;
  end;
  Target := NormalPath(WizardDirValue());
  if not ForceDirectories(Target) then begin Result := '无法写入这个位置，请换一个文件夹。'; ReleaseInstallationGate(); Exit; end;
  Probe := AddBackslash(Target) + 'azusa-install-write-check.tmp';
  if FileExists(Probe) or not SaveStringToFile(Probe, 'write-check', False) then begin
    Result := '这个位置暂时不能写入，请换一个文件夹。'; ReleaseInstallationGate(); Exit;
  end;
  DeleteFile(Probe);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var ExitCode: Integer;
    Target, Version, Registered, DisplayVersion, LogPath, UserData: String;
begin
  if CurStep = ssPostInstall then begin
    if RunningProject() then RaiseException('梓有妙选又被打开了。请先退出全部，再重新运行安装包。');
    Target := NormalPath(WizardDirValue());
    UserData := UserDataPath();
    LogPath := AddBackslash(UserData) + 'runtime\installer.log';
    ForceDirectories(ExtractFileDir(LogPath));
    WizardForm.StatusLabel.Caption := '正在安装梓有妙选…';
    if not Exec(ExpandConstant('{tmp}\AzusaHexPick-internal-Setup.exe'),
      '--silent --installto "' + Target + '" --log "' + LogPath + '"', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      RaiseException('安装没有完成。请检查磁盘空间和文件夹权限，然后重新运行安装包。个人设置没有被删除。');
    if not ReadPackage(Target, Version) or (Version <> '{#AppVersion}') or
      not RegQueryStringValue(HKCU, UninstallKey, 'InstallLocation', Registered) or
      not SamePath(Target, Registered) or
      not RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', DisplayVersion) or
      (DisplayVersion <> '{#AppVersion}') then
      RaiseException('程序版本或安装登记没有验证通过，请重新运行安装包。个人设置会保留。');
    if WizardIsTaskSelected('desktopicon') then
      CreateShellLink(ExpandConstant('{userdesktop}\梓有妙选.lnk'), '梓有妙选｜Azusa HexPick',
        AddBackslash(Target) + '{#MainExe}', '', Target, AddBackslash(Target) + '{#MainExe}', 0, SW_SHOWNORMAL);
    ReleaseInstallationGate();
  end;
end;

procedure DeinitializeSetup();
begin
  ReleaseInstallationGate();
end;
