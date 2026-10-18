// Configuration model (what the student configures). Learned routing state lives in the engine.

export type DeviceKind = 'router' | 'pc' | 'switch';

export interface Iface {
  id: string;
  name: string; // e.g. G0/0/0, eth0, LoopBack0 or Port 1
  ip: string; // '' when not configured (always '' on switch ports)
  prefix: number;
  /** Loopback interfaces are virtual: always up, never attached to a link. */
  kind?: 'loopback';
  /** Optional fixed MAC address; otherwise a stable one is derived from the ids. */
  mac?: string;
}

export interface StaticRoute {
  id: string;
  network: string;
  prefix: number;
  nextHop: string; // '' when only an exit interface is given
  iface?: string; // optional exit interface id
  ad: number; // administrative distance (Cisco-style, static default = 1)
  enabled: boolean;
}

export interface Device {
  id: string;
  kind: DeviceKind;
  name: string;
  x: number;
  y: number;
  ifaces: Iface[];
  gateway?: string; // PCs only
  staticRoutes: StaticRoute[]; // routers only
}

export interface LinkEnd {
  dev: string;
  iface: string;
}

export interface Link {
  id: string;
  a: LinkEnd;
  b: LinkEnd;
  cost: number;
  up: boolean;
}

export interface Topology {
  devices: Device[];
  links: Link[];
}

export type Mode = 'static' | 'dv' | 'ls';
export type Level = 'beginner' | 'advanced';

export interface DvOptions {
  profile: 'generic' | 'rip';
  splitHorizon: boolean;
  poisonReverse: boolean;
  triggeredUpdates: boolean;
  /** Infinity for the generic profile. RIP always uses 16. */
  genericInfinity: number;
}

export interface SimOptions {
  dv: DvOptions;
  ttl: number;
}

export const DEFAULT_OPTIONS: SimOptions = {
  dv: { profile: 'generic', splitHorizon: true, poisonReverse: false, triggeredUpdates: true, genericInfinity: 100 },
  ttl: 16,
};

export const RIP_INFINITY = 16;
export const RIP_UPDATE_INTERVAL = 30;
