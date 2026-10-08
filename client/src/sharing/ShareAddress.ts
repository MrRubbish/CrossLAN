export function getShareAddressOptions(currentHref: string, serverIps: readonly string[] = []): string[] {
  let page: URL;
  try {
    page = new URL(currentHref);
  } catch {
    return [];
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return [];

  const addresses = new Set<string>();
  // The origin already used by this device is preferable to a different NIC.
  if (isShareableHost(page.hostname)) addresses.add(new URL('/', page.origin).toString());
  for (const value of serverIps) {
    const host = value.trim();
    if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host) || !isShareableHost(host)) continue;
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    try {
      const address = new URL(`${page.protocol}//${authority}${page.port ? `:${page.port}` : ''}/`);
      if (isShareableHost(address.hostname)) addresses.add(address.toString());
    } catch {
      // Ignore an invalid advertised address instead of sharing localhost.
    }
  }
  return [...addresses];
}

function isShareableHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '::' || host === '::1') return false;
  if (/^fe[89ab]/.test(host) && host.includes(':')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const octets = host.split('.').map(Number);
    return octets.every(octet => octet <= 255) && octets[0] !== 0 && octets[0] !== 127
      && octets[0] < 224 && !(octets[0] === 169 && octets[1] === 254);
  }
  return true;
}
