// Share links without a server: the whole lab is compressed and stored in the link's #fragment.
// The fragment is never sent to the web server, so nothing is uploaded or stored anywhere else.
import { parseLab, type Lab, type ParseResult } from './lab';

const PREFIX = '#lab=';

function toB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const canCompress = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

/** Encode a lab as a share fragment: "z." + deflate (when supported) or "j." + plain JSON, base64url. */
export async function encodeLab(lab: Lab): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ ...lab, sim: undefined }));
  if (canCompress()) return `z.${toB64url(await pipe(json, new CompressionStream('deflate-raw')))}`;
  return `j.${toB64url(json)}`;
}

export async function decodeLab(code: string): Promise<ParseResult> {
  try {
    const [kind, data] = [code.slice(0, 2), code.slice(2)];
    let bytes = fromB64url(data);
    if (kind === 'z.') {
      if (!canCompress()) return { ok: false, errors: ['This browser cannot decompress share links. Ask for the lab file instead.'] };
      bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    } else if (kind !== 'j.') return { ok: false, errors: ['This share link is not valid.'] };
    return parseLab(JSON.parse(new TextDecoder().decode(bytes)), 'Shared lab');
  } catch {
    return { ok: false, errors: ['This share link is damaged or incomplete (was it cut off when copying?).'] };
  }
}

export async function shareLink(lab: Lab, base: string): Promise<string> {
  return `${base.split('#')[0]}${PREFIX}${await encodeLab(lab)}`;
}

/** The lab code in a URL hash, if present. */
export function labCodeFromHash(hash: string): string | null {
  return hash.startsWith(PREFIX) ? hash.slice(PREFIX.length) : null;
}

/** QR codes hold at most ~2,900 bytes; longer links must be shared as a file or a copied link. */
export const QR_MAX_CHARS = 2800;
