@echo off
chcp 936 >nul
title 月声 · 放行防火墙
if not exist "%~dp0_moonvoice.cmd" (
    echo.
    echo   [错误] 找不到 _moonvoice.cmd
    echo.
    echo   请确认整合包解压完整，并且这几个启动文件都在同一个文件夹里。
    echo   如果你是从压缩包里直接双击的，请先完整解压出来再运行。
    echo.
    pause
    exit /b 1
)
call "%~dp0_moonvoice.cmd" firewall
exit /b %errorlevel%
