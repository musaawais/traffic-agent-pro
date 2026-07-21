/**
 * Free VPN Manager
 *
 * Fetches fresh, working free proxy servers for USA, UK, and Canada from
 * public proxy APIs. Tests each proxy with a TCP socket before using it.
 * When connected, applies the proxy to session.defaultSession so both the
 * regular browser tabs AND the agent engine use the chosen country's IP.
 *
 * No signup, no API key, no paid subscription required.
 */

import { session as electronSession } from 'electron';
import https from 'https';
import net from 'net';

export interface FreeProxy {
  host: string;
  port: number;
  protocol: 'http' | 'socks5';
  countryCode: string;
}

export interface VpnState {
  enabled: boolean;
  countryCode: string;
  countryName: string;
  currentProxy: FreeProxy | null;
  fetching: boolean;
  error: string | null;
}

const COUNTRY_NAMES: Record<string, string> = {
  US: '🇺🇸 United States',
  GB: '🇬🇧 United Kingdom',
  CA: '🇨🇦 Canada',
  DE: '🇩🇪 Germany',
  FR: '🇫🇷 France',
  NL: '🇳🇱 Netherlands',
  AU: '🇦🇺 Australia',
  JP: '🇯🇵 Japan',
};

export class FreeVpnManager {
  private state: VpnState = {
    enabled: false, countryCode: '', countryName: '',
    currentProxy: null, fetching: false, error: null,
  };

  private onStateChangeCb: ((s: VpnState) => void) | null = null;

  onStateChange(cb: (s: VpnState) => void) { this.onStateChangeCb = cb; }
  getState(): VpnState { return { ...this.state }; }

  /** Returns the proxy rules string if VPN is active, else null. */
  getProxyRules(): string | null {
    if (!this.state.enabled || !this.state.currentProxy) return null;
    return buildRules(this.state.currentProxy);
  }

  // ── Connect ─────────────────────────────────────────────────────────────────

  async connect(countryCode: string): Promise<void> {
    this.state = { ...this.state, fetching: true, error: null };
    this.emit();

    try {
      const proxies = await fetchFreeProxies(countryCode);

      if (proxies.length === 0) {
        throw new Error(`No free proxies available for ${COUNTRY_NAMES[countryCode] ?? countryCode}. Try again in a moment.`);
      }

      // Test up to 20 proxies in parallel, pick first that responds
      const working = await findWorking(proxies.slice(0, 20));

      if (!working) {
        throw new Error('All fetched proxies are offline right now. Try again — free proxy pools refresh every few minutes.');
      }

      await electronSession.defaultSession.setProxy({ proxyRules: buildRules(working) });

      this.state = {
        enabled: true,
        countryCode,
        countryName: COUNTRY_NAMES[countryCode] ?? countryCode,
        currentProxy: working,
        fetching: false,
        error: null,
      };
      this.emit();

    } catch (err) {
      this.state = { ...this.state, fetching: false, error: (err as Error).message };
      this.emit();
    }
  }

  // ── Reconnect (rotate to next working proxy) ─────────────────────────────

  async reconnect(): Promise<void> {
    if (!this.state.enabled) return;
    await this.connect(this.state.countryCode);
  }

  // ── Disconnect ───────────────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    await (electronSession.defaultSession.setProxy as any)({ mode: 'system' });
    this.state = { enabled: false, countryCode: '', countryName: '', currentProxy: null, fetching: false, error: null };
    this.emit();
  }

  private emit() { this.onStateChangeCb?.(this.state); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildRules(p: FreeProxy): string {
  return p.protocol === 'socks5'
    ? `socks5://${p.host}:${p.port}`
    : `http://${p.host}:${p.port}`;
}

/** TCP connect test — much faster than loading a full URL */
function testProxy(proxy: FreeProxy, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

async function findWorking(proxies: FreeProxy[]): Promise<FreeProxy | null> {
  const results = await Promise.all(proxies.map(async (p) => ({ p, ok: await testProxy(p) })));
  return results.find((r) => r.ok)?.p ?? null;
}

/** Fetch from two free public proxy APIs, merge results */
async function fetchFreeProxies(countryCode: string): Promise<FreeProxy[]> {
  const results = await Promise.allSettled([
    fetchGeonode(countryCode),
    fetchProxyscrape(countryCode),
  ]);

  const all: FreeProxy[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  // Deduplicate by host:port
  const seen = new Set<string>();
  return all.filter((p) => {
    const key = `${p.host}:${p.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** https://proxylist.geonode.com — completely free, no auth */
async function fetchGeonode(countryCode: string): Promise<FreeProxy[]> {
  const url =
    `https://proxylist.geonode.com/api/proxy-list?limit=100&page=1` +
    `&sort_by=lastChecked&sort_type=desc` +
    `&country=${countryCode}&filterUpTime=60`;
  try {
    const data = await fetchJson(url);
    return ((data as any).data || [])
      .map((p: any): FreeProxy | null => {
        if (!p.ip || !p.port) return null;
        const protocols: string[] = p.protocols || ['http'];
        const protocol = protocols.includes('socks5') ? 'socks5' : 'http';
        return { host: p.ip, port: parseInt(p.port), protocol, countryCode };
      })
      .filter(Boolean) as FreeProxy[];
  } catch {
    return [];
  }
}

/** https://proxyscrape.com — free API */
async function fetchProxyscrape(countryCode: string): Promise<FreeProxy[]> {
  const url =
    `https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies` +
    `&country=${countryCode.toLowerCase()}` +
    `&protocol=http,socks5&timeout=5000&proxy_format=protocolipport&format=json`;
  try {
    const data = await fetchJson(url);
    return ((data as any).proxies || [])
      .map((entry: any): FreeProxy | null => {
        const raw: string = entry.proxy || '';
        // format: protocol://host:port
        const m = raw.match(/^(https?|socks5?):\/\/([^:]+):(\d+)/i);
        if (!m) return null;
        return {
          host: m[2],
          port: parseInt(m[3]),
          protocol: m[1].toLowerCase().startsWith('socks') ? 'socks5' : 'http',
          countryCode,
        };
      })
      .filter(Boolean) as FreeProxy[];
  } catch {
    return [];
  }
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 12_000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { reject(new Error('Non-JSON response from proxy API')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Proxy API timed out')); });
  });
}
