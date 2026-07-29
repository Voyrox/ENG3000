## Install PlatformIO

Download the installation script:
```bash
cd $HOME\Downloads

Invoke-WebRequest `
    -Uri "https://raw.githubusercontent.com/platformio/platformio-core-installer/master/get-platformio.py" `
    -OutFile "get-platformio.py"
```

Install PlatformIO:
```bash
cd $HOME\Downloads
python get-platformio.py
```

Add PlatformIO to your PATH:
```bash
$pioPath = "$env:USERPROFILE\.platformio\penv\Scripts"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")

if (($userPath -split ";") -notcontains $pioPath) {
    [Environment]::SetEnvironmentVariable(
        "Path",
        "$pioPath;$userPath",
        "User"
    )
}
```

Verify installation:
```bash
pio --version
```

Then do:
```
Ctrl+Shift+P.
Search for task: spawn. - Select the PlatformIO task
```
