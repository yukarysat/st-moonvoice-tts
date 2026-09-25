# 检查 7881 是否已被入站放行。输出恰好一行：no / yes / yes-any
#
# 刻意不按规则名判断：用户机器上可能已有别的程序（或本包的历史版本）放行了
# 7881，那条规则同样有效。按名字判断会导致重复添加，还会白弹一次 UAC。
#
# yes      = 存在启用的入站允许规则覆盖 TCP 7881，且来源有范围限制
# yes-any  = 存在，但来源是 Any（任何网络都能访问，偏宽松）
# no       = 没有

$ErrorActionPreference = 'SilentlyContinue'

function Test-Covers([string]$lp) {
    if ($lp -eq '7881') { return $true }
    if ($lp -match '^(\d+)-(\d+)$') {
        return ([int]$Matches[1] -le 7881 -and [int]$Matches[2] -ge 7881)
    }
    return $false
}

$found = $false
$scopeAny = $false

# 从「规则」出发，而不是从 Get-NetFirewallPortFilter 出发 ——
# 后者不带管线输入时的行为不可靠（实测会枚举为空，于是永远误判成"未放行"）。
# -Enabled True 交给 cmdlet 过滤，避免拿枚举值和字符串比较。
foreach ($r in Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True) {
    $pf = $r | Get-NetFirewallPortFilter
    if (-not $pf) { continue }

    $proto = [string]$pf.Protocol
    if ($proto -ne 'TCP' -and $proto -ne '6') { continue }

    $covers = $false
    foreach ($one in @($pf.LocalPort)) {
        if (Test-Covers ([string]$one)) { $covers = $true; break }
    }
    if (-not $covers) { continue }

    $found = $true
    $af = $r | Get-NetFirewallAddressFilter
    $addr = @($af.RemoteAddress)
    if ($addr.Count -eq 0 -or ($addr -contains 'Any')) { $scopeAny = $true }
}

if (-not $found) { 'no' }
elseif ($scopeAny) { 'yes-any' }
else { 'yes' }
