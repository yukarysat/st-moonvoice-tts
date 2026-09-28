# 启动脚本用到的探测动作。每次输出恰好一行（或 ASCII 字段），供 .cmd 读取。
#
#       -Action checkpath      ->  OK / BAD
#       -Action sidecarmode    ->  none / 127.0.0.1 / 0.0.0.0
#       -Action lanip          ->  本机局域网 IPv4（找不到则空行）
#       -Action pickmodel      ->  OK;<名字>;<需要MiB>;<显卡MiB>;<档位数>;<提示>
#                                  NOMODEL / NOCONFIG / BAD;<文件名> / WRITEFAIL
#
# 字段分隔符必须是 ; 而不是 |：cmd 会把整个 if(...) 块**先解析完再执行**，
# 值里的 | 在解析期就会被当成管道运算符，导致那个块即使不执行也报"命令语法不正确"。
# 这个坑踩过一次（有模型时的启动路径整个挂掉，无模型路径却正常）。
#
# 为什么放在独立的 .ps1 而不写进 .cmd 的内联 -Command：
#   1) PowerShell 不允许对 if 语句做管道（if (...) {...} | Set-Content 是语法错误），
#      写内联时极易踩中，而且错误会被 >nul 2>&1 吞掉，表现为"静默得到空结果"。
#   2) cmd 会吃掉双引号参数里的 ^，正则里的 ^ 锚点、[^...] 取反都会因此走样。
#   3) 路径通过环境变量传入（MOONVOICE_ROOT），避免中文路径经命令行转换。
#
# pickmodel 的输出刻意**只用 ASCII 字段**，中文由 .cmd 那边拼：
# PowerShell 重定向到文件时的编码取决于控制台代码页，让中文穿过这层容易变乱码。

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

function Get-ModelPick {
    # 挑一个模型用，并把路径写进 backend\server.json。
    #
    # 为什么按"文件大小 + 250 MiB"估算显存，而不是写死一张档位表：
    # 实测六档的净峰值都落在「文件 + 236~290 MiB」区间，这条规律对用户自己
    # 量化出来的、或从别处拿来的文件同样成立，不用维护白名单。
    $root = $env:MOONVOICE_ROOT
    if (-not $root) { return 'NOMODEL' }
    $backend = Join-Path $root 'backend'
    $cfgPath = Join-Path $backend 'server.json'
    if (-not (Test-Path -LiteralPath $cfgPath)) { return 'NOCONFIG' }

    $files = @(Get-ChildItem -LiteralPath (Join-Path $backend 'models') -Recurse -Filter '*.gguf' -File |
               Sort-Object Length -Descending)
    if ($files.Count -eq 0) { return 'NOMODEL' }

    # 校验 GGUF 文件头：下载不完整或被改名的文件，后端只会报一句看不懂的错
    foreach ($f in $files) {
        $ok = $false
        try {
            $fs = [IO.File]::OpenRead($f.FullName)
            $buf = New-Object byte[] 4
            $n = $fs.Read($buf, 0, 4)
            $fs.Close()
            $ok = ($n -eq 4 -and [Text.Encoding]::ASCII.GetString($buf) -eq 'GGUF')
        } catch { $ok = $false }
        if (-not $ok) { return ('BAD;' + $f.Name) }
    }

    $need = @{}
    foreach ($f in $files) { $need[$f.FullName] = [int]($f.Length / 1MB) + 250 }

    $total = 0
    $smi = & nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null
    if ($smi) {
        $first = @($smi)[0]
        if ("$first" -match '(\d+)') { $total = [int]$Matches[1] }
    }

    # files 已按体积降序 = 质量降序，所以第一个装得下的就是最好的选择
    $pick = $null
    $warn = ''
    if ($total -gt 0) {
        $usable = $total - 1000          # 给桌面留的余量
        foreach ($f in $files) {
            if ($need[$f.FullName] -le $usable) { $pick = $f; break }
        }
        if (-not $pick) { $pick = $files[-1]; $warn = 'tight' }
    } else {
        $pick = $files[0]
        $warn = 'nogpu'
    }

    $rel = $pick.FullName.Substring($backend.Length).TrimStart('\') -replace '\\', '/'
    $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8
    $new = ([regex]'"path"\s*:\s*"[^"]*"').Replace($cfg, '"path": "' + $rel + '"', 1)
    if ($new -eq $cfg -and $cfg -notmatch [regex]::Escape($rel)) { return 'WRITEFAIL' }
    if ($new -ne $cfg) {
        try { [IO.File]::WriteAllText($cfgPath, $new, (New-Object Text.UTF8Encoding($false))) }
        catch { return 'WRITEFAIL' }
    }

    return ('OK;' + $pick.BaseName + ';' + $need[$pick.FullName] + ';' + $total + ';' + $files.Count + ';' + $warn)
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
    'pickmodel'   { Get-ModelPick }
    default       { '' }
}
