import { describe, expect, it } from 'vitest';
import { broadcastOf, formatIp, hostAddressProblem, inSubnet, isNetworkAddress, isValidIp, maskString, networkOf, parseIp } from '../src/model/ip';

describe('IPv4 parsing and validation', () => {
  it('accepts valid dotted-decimal addresses', () => {
    expect(isValidIp('192.168.1.1')).toBe(true);
    expect(isValidIp('0.0.0.0')).toBe(true);
    expect(isValidIp('255.255.255.255')).toBe(true);
    expect(formatIp(parseIp('10.0.12.2')!)).toBe('10.0.12.2');
  });
  it('rejects invalid addresses', () => {
    for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d', '01.2.3.4', '', ' 1.2.3.-1']) expect(isValidIp(bad)).toBe(false);
  });
  it('computes masks, networks and broadcasts', () => {
    expect(maskString(24)).toBe('255.255.255.0');
    expect(maskString(30)).toBe('255.255.255.252');
    expect(maskString(0)).toBe('0.0.0.0');
    expect(networkOf('192.168.1.77', 26)).toBe('192.168.1.64');
    expect(broadcastOf('192.168.1.77', 26)).toBe('192.168.1.127');
  });
  it('matches subnets', () => {
    expect(inSubnet('10.1.2.3', '10.1.0.0', 16)).toBe(true);
    expect(inSubnet('10.2.2.3', '10.1.0.0', 16)).toBe(false);
    expect(inSubnet('8.8.8.8', '0.0.0.0', 0)).toBe(true);
    expect(inSubnet('192.168.1.130', '192.168.1.128', 25)).toBe(true);
    expect(inSubnet('192.168.1.127', '192.168.1.128', 25)).toBe(false);
  });
  it('detects host bits and unusable host addresses', () => {
    expect(isNetworkAddress('192.168.3.0', 24)).toBe(true);
    expect(isNetworkAddress('192.168.3.5', 24)).toBe(false);
    expect(hostAddressProblem('192.168.1.0', 24)).toMatch(/network address/);
    expect(hostAddressProblem('192.168.1.255', 24)).toMatch(/broadcast/);
    expect(hostAddressProblem('192.168.1.1', 24)).toBeNull();
  });
});
