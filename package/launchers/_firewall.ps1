# 放行防火墙 7881（仅限本局域网），由 启动局域网服务.cmd 自动提权调用。
#
# 之所以单独放一个 .ps1：本文件路径全为 ASCII，提权重启时不必把可能含中文的
# 路径塞进命令行，从根本上避免编码问题。

$ErrorActionPreference = 'Stop'
$Rule = 'MoonVoice-LAN-7881'

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    Write-Host ''
    Write-Host '需要管理员权限，正在弹出 UAC 窗口 ...' -ForegroundColor Yellow
    Write-Host ''
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath
    )
    exit 0
}

Write-Host ''
Write-Host '============================================================'
Write-Host '   放行防火墙：TCP 7881（只允许同一局域网访问）'
Write-Host '============================================================'
Write-Host ''

$old = Get-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue
if ($old) {
    $old | Remove-NetFirewallRule
    Write-Host '已删除同名旧规则。' -ForegroundColor DarkGray
}

New-NetFirewallRule -DisplayName $Rule `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 7881 `
    -RemoteAddress LocalSubnet `
    -Profile Any `
    -Description 'MoonVoice sidecar - LAN only' | Out-Null

$rule = Get-NetFirewallRule -DisplayName $Rule
$port = $rule | Get-NetFirewallPortFilter
$addr = $rule | Get-NetFirewallAddressFilter

Write-Host '已放行：' -ForegroundColor Green
Write-Host ("  端口 {0}   来源 {1}   配置 {2}" -f $port.LocalPort, $addr.RemoteAddress, $rule.Profile)
Write-Host ''
Write-Host '含义：同一 WiFi 下的设备可以访问 7881，公网和其它网段进不来。' -ForegroundColor Green
Write-Host ''
Start-Sleep -Seconds 3
