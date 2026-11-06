$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not $env:JAVA_HOME -or -not (Test-Path "$env:JAVA_HOME\bin\java.exe")) {
    $env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-17.0.21.21-hotspot"
}
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"

Write-Host "1) Preparing Captain web assets..." -ForegroundColor Cyan
node scripts/prepare-apk.js

$SdkRoot = "$env:LOCALAPPDATA\Android\Sdk"
$BuildToolsVer = "34.0.0"
$PlatformVer = "android-34"

if (-not (Test-Path "$SdkRoot\build-tools\$BuildToolsVer\aapt2.exe") -or -not (Test-Path "$SdkRoot\platforms\$PlatformVer\android.jar")) {
    Write-Host "2) Downloading lightweight Android SDK Command-Line Tools..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path "$SdkRoot\cmdline-tools" | Out-Null
    $ZipPath = "$SdkRoot\cmdline-tools.zip"
    if (-not (Test-Path "$SdkRoot\cmdline-tools\latest\bin\sdkmanager.bat")) {
        curl.exe -L "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip" -o $ZipPath
        Expand-Archive -Path $ZipPath -DestinationPath "$SdkRoot\cmdline-tools-tmp" -Force
        if (Test-Path "$SdkRoot\cmdline-tools\latest") { Remove-Item -Recurse -Force "$SdkRoot\cmdline-tools\latest" }
        Move-Item "$SdkRoot\cmdline-tools-tmp\cmdline-tools" "$SdkRoot\cmdline-tools\latest"
        Remove-Item -Recurse -Force "$SdkRoot\cmdline-tools-tmp", $ZipPath
    }
    $SdkManager = "$SdkRoot\cmdline-tools\latest\bin\sdkmanager.bat"
    "y`ny`ny`ny`ny`ny`ny`n" | & $SdkManager --sdk_root="$SdkRoot" "platforms;$PlatformVer" "build-tools;$BuildToolsVer"
}

$Aapt2 = "$SdkRoot\build-tools\$BuildToolsVer\aapt2.exe"
$D8 = "$SdkRoot\build-tools\$BuildToolsVer\d8.bat"
$ZipAlign = "$SdkRoot\build-tools\$BuildToolsVer\zipalign.exe"
$ApkSigner = "$SdkRoot\build-tools\$BuildToolsVer\apksigner.bat"
$AndroidJar = "$SdkRoot\platforms\$PlatformVer\android.jar"

# Use ASCII staging directory to avoid any non-ASCII path issues in Android native tools
$StageDir = "$env:TEMP\panther-apk-build"
if (Test-Path $StageDir) { Remove-Item -Recurse -Force $StageDir }
New-Item -ItemType Directory -Force -Path "$StageDir\gen", "$StageDir\obj", "$StageDir\dex", "$StageDir\src" | Out-Null

Copy-Item -Recurse -Force "$Root\android-captain\app\src\main\*" "$StageDir\src\"

Write-Host "3) Compiling Android resources with aapt2..." -ForegroundColor Cyan
& $Aapt2 compile --dir "$StageDir\src\res" -o "$StageDir\res.zip"
& $Aapt2 link -o "$StageDir\unaligned.apk" `
    -I $AndroidJar `
    --manifest "$StageDir\src\AndroidManifest.xml" `
    --java "$StageDir\gen" `
    "$StageDir\res.zip"

Write-Host "4) Compiling Java sources with JDK 17..." -ForegroundColor Cyan
javac -source 17 -target 17 -encoding UTF-8 `
    -cp $AndroidJar `
    -d "$StageDir\obj" `
    "$StageDir\gen\sy\panther\captain\R.java" `
    "$StageDir\src\java\sy\panther\captain\MainActivity.java" `
    "$StageDir\src\java\sy\panther\captain\CaptainService.java"

Write-Host "5) Converting bytecode to DEX with d8..." -ForegroundColor Cyan
$ClassFiles = Get-ChildItem -Path "$StageDir\obj" -Filter "*.class" -Recurse | ForEach-Object { $_.FullName }
& $D8 --lib $AndroidJar --output "$StageDir\dex" $ClassFiles

Write-Host "6) Packaging classes.dex and assets into APK..." -ForegroundColor Cyan
jar -uf "$StageDir\unaligned.apk" -C "$StageDir\dex" classes.dex -C "$StageDir\src" assets

Write-Host "7) Aligning and signing panther-captain.apk..." -ForegroundColor Cyan
& $ZipAlign -f 4 "$StageDir\unaligned.apk" "$StageDir\aligned.apk"

$Keystore = "$StageDir\release-key.jks"
if (Test-Path "$Root\android-captain\release-key.jks") {
    Copy-Item -Force "$Root\android-captain\release-key.jks" $Keystore
} else {
    keytool -genkeypair -v -keystore $Keystore -alias panther -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass panther123 -keypass panther123 -dname "CN=PANTHER Delivery, O=PANTHER, C=SY"
    Copy-Item -Force $Keystore "$Root\android-captain\release-key.jks"
}

& $ApkSigner sign --ks $Keystore --ks-pass pass:panther123 --key-pass pass:panther123 --out "$StageDir\panther-captain.apk" "$StageDir\aligned.apk"

$OutApk = "$Root\public\panther-captain.apk"
Copy-Item -Force "$StageDir\panther-captain.apk" $OutApk

Write-Host "✅ APK built and signed successfully: $OutApk" -ForegroundColor Green
