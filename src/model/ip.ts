// IPv4 helpers. Addresses are handled as unsigned 32-bit numbers internally.

export function parseIp(text: string): number | null {
  const s = text.trim();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const part = m[i];
    if (part.length > 1 && part.startsWith('0')) return null; // no leading zeros
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

export function isValidIp(text: string): boolean {
  return parseIp(text) !== null;
}

export function formatIp(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

export function isValidPrefix(len: number): boolean {
  return Number.isInteger(len) && len >= 0 && len <= 32;
}

export function maskOf(len: number): number {
  return len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
}

export function maskString(len: number): string {
  return formatIp(maskOf(len));
}

/** Network address of ip/len, as a dotted string. */
export function networkOf(ip: string, len: number): string {
  const n = parseIp(ip);
  if (n === null) return '';
  return formatIp((n & maskOf(len)) >>> 0);
}

export function broadcastOf(ip: string, len: number): string {
  const n = parseIp(ip);
  if (n === null) return '';
  return formatIp((n | ~maskOf(len)) >>> 0);
}

/** True when `ip` falls inside network/len. */
export function inSubnet(ip: string, network: string, len: number): boolean {
  const a = parseIp(ip);
  const b = parseIp(network);
  if (a === null || b === null) return false;
  const m = maskOf(len);
  return ((a & m) >>> 0) === ((b & m) >>> 0);
}

/** True when network has no host bits set for the prefix length. */
export function isNetworkAddress(network: string, len: number): boolean {
  const n = parseIp(network);
  if (n === null) return false;
  return ((n & maskOf(len)) >>> 0) === n;
}

export function cidr(network: string, len: number): string {
  return `${network}/${len}`;
}

/** Usable host check for interface addresses (not network/broadcast for /0-/30). */
export function hostAddressProblem(ip: string, len: number): string | null {
  if (len >= 31) return null;
  if (networkOf(ip, len) === ip) return `${ip} is the network address of ${cidr(networkOf(ip, len), len)}, so it cannot be used by an interface.`;
  if (broadcastOf(ip, len) === ip) return `${ip} is the broadcast address of ${cidr(networkOf(ip, len), len)}, so it cannot be used by an interface.`;
  return null;
}

export function compareIp(a: string, b: string): number {
  return (parseIp(a) ?? 0) - (parseIp(b) ?? 0);
}
