#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef ReleaseDir
  #error ReleaseDir is required
#endif
#define AppVersion "0.1.0"

[Setup]
AppId={{1E774D3A-BDC6-4A32-8984-3CEBD1B44E25}
AppName=叙幕 Studio
AppVersion={#AppVersion}
AppPublisher=princefrogdida-ux
AppPublisherURL=https://github.com/princefrogdida-ux/xumu-studio
DefaultDirName={localappdata}\Programs\XumuStudio
DefaultGroupName=叙幕 Studio
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#ReleaseDir}
OutputBaseFilename=Xumu-Studio-{#AppVersion}-Windows-x64-Setup
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=叙幕 Studio
CloseApplications=no
RestartApplications=no
InfoBeforeFile={#PayloadDir}\INSTALLATION.txt
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\叙幕 Studio"; Filename: "{app}\Start-Xumu-Studio.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\runtime\node.exe"
Name: "{userdesktop}\叙幕 Studio"; Filename: "{app}\Start-Xumu-Studio.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\runtime\node.exe"; Tasks: desktopicon
Name: "{group}\Uninstall 叙幕 Studio"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\Start-Xumu-Studio.cmd"; Description: "Launch Xumu Studio"; Flags: postinstall shellexec skipifsilent nowait

[Code]
function CreateFileW(Name: String; Access, ShareMode, Security, Creation, Flags, Template: LongWord): LongWord;
  external 'CreateFileW@kernel32.dll stdcall';
function CloseHandle(Handle: LongWord): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  FileHandle: LongWord;
begin
  Result := '';
  // Refuse replacing an active runtime. Never terminate unrelated processes.
  if FileExists(ExpandConstant('{app}\runtime\node.exe')) then
  begin
    FileHandle := CreateFileW(ExpandConstant('{app}\runtime\node.exe'), $C0000000, 0, 0, 3, $80, 0);
    if FileHandle = $FFFFFFFF then
      Result := 'Xumu Studio may be running. Type stop in its console, then retry installation.'
    else
      CloseHandle(FileHandle);
  end;
end;
