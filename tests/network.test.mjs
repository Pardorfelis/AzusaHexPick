import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneNetwork, localIpv4Addresses, selectPhoneNetwork } from '../src/network.mjs';

const addresses = (...values) => ({ adapter: values.map(address => ({ family: 'IPv4', internal: false, address })) });
const adapter = (index, address, patch = {}) => ({
  index, name: 'WLAN', description: 'Realtek Wi-Fi NIC', status: 'Up', hardware: true, virtual: false,
  medium: 9, addresses: [address], metric: 45,
  defaults: [{gateway: '10.194.0.1', routeMetric: 0}], ...patch,
});

test('手机只推荐真实 Wi-Fi，VPN 默认路由更低和 VMware IP 都不造成选择困难', () => {
  const current = addresses('198.18.0.1', '192.168.202.1', '192.168.220.1', '10.194.213.200');
  const result = selectPhoneNetwork({interfaces: [
    adapter(38, '198.18.0.1', {name: 'VPN', description: 'VPN Tunnel', hardware: false, virtual: true, metric: 0}),
    adapter(8, '192.168.202.1', {description: 'VMware Virtual Ethernet Adapter', hardware: false, virtual: true}),
    adapter(5, '192.168.220.1', {description: 'VMware Virtual Ethernet Adapter', hardware: false, virtual: true}),
    adapter(21, '10.194.213.200'),
  ]}, current);
  assert.equal(result.recommended.address, '10.194.213.200');
  assert.equal(result.recommended.kind, 'Wi-Fi');
  assert.deepEqual(result.others, []);
  assert.deepEqual(result.advanced, []);
});

test('网卡重命名不改变物理证据，TAP 不会因为 Virtual=false 被推荐', () => {
  const result = selectPhoneNetwork({interfaces: [
    adapter(1, '192.168.1.8', {name: 'VPN 这个名字是我改的'}),
    adapter(2, '192.168.2.8', {description: 'TAP-Win32 Adapter', hardware: false, virtual: false, metric: 0}),
  ]}, addresses('192.168.1.8', '192.168.2.8'));
  assert.equal(result.recommended.address, '192.168.1.8');
  assert.deepEqual(result.others, []);
});

test('双真实网卡按默认路由与接口合计优先级排序，另一项保留在折叠列表', () => {
  const result = selectPhoneNetwork({interfaces: [
    adapter(10, '10.0.0.2', {metric: 20, defaults: [{gateway: '10.0.0.1', routeMetric: 10}]}),
    adapter(11, '192.168.0.2', {name: 'Ethernet', medium: 14, metric: 40,
      defaults: [{gateway: '192.168.0.1', routeMetric: 1}]}),
  ]}, addresses('10.0.0.2', '192.168.0.2'));
  assert.equal(result.recommended.address, '10.0.0.2');
  assert.equal(result.others[0].address, '192.168.0.2');
  assert.equal(result.others[0].kind, '有线网络');
});

test('无互联网默认网关仍可提供真实局域网地址，但明确连接条件', () => {
  const result = selectPhoneNetwork({interfaces: [adapter(1, '192.168.50.2', {defaults: []})]}, addresses('192.168.50.2'));
  assert.equal(result.status, 'ready');
  assert.equal(result.recommended.hasGateway, false);
  assert.ok(result.message.includes('没有默认网关'));
});

test('已断开网卡、APIPA、回环、基准测试及无效 IP 不进入手机推荐', () => {
  const result = selectPhoneNetwork({interfaces: [
    adapter(1, '192.168.1.2', {status: 'Disconnected'}),
    adapter(2, '169.254.1.2'), adapter(3, '127.0.0.1'), adapter(4, '198.18.0.1'),
    adapter(5, '999.1.1.1'), adapter(6, '224.1.1.1'),
  ]}, addresses('192.168.1.2', '169.254.1.2', '127.0.0.1', '198.18.0.1', '999.1.1.1', '224.1.1.1'));
  assert.equal(result.status, 'no-network');
  assert.equal(result.recommended, null);
});

test('更换网络后，旧探测结果不能显示已不存在的旧 IP', () => {
  const result = selectPhoneNetwork({interfaces: [adapter(1, '192.168.1.2')]}, addresses('192.168.2.3'));
  assert.equal(result.recommended, null);
  assert.deepEqual(result.others, []);
});

test('Hyper-V 和手机热点只放在高级候选，不把它们误认为已验证的物理网络', () => {
  const result = selectPhoneNetwork({interfaces: [
    adapter(3, '172.16.0.1', {name: 'vEthernet', description: 'Hyper-V Virtual Ethernet Adapter', hardware: false, virtual: true}),
    adapter(4, '192.168.137.1', {description: 'Microsoft Wi-Fi Direct Virtual Adapter', hardware: false, virtual: true}),
  ]}, addresses('172.16.0.1', '192.168.137.1'));
  assert.equal(result.recommended, null);
  assert.equal(result.advanced.length, 2);
  assert.ok(result.advanced.every(value => value.kind === 'advanced'));
});

test('本机 IPv4 清单去重并兼容数值 family，但不接受内部网卡', () => {
  const current = addresses('192.168.1.2', '192.168.1.2');
  current.other = [{family: 4, internal: false, address: '10.0.0.2'},
    {family: 'IPv4', internal: true, address: '10.0.0.3'}, {family: 'IPv6', internal: false, address: '::1'}];
  assert.deepEqual(localIpv4Addresses(current), ['192.168.1.2', '10.0.0.2']);
});

test('网卡缓存合并并发探测，普通健康读取不等待网络发现', async () => {
  let complete;
  let calls = 0;
  let clock = 10;
  const network = new PhoneNetwork({platform: 'win32', interfaces: () => addresses('192.168.1.2'), now: () => clock,
    discover: () => { calls += 1; return new Promise(resolve => { complete = resolve; }); }});
  const first = network.refresh();
  const second = network.refresh({force: true});
  assert.equal(network.read().status, 'checking');
  await Promise.resolve();
  assert.equal(calls, 1);
  complete({interfaces: [adapter(1, '192.168.1.2')]});
  assert.equal((await first).recommended.address, '192.168.1.2');
  assert.equal((await second).recommended.address, '192.168.1.2');
  clock += 5000;
  await network.refresh();
  assert.equal(calls, 1);
  const forced = network.refresh({force: true});
  await Promise.resolve();
  assert.equal(calls, 2);
  complete({interfaces: [adapter(1, '192.168.1.2')]});
  await forced;
});

test('刷新失败撤掉旧推荐并给恢复方式，不暴露进程错误或私人路径', async () => {
  let fail = false;
  const network = new PhoneNetwork({platform: 'win32', interfaces: () => addresses('192.168.1.2'),
    discover: async () => { if (fail) throw new Error('C:\\private\\profile access denied'); return {interfaces: [adapter(1, '192.168.1.2')]}; }});
  assert.equal((await network.refresh()).status, 'ready');
  fail = true;
  const result = await network.refresh({force: true});
  assert.equal(result.status, 'unavailable');
  assert.equal(result.recommended, null);
  assert.ok(result.message.includes('刷新地址'));
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('CLI 未知平台不把 Node 枚举的虚拟 IP 当成有效手机链接', async () => {
  let calls = 0;
  const network = new PhoneNetwork({platform: 'linux', interfaces: () => addresses('10.0.0.1'),
    discover: async () => { calls += 1; return {interfaces: []}; }});
  const result = await network.refresh();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.recommended, null);
  assert.equal(calls, 0);
  assert.equal(network.pending, null);
  await network.refresh({force: true});
  assert.equal(network.pending, null);
});

test('退出服务会中止尚未完成的网卡探测，不再启动后台探测子进程', async () => {
  let aborted = false;
  let calls = 0;
  const network = new PhoneNetwork({platform: 'win32', interfaces: () => addresses('10.0.0.2'),
    discover: ({signal}) => {
      calls += 1;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('探测已中止。'));
      }, {once: true}));
    }});
  const active = network.refresh();
  await Promise.resolve();
  network.stop();
  await active;
  assert.equal(aborted, true);
  await network.refresh({force: true});
  assert.equal(calls, 1);
  const unopened = new PhoneNetwork({platform: 'win32', discover: async () => { calls += 1; return {interfaces: []}; }});
  const queued = unopened.refresh();
  unopened.stop();
  await queued;
  assert.equal(calls, 1);
});
