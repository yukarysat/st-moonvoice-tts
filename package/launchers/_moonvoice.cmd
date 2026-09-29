@echo off
chcp 936 >nul
setlocal EnableExtensions
title 月声 MoonVoice

REM ===========================================================================
REM  这是内部逻辑文件。请双击同目录下的这三个之一：
REM      启动webui.cmd          日常使用（后端 + 工作台，只在本机）
REM      启动局域网服务.cmd      手机/平板要连的时候用
REM      启动后端.cmd            只想单独控制后端时用
REM ===========================================================================
set "MODE=%~1"
if "%MODE%"=="" goto no_mode

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

REM 把工作目录移出安装目录。本窗口按设计会一直开着等你按键，如果工作目录
REM 停在安装目录里，Windows 会一直占用它 —— 之后就没办法重命名、删除或
REM 重新解压这个文件夹（会报"另一个程序正在使用"）。
REM 下面所有路径都用 %ROOT% 拼的绝对路径，所以换工作目录不影响功能。
cd /d "%TEMP%" 2>nul

set "BACKEND=%ROOT%\backend"
set "SIDECAR=%ROOT%\sidecar"
set "DATA=%ROOT%\data"
set "BACKEND_EXE=%BACKEND%\runtime\audiocpp_server.exe"
REM 模型路径不再写死在这里：由 :ensure_model 扫 backend\models 下的 *.gguf 决定，
REM 这样用户把下载的模型丢进去就能换档，不用改任何配置。
set "SIDECAR_EXE=%SIDECAR%\moonvoice-sidecar.exe"

set "HAVECURL="
curl --version >nul 2>&1 && set "HAVECURL=1"

if /i "%MODE%"=="stop" goto mode_stop
if /i "%MODE%"=="backend" goto mode_backend
if /i "%MODE%"=="local" goto mode_local
if /i "%MODE%"=="lan" goto mode_lan
if /i "%MODE%"=="firewall" goto mode_firewall
echo [错误] 未知模式 "%MODE%"
pause
exit /b 1

:no_mode
echo ============================================================
echo    请不要直接运行这个文件
echo ============================================================
echo.
echo    它只是内部逻辑。请回到上一级目录，双击：
echo.
echo      启动webui.cmd          日常使用
echo      启动局域网服务.cmd      手机/平板要连的时候用
echo      启动后端.cmd            只想单独控制后端时用
echo      停止全部.cmd            关闭服务
echo.
pause
exit /b 1


REM ===========================================================================
REM  启动前检查
REM ===========================================================================
:precheck
call :check_ascii
if errorlevel 1 exit /b 9
if not exist "%BACKEND_EXE%" (
    echo.
    echo   [错误] 找不到后端程序：
    echo          %BACKEND_EXE%
    echo.
    echo   整合包可能没有解压完整。请重新解压，注意不要只解压一部分，
    echo   也不要直接从压缩包里运行。
    echo.
    pause
    exit /b 9
)
if not exist "%SIDECAR_EXE%" (
    echo.
    echo   [错误] 找不到服务程序：
    echo          %SIDECAR_EXE%
    echo.
    echo   整合包可能没有解压完整。
    echo.
    pause
    exit /b 9
)
call :ensure_model
if errorlevel 1 exit /b 9
if not exist "%DATA%" mkdir "%DATA%" >nul 2>&1
if not exist "%DATA%\voices" mkdir "%DATA%\voices" >nul 2>&1
if not exist "%DATA%\pjy" mkdir "%DATA%\pjy" >nul 2>&1
exit /b 0


REM ---------------------------------------------------------------------------
REM  路径不能有中文
REM  后端是 C++ 程序，在 Windows 上按 ANSI 代码页打开文件，路径含非 ASCII
REM  字符时读不到模型（本项目已在参考音频上实测过同一机制）。
REM ---------------------------------------------------------------------------
:check_ascii
set "MOONVOICE_ROOT=%ROOT%"
set "ASCIIOK="
set "TMPF=%TEMP%\mv_ascii_%RANDOM%.txt"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_helper.ps1" -Action checkpath > "%TMPF%" 2>nul
if exist "%TMPF%" set /p ASCIIOK=<"%TMPF%"
del "%TMPF%" >nul 2>&1
if /i "%ASCIIOK%"=="OK" exit /b 0
echo.
echo   ============================================================
echo    [重要] 当前文件夹的路径里有中文或其它特殊字符
echo   ============================================================
echo.
echo     当前路径：%ROOT%
echo.
echo     Breeze 后端是 C++ 程序，在 Windows 上按 ANSI 代码页打开文件，
echo     路径里出现中文时它读不到模型，一定会启动失败。
echo.
echo     请把整个文件夹移动到纯英文路径，例如：
echo         D:\MoonVoice\
echo     然后重新双击本文件。
echo.
set "GO="
set /p "GO=仍要尝试继续吗？(y/N) "
if /i "%GO%"=="y" exit /b 0
exit /b 1


REM ===========================================================================
REM  :ensure_model —— 挑一个模型用，并把路径写进 backend\server.json
REM      目录里只有一个就直用它；有多个则按显存自动挑最好的那一档；
REM      一个都没有时给出下载指引（而不是让后端报 failed to open GGUF）。
REM ===========================================================================
:ensure_model
set "MOONVOICE_ROOT=%ROOT%"
set "MPTMP=%TEMP%\mv_model_%RANDOM%.txt"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_helper.ps1" -Action pickmodel > "%MPTMP%" 2>nul
set "MPICK="
if exist "%MPTMP%" set /p MPICK=<"%MPTMP%"
del "%MPTMP%" >nul 2>&1

if /i "%MPICK%"=="NOMODEL" goto model_none
if /i "%MPICK%"=="NOCONFIG" goto model_none

set "M_NAME="
set "M_NEED="
set "M_TOTAL="
set "M_COUNT="
set "M_WARN="
for /f "tokens=1-6 delims=;" %%a in ("%MPICK%") do (
    set "M_STAT=%%a"
    set "M_NAME=%%b"
    set "M_NEED=%%c"
    set "M_TOTAL=%%d"
    set "M_COUNT=%%e"
    set "M_WARN=%%f"
)
if /i "%M_STAT%"=="BAD" goto model_bad
if /i "%M_STAT%"=="WRITEFAIL" goto model_writefail
if not defined M_NAME (
    echo   [警告] 模型检查返回了意外结果，仍按配置里的路径启动
    exit /b 0
)
echo   模型：%M_NAME%   需要约 %M_NEED% MiB 显存
if not "%M_TOTAL%"=="0" echo   显卡 %M_TOTAL% MiB，模型目录里有 %M_COUNT% 个档位
if /i "%M_WARN%"=="tight" echo   [警告] 显存可能不够，建议只留更小的一档
if /i "%M_WARN%"=="nogpu" echo   [注意] 读不到显卡显存，若启动失败请换小一档
exit /b 0

:model_bad
echo.
echo   ============================================================
echo    [错误] 这个文件不是有效的 GGUF 模型
echo   ============================================================
echo.
echo          %M_NAME%
echo.
echo     多半是下载没完成。请重新下载完整的 .gguf 文件放回：
echo          %BACKEND%\models\Breeze-TTS-2-GGUF\
echo.
pause
exit /b 9

:model_writefail
echo.
echo   [错误] 无法把模型路径写入 %BACKEND%\server.json
echo.
echo     请确认这个文件夹没有被设为只读，也没有被其它程序占用。
echo.
pause
exit /b 9

:model_none
echo.
echo   ============================================================
echo    [错误] 没有找到模型文件
echo   ============================================================
echo.
echo     这个目录里没有任何 .gguf 模型：
echo          %BACKEND%\models\Breeze-TTS-2-GGUF\
echo.
echo     本整合包**不含模型**，请按 readme.txt 的「模型」一节下载一档，
echo     把 .gguf 文件放进上面那个目录，然后重新双击本文件 ——
echo     不用改任何设置，放哪个就用哪个。
echo.
echo     各档位大致对应（显存按"模型大小 + 约 0.25 GB"估算，另需给桌面留余量）：
echo          bf16   约 6.8 GB   质量最好，建议 12 GB 以上显存
echo          q8_0   约 4.6 GB   8 GB 显存流畅
echo          q6_k   约 4.5 GB   8 GB 显存流畅
echo          q5_k   约 4.3 GB   6 GB 显存可用
echo          q4_k   约 4.0 GB   6 GB 显存从容，音质略有损失
echo.
pause
exit /b 9


REM ===========================================================================
REM  :port_up 端口  —— 健康检查通过则设 OK=1
REM ===========================================================================
:port_up
set "OK="
if defined HAVECURL (
    curl -s -o NUL -m 5 http://127.0.0.1:%1/health
    if not errorlevel 1 set "OK=1"
    exit /b 0
)
powershell -NoProfile -Command "try{Invoke-WebRequest -Uri 'http://127.0.0.1:%1/health' -TimeoutSec 5 -UseBasicParsing|Out-Null;exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 set "OK=1"
exit /b 0


REM ===========================================================================
REM  :ensure_backend  —— 后端没跑就拉起来并等就绪
REM ===========================================================================
:ensure_backend
call :port_up 7870
if defined OK (
    echo   后端：已在运行
    exit /b 0
)
echo   后端：正在启动（要加载约 7 GB 模型，首次请耐心等 15~60 秒）
start "月声后端" /min /d "%BACKEND%" "%BACKEND_EXE%" --config server.json
set /a N=0
:eb_wait
set "OK="
call :port_up 7870
if defined OK (
    echo.
    echo   后端：就绪 [OK]
    exit /b 0
)
set /a N+=1
if %N% GEQ 120 (
    echo.
    echo   [错误] 等了 2 分钟后端仍未就绪。
    echo.
    echo     最常见的原因是显存不够（模型约需 7 GB）。请关掉游戏、
    echo     浏览器硬件加速、其它 AI 程序后重试。
    echo     其次确认显卡是 NVIDIA。
    echo.
    echo     日志在：%BACKEND%\logs\
    echo.
    pause
    exit /b 1
)
<nul set /p "=."
ping -n 2 127.0.0.1 >nul
goto eb_wait


REM ===========================================================================
REM  :sidecar_mode  —— 侧车当前监听地址写入 CURMODE
REM     127.0.0.1 / 0.0.0.0 / 空（没在跑）
REM ===========================================================================
:sidecar_mode
set "CURMODE="
set "NSTMP=%TEMP%\mv_mode_%RANDOM%.txt"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_helper.ps1" -Action sidecarmode > "%NSTMP%" 2>nul
if exist "%NSTMP%" set /p CURMODE=<"%NSTMP%"
del "%NSTMP%" >nul 2>&1
if /i "%CURMODE%"=="none" set "CURMODE="
exit /b 0


REM ===========================================================================
REM  :stop_sidecar
REM ===========================================================================
:stop_sidecar
taskkill /F /IM moonvoice-sidecar.exe >nul 2>&1
set "NSTMP=%TEMP%\mv_pids_%RANDOM%.txt"
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 7881 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | Set-Content -LiteralPath '%NSTMP%' -Encoding ascii" >nul 2>&1
if exist "%NSTMP%" (
    for /f "usebackq delims=" %%p in ("%NSTMP%") do (
        if not "%%p"=="" taskkill /F /PID %%p >nul 2>&1
    )
)
del "%NSTMP%" >nul 2>&1
exit /b 0


REM ===========================================================================
REM  :ensure_sidecar 期望地址
REM ===========================================================================
:ensure_sidecar
set "WANT=%~1"
call :sidecar_mode
if /i "%CURMODE%"=="%WANT%" (
    echo   工作台：已在运行（%WANT%）
    exit /b 0
)
if not "%CURMODE%"=="" (
    echo   工作台：当前是 %CURMODE% 模式，需要切换为 %WANT%，正在重启 ...
    call :stop_sidecar
    ping -n 2 127.0.0.1 >nul
)
set "HOSTARG="
if "%WANT%"=="0.0.0.0" set "HOSTARG=--host 0.0.0.0"
echo   工作台：正在启动（%WANT%）...
start "月声侧车" /min /d "%SIDECAR%" "%SIDECAR_EXE%" %HOSTARG% --data-dir "%DATA%"
set /a N=0
:es_wait
set "OK="
call :port_up 7881
if defined OK (
    echo   工作台：就绪 [OK]
    exit /b 0
)
set /a N+=1
if %N% GEQ 30 (
    echo.
    echo   [错误] 工作台服务启动失败。
    echo         请把上面那个最小化的「月声侧车」窗口打开看看报错信息。
    echo.
    pause
    exit /b 1
)
<nul set /p "=."
ping -n 2 127.0.0.1 >nul
goto es_wait


REM ===========================================================================
REM  :ensure_firewall  —— 局域网模式需要放行 7881
REM ===========================================================================
:ensure_firewall
set "FWSTATE="
set "FWTMP=%TEMP%\mv_fw_%RANDOM%.txt"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_checkfw.ps1" > "%FWTMP%" 2>nul
if exist "%FWTMP%" set /p FWSTATE=<"%FWTMP%"
del "%FWTMP%" >nul 2>&1
if /i "%FWSTATE%"=="yes" (
    echo   防火墙：7881 已放行 [OK]
    exit /b 0
)
if /i "%FWSTATE%"=="yes-any" (
    echo   防火墙：7881 已放行，但来源没有限制在同一网段。
    echo             手机能用，不过建议自行收紧到本机网段。
    exit /b 0
)
echo   防火墙：还没有放行 7881，正在请求管理员权限 ...
echo             （稍后会弹出 UAC 窗口，请点「是」）
set "FW=%~dp0_firewall.ps1"
powershell -NoProfile -Command "Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$env:FW" >nul 2>&1
ping -n 4 127.0.0.1 >nul
set "FWSTATE2="
set "FWTMP2=%TEMP%\mv_fw2_%RANDOM%.txt"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_checkfw.ps1" > "%FWTMP2%" 2>nul
if exist "%FWTMP2%" set /p FWSTATE2=<"%FWTMP2%"
del "%FWTMP2%" >nul 2>&1
if /i "%FWSTATE2%"=="no" (
    echo.
    echo   [警告] 防火墙仍未放行，手机可能连不上。
    echo          你可以稍后单独双击「放行防火墙.cmd」再试一次。
    echo.
) else (
    echo   防火墙：已放行 [OK]
)
exit /b 0


REM ===========================================================================
REM  :lan_ip  —— 本机局域网地址写入 LANIP
REM ===========================================================================
:lan_ip
set "LANIP="
set "IPTMP=%TEMP%\mv_ip_%RANDOM%.txt"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_helper.ps1" -Action lanip > "%IPTMP%" 2>nul
if exist "%IPTMP%" set /p LANIP=<"%IPTMP%"
del "%IPTMP%" >nul 2>&1
exit /b 0


REM ===========================================================================
REM  模式：后端（给酒馆用，不打开工作台）
REM      从酒馆的视角看，"后端"就是侧车 + 推理服务这一整套 —— 插件要的正是它们。
REM      所以本模式与「启动工作台」做同样的事，唯一区别是不自动打开浏览器。
REM ===========================================================================
:mode_backend
set "MV_TITLE=月声 · 启动服务（不打开工作台）"
set "MV_OPEN="
goto local_common


REM ===========================================================================
REM  模式：本机（日常）
REM ===========================================================================
:mode_local
set "MV_TITLE=月声 · 启动工作台（本机模式）"
set "MV_OPEN=1"

:local_common
echo ============================================================
echo    %MV_TITLE%
echo ============================================================
echo.
call :precheck
if errorlevel 1 exit /b 1
call :ensure_backend
if errorlevel 1 exit /b 1
call :ensure_sidecar 127.0.0.1
if errorlevel 1 exit /b 1
echo.
echo   ============================================================
echo     可以用了
echo   ============================================================
echo.
echo     工作台（建音色、管音效）： http://127.0.0.1:7881/
echo     后端界面：                 http://127.0.0.1:7870/
echo.
echo     酒馆里不用改任何设置，默认就指向本机 7881。
echo.
echo     本窗口会自动关闭，服务在后台继续运行（各自有自己的窗口）。
echo     要关闭服务请双击「停止全部.cmd」。
echo.
REM 成功路径刻意不暂停：这里没有要用户抄的地址，窗口应当自动关掉。
REM 两种模式共用这段流程，只有"要不要打开浏览器"不同：
REM   · 启动工作台 -> 打开浏览器，那本身就是"启动成功"的信号
REM   · 启动后端   -> 不打开。只用酒馆插件、不看工作台页面的人用这个
REM 后端与侧车都是用 start 另开的窗口，本窗口关掉不影响它们。
if defined MV_OPEN start "" "http://127.0.0.1:7881/"
exit /b 0


REM ===========================================================================
REM  模式：局域网（手机 / 平板）
REM ===========================================================================
:mode_lan
echo ============================================================
echo    月声 · 启动局域网服务
echo ============================================================
echo.
call :precheck
if errorlevel 1 exit /b 1
call :ensure_backend
if errorlevel 1 exit /b 1
call :ensure_firewall
call :ensure_sidecar 0.0.0.0
if errorlevel 1 exit /b 1
call :lan_ip
echo.
echo   ============================================================
echo     可以用了
echo   ============================================================
echo.
if not defined LANIP (
    echo     [警告] 没有检测到局域网地址，请确认已连上 WiFi 或网线。
    echo.
    pause
    exit /b 1
)
echo     同一 WiFi 下的其它设备（手机 / 平板 / 另一台电脑）可以：
echo.
echo       用浏览器打开工作台：
echo         http://%LANIP%:7881/
echo.
echo       或者调用这几个接口（给程序用）：
echo         http://%LANIP%:7881/tts
echo         http://%LANIP%:7881/voices
echo         http://%LANIP%:7881/api/v1/scene_audios
echo         http://%LANIP%:7881/health
echo.
echo     注意：
echo       · 其它设备和这台电脑必须在同一个 WiFi / 局域网下
echo       · 本机地址由路由器分配，可能变化；变了就重新跑一次本文件
echo       · 后端(7870)仍然只监听本机，没有对外暴露
echo       · 工作台没有鉴权，同网段的人都能用；想收回就双击 启动webui.cmd
echo.
echo     本窗口可以关闭，服务会在后台继续运行。
echo     要关闭服务请双击「停止全部.cmd」。
echo.
pause
exit /b 0


REM ===========================================================================
REM  模式：放行防火墙（单独用；用户在 UAC 点了「否」之后可以再来一次）
REM ===========================================================================
:mode_firewall
echo ============================================================
echo    月声 · 放行防火墙 7881
echo ============================================================
echo.
call :ensure_firewall
echo.
pause
exit /b 0


REM ===========================================================================
REM  模式：停止
REM ===========================================================================
:mode_stop
echo ============================================================
echo    月声 · 停止服务
echo ============================================================
echo.
echo   正在停止工作台服务 ...
call :stop_sidecar
echo   正在停止后端 ...
taskkill /F /IM audiocpp_server.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul
set "R1="
set "R2="
call :port_up 7881
if defined OK set "R1=1"
call :port_up 7870
if defined OK set "R2=1"
echo.
if defined R1 echo   [警告] 7881 仍在监听
if defined R2 echo   [警告] 7870 仍在监听
if not defined R1 if not defined R2 echo   已全部停止 [OK]
echo.
REM 停干净了就自动关窗；只有真没停掉时才留下窗口 —— 上面那两行警告是用户唯一
REM 能看出"没停干净"的地方，窗口一闪而过等于把警告吞掉了。
if defined R1 goto stop_hold
if defined R2 goto stop_hold
exit /b 0
:stop_hold
pause
exit /b 0
