import { describe, expect, it } from 'vitest';
import { hcloud, hetznerProvider } from './hetzner';

const NOW = new Date('2026-10-18T12:00:00Z');
const limits = { token: 'project-a', location: 'fsn1', snapshot: '1', serverType: 'cpx62', max: 2 };

function provider(currency: string | undefined, gross = '0.2452', ipv6 = '0.0000', token = 'project-a') {
  const fetchFn = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/pricing') return Response.json({ pricing: { currency, primary_ips: [
      { type: 'ipv4', prices: [{ location: 'fsn1', price_hourly: { net: '0.0008', gross: '0.0010' } }] },
      { type: 'ipv6', prices: [{ location: 'fsn1', price_hourly: { net: ipv6, gross: ipv6 } }] },
    ] } });
    if (path === '/v1/server_types') return Response.json({ server_types: [{ name: 'cpx62', cores: 16,
      prices: [{ location: 'fsn1', price_hourly: { net: gross, gross } }] }] });
    throw new Error(`unexpected fake provider path ${path}`);
  }) as typeof fetch;
  return hetznerProvider({ ...limits, token }, 1.17, fetchFn);
}

describe('Hetzner provider currency', () => {
  it('accepts the actual USD quote that omits free Primary IPv6 pricing', async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/pricing') return Response.json({ pricing: { currency: 'USD', primary_ips: [
        { type: 'ipv4', prices: [{ location: 'nbg1', price_hourly: { net: '0.0010000000', gross: '0.0010000000000000' } }] },
      ] } });
      if (path === '/v1/server_types') return Response.json({ server_types: [{ name: 'cpx62', cores: 16,
        prices: [{ location: 'nbg1', price_hourly: { net: '0.2452000000', gross: '0.2452000000000000' } }] }] });
      throw new Error(`unexpected fake provider path ${path}`);
    }) as typeof fetch;
    const [quote] = await hetznerProvider({ ...limits, location: 'nbg1' }, 1.17, fetchFn).offers(NOW);
    expect(quote).toMatchObject({ size: 'cpx62', cores: 16, hourlyUsd: 0.2452, maxHourlyUsd: 0.2452 });
  });

  it('refuses malformed or incomplete inventories instead of asserting provider absence', async () => {
    for (const body of [{}, { servers: [], meta: {} },
      { servers: [{ id: 'invalid' }], meta: { pagination: { next_page: null } } },
      { servers: [], meta: { pagination: { next_page: '2' } } },
      { servers: [], meta: { pagination: { next_page: 1 } } }]) {
      const api = hcloud('fake', (async () => Response.json(body)) as typeof fetch);
      await expect(api.workerServers()).rejects.toThrow(/inventory/);
    }
  });
  it('keeps USD pricing unchanged and converts only EUR, including the IPv6 hourly extra actually provisioned', async () => {
    expect((await provider('USD').offers(NOW))[0].hourlyUsd).toBeCloseTo(0.2452, 8);
    const eur = (await provider('EUR', '0.2000', '0.0100', 'project-b').offers(NOW))[0];
    expect(eur.hourlyUsd).toBeCloseTo(0.21 * 1.17, 8);
    expect(eur.maxHourlyUsd).toBe(eur.hourlyUsd);
  });

  it('refuses unsupported or missing currencies and invalid hourly prices', async () => {
    for (const currency of ['GBP', undefined]) await expect(provider(currency).offers(NOW)).rejects.toThrow(/currency/);
    await expect(provider('USD', 'Infinity').offers(NOW)).rejects.toThrow(/price/);
    await expect(provider('USD', '0.2452', '-0.01').offers(NOW)).rejects.toThrow(/price/);
  });

  it('refuses malformed Primary IP data and explicit IPv6 quotes without a valid local price', async () => {
    for (const primaryIPs of [undefined, null, {}, [null], [{ type: 'ipv6', prices: null }], [{ type: 'ipv6', prices: [null] }],
      [{ type: 'ipv6', prices: [{ location: 'fsn1', price_hourly: { gross: '0' } }, { location: 'fsn1', price_hourly: { gross: '0.01' } }] }],
      [{ type: 'ipv6', prices: [] }], [{ type: 'ipv6', prices: [{ location: 'other', price_hourly: { gross: '0' } }] }],
      ...[null, '', 'Infinity'].map((gross) => [{ type: 'ipv6', prices: [{ location: 'fsn1', price_hourly: { gross } }] }])]) {
      const fetchFn = (async (input: RequestInfo | URL) => new URL(String(input)).pathname === '/v1/pricing'
        ? Response.json({ pricing: { currency: 'USD', primary_ips: primaryIPs } })
        : Response.json({ server_types: [{ cores: 16, prices: [{ location: 'fsn1', price_hourly: { gross: '0.2452' } }] }] })) as typeof fetch;
      await expect(hetznerProvider(limits, 1.17, fetchFn).offers(NOW)).rejects.toThrow(/pric/);
    }
  });

  it('isolates cached quotes by provider identity and currency', async () => {
    const a = provider('EUR', '0.2');
    const b = provider('USD', '0.3');
    expect((await a.offers(NOW))[0].hourlyUsd).toBeCloseTo(0.234, 8);
    expect((await b.offers(NOW))[0].hourlyUsd).toBeCloseTo(0.3, 8);
  });

  it('validates fresh IP pricing before reusing the same client cache and refreshes a changed extra', async () => {
    let primaryIPs: unknown = [{ type: 'ipv4', prices: [] }];
    let serverReads = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === '/v1/pricing') return Response.json({ pricing: { currency: 'USD', primary_ips: primaryIPs } });
      serverReads++;
      return Response.json({ server_types: [{ cores: 16, prices: [{ location: 'fsn1', price_hourly: { gross: '0.2452' } }] }] });
    }) as typeof fetch;
    const same = hetznerProvider(limits, 1.17, fetchFn);
    expect((await same.offers(NOW))[0].hourlyUsd).toBeCloseTo(0.2452, 8);
    primaryIPs = [{ type: 'ipv6', prices: [] }];
    await expect(same.offers(new Date(NOW.getTime() + 1000))).rejects.toThrow(/price/);
    primaryIPs = [{ type: 'ipv6', prices: [{ location: 'fsn1', price_hourly: { gross: '0.01' } }] }];
    expect((await same.offers(new Date(NOW.getTime() + 2000)))[0].hourlyUsd).toBeCloseTo(0.2552, 8);
    expect(serverReads).toBe(1);
    expect((await same.offers(new Date(NOW.getTime() + 3_600_000)))[0].hourlyUsd).toBeCloseTo(0.2552, 8);
    expect(serverReads).toBe(2);
  });
});
