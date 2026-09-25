# 启动脚本用到的三个探测动作。每次输出恰好一行，供 .cmd 读取。
#
#       -Action checkpath      ->  OK / BAD
#       -Action sidecarmode    ->  none / 127.0.0.1 / 0.0.0.0
#       -Action lanip          ->  本机局域网 IPv4（找不到则空行）
#
# 为什么放在独立的 .ps1 而不写进 .cmd 的内联 -Command：
#   1) PowerShell 不允许对 if 语句做管道（if (...) {...} | Set-Content 是语法错误），
#      写内联时极易踩中，而且错误会被 >nul 2>&1 吞掉，表现为"静默得到空结果"。
#   2) cmd 会吃掉双引号参数里的 ^，正则里的 ^ 锚点、[^...] 取反都会因此走样。
#   3) 路径通过环境变量传入（MOONVOICE_ROOT），避免中文路径经命令行转换。

param([string]$Action)

$ErrorActionPreference = 'SilentlyContinue'

function Get-AsciiVerdict {
    $p = $env:MOONVOICE_ROOT
    if (-not $p) { return 'BAD' }
    foreach ($ch in $p.ToCharArray()) {
        $c = [int][char]$ch
        if ($c -lt 32 -or $c -gt 126) { return 'BAD' }
    }
    return 'OK'
}

function Get-SidecarMode {
    $c = Get-NetTCPConnection -State Listen -LocalPort 7881 | Select-Object -First 1
    if (-not $c) { return 'none' }
    if ($c.LocalAddress -eq '0.0.0.0') { return '0.0.0.0' }
    if ($c.LocalAddress -eq '::') { return '0.0.0.0' }
    return '127.0.0.1'
}

function Get-LanIp {
    $all = Get-NetIPAddress -AddressFamily IPv4
    foreach ($a in $all) {
        $ip = [string]$a.IPAddress
        if ($ip -like '192.168.*') { return $ip }
        if ($ip -like '10.*') { return $ip }
        if ($ip -match '^172\.(1[6-9]|2[0-9]|3[01])\.') { return $ip }
    }
    return ''
}

switch ($Action) {
    'checkpath'   { Get-AsciiVerdict }
    'sidecarmode' { Get-SidecarMode }
    'lanip'       { Get-LanIp }
    default       { '' }
}
