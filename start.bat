@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0" || exit /b 1

set "CERT_PREP_NO_BROWSER="
if /i "%~1"=="--no-browser" set "CERT_PREP_NO_BROWSER=1"
if not exist "package.json" (
  echo Keep this script in the Cert Prep project folder.
  goto failed
)

where node.exe >nul 2>&1
if errorlevel 1 goto node_required
node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto node_required
where npm.cmd >nul 2>&1
if errorlevel 1 goto node_required

set "CERT_PREP_PORT="
for /f "delims=" %%P in ('node.exe --env-file-if-exists=.env -e "const raw=process.env.PORT;const port=Number(raw?raw:4173);if(Number.isInteger(port))if(Math.min(Math.max(port,1),65535)===port)console.log(port);"') do set "CERT_PREP_PORT=%%P"
if not defined CERT_PREP_PORT (
  echo Could not read a valid PORT. Check the .env file.
  goto failed
)
set "CERT_PREP_LAUNCH_URL=http://127.0.0.1:%CERT_PREP_PORT%"
set "CERT_PREP_ALREADY_RUNNING="

node.exe -e "fetch(process.argv[1]+'/api/workspace',{signal:AbortSignal.timeout(1200)}).then(async r=>{if(!r.ok)process.exit(1);const data=await r.json();process.exit(Array.isArray(data.certificates) ? 0 : 1);}).catch(()=>process.exit(1));" "%CERT_PREP_LAUNCH_URL%"
if not errorlevel 1 set "CERT_PREP_ALREADY_RUNNING=1"
if defined CERT_PREP_ALREADY_RUNNING if exist "dist\index.html" goto open_existing

if not defined CERT_PREP_ALREADY_RUNNING (
  node.exe -e "const s=require('node:net').createServer();s.once('error',()=>process.exit(1));s.listen(Number(process.argv[1]),'127.0.0.1',()=>s.close());" "%CERT_PREP_PORT%"
  if errorlevel 1 (
    echo Port %CERT_PREP_PORT% is in use. Close the other service or change PORT in .env.
    goto failed
  )
)

call npm.cmd ls --depth=0 --include=dev >nul 2>&1
if errorlevel 1 (
  echo Installing project dependencies...
  call npm.cmd ci --include=dev
  if errorlevel 1 goto failed
)

echo Building Cert Prep...
call npm.cmd run build
if errorlevel 1 goto failed
if defined CERT_PREP_ALREADY_RUNNING goto open_existing

echo Starting Cert Prep at %CERT_PREP_LAUNCH_URL%
echo Press Ctrl+C in this window to stop the service.
if not defined CERT_PREP_NO_BROWSER (
  start "" /b powershell.exe -NoProfile -NonInteractive -Command "$url=$env:CERT_PREP_LAUNCH_URL; for ($i=0; $i -lt 30; $i++) { try { $workspace=Invoke-RestMethod ($url + '/api/workspace') -TimeoutSec 1; if ($workspace.PSObject.Properties['certificates']) { Start-Process -FilePath $url; break } } catch {}; Start-Sleep -Milliseconds 400 }"
)
call npm.cmd start
if errorlevel 1 goto failed
exit /b 0

:open_existing
echo Cert Prep is already running at %CERT_PREP_LAUNCH_URL%
if not defined CERT_PREP_NO_BROWSER start "" "%CERT_PREP_LAUNCH_URL%"
exit /b 0

:node_required
echo Install Node.js 24 or newer with npm, then run this script again.

:failed
echo Cert Prep could not start. See the message above.
if not defined CERT_PREP_NO_BROWSER pause
exit /b 1
