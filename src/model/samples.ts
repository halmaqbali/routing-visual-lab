import type { Device, StaticRoute, Topology } from './types';

type RouterSpec = [name: string, x: number, y: number];
type LinkSpec = [a: string, aIp: string, b: string, bIp: string, prefix: number, cost?: number];

/** Build a topology from compact specs. Device ids are the lowercase names. */
export function buildTopology(devs: { routers: RouterSpec[]; pcs: RouterSpec[]; links: LinkSpec[]; switches?: RouterSpec[]; loopbacks?: [router: string, ip: string, prefix: number][] }): Topology {
  const devices: Device[] = [
    ...devs.routers.map(([name, x, y]) => ({ id: name.toLowerCase(), kind: 'router' as const, name, x, y, ifaces: [], staticRoutes: [] })),
    ...devs.pcs.map(([name, x, y]) => ({ id: name.toLowerCase(), kind: 'pc' as const, name, x, y, ifaces: [], staticRoutes: [], gateway: '' })),
    ...(devs.switches ?? []).map(([name, x, y]) => ({ id: name.toLowerCase(), kind: 'switch' as const, name, x, y, ifaces: [], staticRoutes: [] })),
  ];
  const byName = (n: string) => devices.find((d) => d.name === n)!;
  const links = devs.links.map(([an, aIp, bn, bIp, prefix, cost], k) => {
    const ends = [
      [byName(an), aIp],
      [byName(bn), bIp],
    ] as const;
    const ids = ends.map(([d, ip]) => {
      const n = d.ifaces.length;
      const name = d.kind === 'pc' ? `eth${n}` : d.kind === 'switch' ? `Port ${n + 1}` : `G0/0/${n}`;
      const id = d.kind === 'pc' ? `${d.id}-eth${n}` : d.kind === 'switch' ? `${d.id}-p${n + 1}` : `${d.id}-g${n}`;
      d.ifaces.push({ id, name, ip: d.kind === 'switch' ? '' : ip, prefix });
      return id;
    });
    // PCs use the router side of their link as the default gateway.
    if (ends[0][0].kind === 'pc' && ends[1][0].kind === 'router') ends[0][0].gateway = bIp;
    if (ends[1][0].kind === 'pc' && ends[0][0].kind === 'router') ends[1][0].gateway = aIp;
    return { id: `l${k + 1}`, a: { dev: ends[0][0].id, iface: ids[0] }, b: { dev: ends[1][0].id, iface: ids[1] }, cost: cost ?? 1, up: true };
  });
  for (const [r, ip, prefix] of devs.loopbacks ?? []) {
    const d = byName(r);
    const n = d.ifaces.filter((i) => i.kind === 'loopback').length;
    d.ifaces.push({ id: `${d.id}-lo${n}`, name: `LoopBack${n}`, ip, prefix, kind: 'loopback' });
  }
  return { devices, links };
}

/** R1 — R2 — R3 with a loopback on each router (router-to-router ping example). */
export function loopbackLine(): Topology {
  return buildTopology({
    routers: [['R1', 170, 200], ['R2', 420, 200], ['R3', 670, 200]],
    pcs: [],
    links: [
      ['R1', '10.0.12.1', 'R2', '10.0.12.2', 24],
      ['R2', '10.0.23.2', 'R3', '10.0.23.3', 24],
    ],
    loopbacks: [['R1', '10.0.1.1', 24], ['R2', '10.0.2.2', 24], ['R3', '10.0.3.3', 24]],
  });
}

/** Two routers; R1's LAN has a switch with two PCs, R2's LAN has one PC. */
export function switchedLan(): Topology {
  const t = buildTopology({
    routers: [['R1', 300, 140], ['R2', 600, 140]],
    switches: [['SW1', 300, 300]],
    pcs: [['PC1', 170, 420], ['PC2', 430, 420], ['PC3', 600, 330]],
    links: [
      ['R1', '10.0.12.1', 'R2', '10.0.12.2', 24],
      ['R1', '192.168.1.1', 'SW1', '', 24],
      ['SW1', '', 'PC1', '192.168.1.10', 24],
      ['SW1', '', 'PC2', '192.168.1.11', 24],
      ['R2', '192.168.2.1', 'PC3', '192.168.2.10', 24],
    ],
  });
  for (const pc of ['pc1', 'pc2']) t.devices.find((d) => d.id === pc)!.gateway = '192.168.1.1';
  return t;
}

export function threeRouter(): Topology {
  return buildTopology({
    routers: [
      ['R1', 170, 180],
      ['R2', 420, 180],
      ['R3', 670, 180],
    ],
    pcs: [
      ['PC1', 170, 360],
      ['PC2', 670, 360],
    ],
    links: [
      ['R1', '10.0.12.1', 'R2', '10.0.12.2', 24],
      ['R2', '10.0.23.2', 'R3', '10.0.23.3', 24],
      ['R1', '192.168.1.1', 'PC1', '192.168.1.10', 24],
      ['R3', '192.168.3.1', 'PC2', '192.168.3.10', 24],
    ],
  });
}

/** Five routers with two alternative paths between PC1 and PC2. */
export function fiveRouter(): Topology {
  return buildTopology({
    routers: [
      ['R1', 140, 200],
      ['R2', 400, 80],
      ['R3', 660, 200],
      ['R4', 270, 360],
      ['R5', 530, 360],
    ],
    pcs: [
      ['PC1', 60, 360],
      ['PC2', 760, 360],
    ],
    links: [
      ['R1', '10.0.12.1', 'R2', '10.0.12.2', 24, 2],
      ['R2', '10.0.23.2', 'R3', '10.0.23.3', 24, 5],
      ['R1', '10.0.14.1', 'R4', '10.0.14.4', 24, 1],
      ['R4', '10.0.45.4', 'R5', '10.0.45.5', 24, 1],
      ['R5', '10.0.35.5', 'R3', '10.0.35.3', 24, 1],
      ['R2', '10.0.25.2', 'R5', '10.0.25.5', 24, 3],
      ['R1', '192.168.1.1', 'PC1', '192.168.1.10', 24],
      ['R3', '192.168.3.1', 'PC2', '192.168.3.10', 24],
    ],
  });
}

/** Triangle used for distance-vector "better path" examples. */
export function triangle(): Topology {
  return buildTopology({
    routers: [
      ['R1', 170, 260],
      ['R2', 420, 90],
      ['R3', 670, 260],
    ],
    pcs: [
      ['PC1', 170, 420],
      ['PC2', 670, 420],
    ],
    links: [
      ['R1', '10.0.12.1', 'R2', '10.0.12.2', 24, 1],
      ['R2', '10.0.23.2', 'R3', '10.0.23.3', 24, 1],
      ['R1', '10.0.13.1', 'R3', '10.0.13.3', 24, 5],
      ['R1', '192.168.1.1', 'PC1', '192.168.1.10', 24],
      ['R3', '192.168.3.1', 'PC2', '192.168.3.10', 24],
    ],
  });
}

let routeCounter = 0;
export function staticRoute(network: string, prefix: number, nextHop: string, ad = 1, iface?: string): StaticRoute {
  routeCounter++;
  return { id: `s${routeCounter}-${network}-${prefix}-${nextHop}`, network, prefix, nextHop, ad, enabled: true, iface };
}

export function addStatic(topo: Topology, routerName: string, ...routes: StaticRoute[]): Topology {
  const t = structuredClone(topo);
  const d = t.devices.find((x) => x.name === routerName);
  if (d) d.staticRoutes.push(...routes);
  return t;
}
