@echo off
REM ---------------------------------------------------------------------------
REM  Build the MoonVoice sidecar into a single-file exe with PyInstaller.
REM
REM  Output:  dist\moonvoice-sidecar.exe
REM
REM  Usage:
REM      build-exe.cmd                       (uses "python" from PATH)
REM      build-exe.cmd <path-to-python.exe>  (uses a specific interpreter)
REM
REM  The interpreter needs the build dependencies from requirements-build.txt.
REM  Run this from the server\ directory, or just double-click it.
REM
REM  This source tree stays the single source of truth: the exe that ships
REM  inside the MoonVoice package is a build artifact of this file's
REM  directory, so rebuild and republish after every change to breeze_api.py.
REM ---------------------------------------------------------------------------
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"

set "PY=%~1"
if "%PY%"=="" set "PY=python"

echo ============================================================
echo    Building moonvoice-sidecar.exe
echo ============================================================
echo.
echo   python : %PY%
echo   workdir: %ROOT%
echo.

"%PY%" -c "import PyInstaller, sys; print('  PyInstaller', PyInstaller.__version__, 'on', sys.version.split()[0])" 2>nul
if errorlevel 1 (
    echo [ERROR] PyInstaller not available for this interpreter.
    echo.
    echo         Install the build dependencies first:
    echo             "%PY%" -m pip install -r requirements-build.txt
    echo.
    pause
    exit /b 1
)

if not exist "breeze_api.py"   ( echo [ERROR] breeze_api.py not found & pause & exit /b 1 )
if not exist "webui.html"      ( echo [ERROR] webui.html not found & pause & exit /b 1 )
if not exist "manage.html"     ( echo [ERROR] manage.html not found & pause & exit /b 1 )
if not exist "moonvoice-sidecar.spec" ( echo [ERROR] spec file not found & pause & exit /b 1 )

echo   Cleaning previous build ...
if exist "build" rmdir /s /q "build"
if exist "dist"  rmdir /s /q "dist"

echo   Running PyInstaller (this takes 1-3 minutes) ...
echo.
"%PY%" -m PyInstaller "moonvoice-sidecar.spec" --noconfirm --clean
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed. See the messages above.
    pause
    exit /b 1
)

if not exist "dist\moonvoice-sidecar.exe" (
    echo.
    echo [ERROR] Build reported success but the exe is missing.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo    Done
echo ============================================================
for %%F in ("dist\moonvoice-sidecar.exe") do echo   %%~fF   (%%~zF bytes)
echo.
echo   Next: copy dist\moonvoice-sidecar.exe into the package's 侧车\ folder,
echo         then run the package launchers to verify it end to end.
echo.
pause
