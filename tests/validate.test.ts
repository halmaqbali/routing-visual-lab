import { describe, expect, it } from 'vitest';
import { addStatic, staticRoute, threeRouter } from '../src/model/samples';
import { addLink, addDevice } from '../src/model/topology';
import { validateTopology } from '../src/model/validate';

const errors = (t: Parameters<typeof validateTopology>[0]) => validateTopology(t).filter((i) => i.severity === 'error').map((i) => i.message);

describe('configuration validation', () => {
  it('sample topology is valid', () => {
    expect(errors(threeRouter())).toEqual([]);
  });
  it('detects duplicate addresses', () => {
    const t = threeRouter();
    t.devices.find((d) => d.id === 'r3')!.ifaces[0].ip = '10.0.12.1';
    expect(errors(t).join('\n')).toMatch(/Duplicate address 10.0.12.1/);
  });
  it('detects incompatible link subnets', () => {
    const t = threeRouter();
    t.devices.find((d) => d.id === 'r2')!.ifaces[0].ip = '10.0.99.2';
    expect(errors(t).join('\n')).toMatch(/not in the same subnet/);
  });
  it('detects invalid addresses and prefixes', () => {
    const t = threeRouter();
    t.devices.find((d) => d.id === 'r1')!.ifaces[0].ip = '10.0.300.1';
    t.devices.find((d) => d.id === 'r3')!.ifaces[1].prefix = 33;
    const e = errors(t).join('\n');
    expect(e).toMatch(/not a valid IPv4 address/);
    expect(e).toMatch(/Prefix \/33/);
  });
  it('detects wrong network prefix and invalid next hops in static routes', () => {
    let t = addStatic(threeRouter(), 'R1', staticRoute('192.168.3.5', 24, '10.0.12.2'));
    expect(errors(t).join('\n')).toMatch(/network address is 192.168.3.0\/24/);
    t = addStatic(threeRouter(), 'R1', staticRoute('192.168.3.0', 24, '10.0.12.1'));
    expect(errors(t).join('\n')).toMatch(/own address/);
    t = addStatic(threeRouter(), 'R1', staticRoute('192.168.3.0', 24, '10.0.12.400'));
    expect(errors(t).join('\n')).toMatch(/not a valid IPv4/);
  });
  it('detects a gateway outside the PC subnet', () => {
    const t = threeRouter();
    t.devices.find((d) => d.id === 'pc1')!.gateway = '192.168.3.1';
    expect(errors(t).join('\n')).toMatch(/not in its own subnet/);
  });
  it('auto-addresses new links', () => {
    let t = threeRouter();
    const r = addDevice(t, 'router', 0, 0);
    t = r.topo;
    const res = addLink(t, 'r2', r.id);
    expect(res.error).toBeUndefined();
    expect(errors(res.topo)).toEqual([]);
    const r4 = res.topo.devices.find((d) => d.id === r.id)!;
    expect(r4.name).toBe('R4');
    expect(r4.ifaces[0].ip).toBe('10.0.24.4');
    const p = addDevice(res.topo, 'pc', 0, 0);
    const res2 = addLink(p.topo, r.id, p.id);
    const pc = res2.topo.devices.find((d) => d.id === p.id)!;
    expect(pc.ifaces[0].ip).toBe('192.168.4.10');
    expect(pc.gateway).toBe('192.168.4.1');
  });
});
