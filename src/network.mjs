import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cacheMilliseconds = 15000;

// 只读取网卡类别、IPv4 和路由，不读取 MAC、SSID、DNS、凭据或修改网络。
const windowsProbe = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$adapters = @(Get-NetAdapter -IncludeHidden)
$addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.AddressState -eq 'Preferred' -and -not $_.SkipAsSource })
$routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0')
$ipInterfaces = @(Get-NetIPInterface -AddressFamily IPv4)
$items = @($adapters | ForEach-Object {
  $adapter = $_
  $ipInterface = $ipInterfaces | Where-Object { $_.InterfaceIndex -eq $adapter.ifIndex } | Select-Object -First 1
  $defaults = @($routes | Where-Object { $_.InterfaceIndex -eq $adapter.ifIndex } | ForEach-Object {
    @{ gateway = [string]$_.NextHop; routeMetric = [int]$_.RouteMetric }
  })
  @{ index = [int]$adapter.ifIndex; name = [string]$adapter.Name
     description = [string]$adapter.InterfaceDescription; status = [string]$adapter.Status
     hardware = [bool]$adapter.HardwareInterface; virtual = [bool]$adapter.Virtual
     medium = [int]$adapter.NdisPhysicalMedium
     addresses = @($addresses | Where-Object { $_.InterfaceIndex -eq $adapter.ifIndex } | ForEach-Object { [string]$_.IPAddress })
     defaults = $defaults
     metric = $(if ($null -ne $ipInterface) { [int]$ipInterface.InterfaceMetric } else { $null }) }
})
@{ interfaces = $items } | ConvertTo-Json -Depth 5 -Compress
`;

function usableIpv4(address) {
  if (typeof address !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) return false;
  const parts = address.split('.').map(Number);
  return parts.every(part => part >= 0 && part <= 255)
    && parts[0] > 0 && parts[0] < 224 && parts[0] !== 127
    && !(parts[0] === 169 && parts[1] === 254)
    && !(parts[0] === 198 && (parts[1] === 18 || parts[1] === 19));
}

export function localIpv4Addresses(interfaces = networkInterfaces()) {
  return [...new Set(Object.values(interfaces).flat()
    .filter(item => item && (item.family === 'IPv4' || item.family === 4) && !item.internal)
    .map(item => item.address).filter(usableIpv4))];
}

function metric(value) {
  return Number.isFinite(value) && value >= 0 ? value : 100000;
}

function label(adapter) {
  const kind = [1, 9].includes(adapter.medium) ? 'Wi-Fi' : adapter.medium === 14 ? '有线网络' : '局域网';
  const name = typeof adapter.name === 'string' ? adapter.name.slice(0, 80) : '';
  return { kind, label: kind + (name ? ' · ' + name : '') };
}

function sortCandidates(left, right) {
  return Number(right.hasGateway) - Number(left.hasGateway)
    || left.priority - right.priority || left.index - right.index || left.address.localeCompare(right.address);
}

/** 推荐必须有 Windows 的真实网卡证据，名称或 IP 所在网段不能单独充当证据。 */
export function selectPhoneNetwork(probe, interfaces = networkInterfaces()) {
  const present = new Set(localIpv4Addresses(interfaces));
  const physical = [];
  const advanced = [];
  for (const adapter of Array.isArray(probe?.interfaces) ? probe.interfaces : []) {
    if (adapter?.status !== 'Up' || !Number.isInteger(adapter.index)) continue;
    const isPhysical = adapter.hardware === true && adapter.virtual === false;
    const isAdvanced = !isPhysical && /Wi-Fi Direct Virtual|Hyper-V|vEthernet/i.test(String(adapter.description || '') + ' ' + String(adapter.name || ''));
    if (!isPhysical && !isAdvanced) continue;
    const defaults = (Array.isArray(adapter.defaults) ? adapter.defaults : [])
      .filter(route => usableIpv4(route?.gateway));
    const priority = defaults.length ? Math.min(...defaults.map(route => metric(route.routeMetric) + metric(adapter.metric))) : metric(adapter.metric);
    const details = label(adapter);
    for (const address of Array.isArray(adapter.addresses) ? adapter.addresses : []) {
      if (!present.has(address)) continue;
      const candidate = { address, index: adapter.index, ...details, hasGateway: defaults.length > 0, priority };
      if (isPhysical) physical.push(candidate);
      else advanced.push({ ...candidate, kind: 'advanced', label: '虚拟／热点网络' + (adapter.name ? ' · ' + String(adapter.name).slice(0, 80) : '') });
    }
  }
  physical.sort(sortCandidates);
  advanced.sort(sortCandidates);
  const seen = new Set();
  const unique = values => values.filter(value => !seen.has(value.address) && seen.add(value.address));
  const candidates = unique(physical);
  const [recommended = null, ...others] = candidates;
  return {
    status: recommended ? 'ready' : 'no-network', recommended, others, advanced: unique(advanced),
    message: recommended
      ? recommended.hasGateway ? '用下面这个地址打开手机页。手机和电脑要连同一个 Wi-Fi 或局域网。'
        : '找到了电脑的局域网地址，但这个网络没有默认网关。手机需连接同一网络；能否打开还取决于网络设置。'
      : '暂时没有找到已连接的 Wi-Fi 或有线网络。连上网络后，再点“刷新地址”。',
  };
}

export async function discoverWindowsNetwork({signal} = {}) {
  // 使用系统 PowerShell，避免 PATH 中第三方同名程序；启动时不显示控制台窗口。
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(windowsProbe, 'utf16le').toString('base64');
  const { stdout } = await execute(executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, encoding: 'utf8', timeout: 9000, maxBuffer: 256 * 1024, signal });
  const value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (!Array.isArray(value?.interfaces)) throw new Error('网卡信息暂时无法读取。');
  return value;
}

export class PhoneNetwork {
  constructor({ discover = discoverWindowsNetwork, interfaces = networkInterfaces, now = Date.now, platform = process.platform } = {}) {
    this.discover = discover;
    this.interfaces = interfaces;
    this.now = now;
    this.platform = platform;
    this.probe = null;
    this.checkedAt = null;
    this.pending = null;
    this.failed = false;
    this.closed = false;
    this.controller = null;
  }

  async refresh({ force = false } = {}) {
    if (this.closed) return this.read();
    if (this.pending) return this.pending;
    if (!force && this.checkedAt !== null && this.now() - this.checkedAt < cacheMilliseconds) return this.read();
    this.pending = Promise.resolve().then(async () => {
      try {
        if (this.closed) return this.read();
        if (this.platform !== 'win32') throw new Error('网卡类别未知。');
        this.controller = new AbortController();
        this.probe = await this.discover({signal: this.controller.signal});
        this.failed = false;
      } catch {
        // 不沿用旧配对地址冒充可用网络，也不把虚拟网卡作为自动推荐。
        this.probe = null;
        this.failed = true;
      } finally {
        this.checkedAt = this.now();
        this.pending = null;
        this.controller = null;
      }
      return this.read();
    });
    return this.pending;
  }

  read() {
    if (this.probe) return { ...selectPhoneNetwork(this.probe, this.interfaces()), checkedAt: this.checkedAt };
    return {
      status: this.failed ? 'unavailable' : 'checking', recommended: null, others: [], advanced: [], checkedAt: this.checkedAt,
      message: this.failed ? '暂时读不到网卡信息，无法确定手机该用哪个地址。请点“刷新地址”重试；仍不成功时，可以在问题反馈里告诉我。'
        : '正在寻找电脑连接的 Wi-Fi 或有线网络。',
    };
  }

  stop() {
    this.closed = true;
    this.controller?.abort();
  }
}
