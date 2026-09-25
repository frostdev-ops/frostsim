// EC2 Spot client and provider (CLAUDE.md D14): Query API requests, the tag extractors, pool fallback and error handling, against a
// fake fetch. No AWS call is made.

import { describe, expect, it } from 'vitest';
import { ec2, ec2Provider, tags, vcpus, type Ec2Limits } from './ec2';

const NOW = new Date('2026-09-25T12:00:00Z');
const LIMITS: Ec2Limits = {
  region: 'us-east-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', ami: 'ami-1', securityGroup: 'sg-1',
  subnets: new Map([['us-east-1a', 'subnet-a'], ['us-east-1b', 'subnet-b']]), types: ['c8a.4xlarge', 'c8a.16xlarge'], maxVcpu: 64,
};
const xml = (body: string) => new Response(`<?xml version="1.0"?><R xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">${body}</R>`);
const error = (code: string, status = 400) =>
  new Response(`<Response><Errors><Error><Code>${code}</Code><Message>echo of AKIDEXAMPLE</Message></Error></Errors></Response>`, { status });
const price = (type: string, zone: string, usd: string, ts = '2026-09-25T11:00:00.000Z') =>
  `<item><instanceType>${type}</instanceType><productDescription>Linux/UNIX</productDescription><spotPrice>${usd}</spotPrice><timestamp>${ts}</timestamp><availabilityZone>${zone}</availabilityZone></item>`;

function fake(reply: (form: URLSearchParams) => Response) {
  const calls: { form: URLSearchParams; auth: string | null; url: string }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const form = new URLSearchParams(await req.text());
    calls.push({ form, auth: req.headers.get('authorization'), url: req.url });
    return reply(form);
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('helpers', () => {
  it('reads vCPU from x86 size names only', () => {
    expect([vcpus('c8a.large'), vcpus('c8a.xlarge'), vcpus('c7a.4xlarge'), vcpus('c8a.16xlarge'), vcpus('c7i.48xlarge')]).toEqual([2, 4, 16, 64, 192]);
    expect([vcpus('c8a.metal-48xl'), vcpus('nope'), vcpus('c8a.16xlarge ')]).toEqual([0, 0, 0]);
  });

  it('extracts flat tags in order', () => {
    expect(tags('<a><instanceId>i-1</instanceId><x/><instanceId>i-2</instanceId></a>', 'instanceId')).toEqual(['i-1', 'i-2']);
  });
});

describe('ec2 client', () => {
  it('signs a form POST to the regional endpoint and keeps the newest Linux price per type and zone', async () => {
    const { fetchFn, calls } = fake(() => xml(`<spotPriceHistorySet>${price('c8a.4xlarge', 'us-east-1a', '0.3000', '2026-09-25T10:00:00.000Z')}${price('c8a.4xlarge', 'us-east-1a', '0.2800')}${price('c8a.16xlarge', 'us-east-1b', '1.0500')}</spotPriceHistorySet><nextToken/>`));
    expect(await ec2(LIMITS, fetchFn).spotPrices(LIMITS.types, NOW)).toEqual([
      { type: 'c8a.4xlarge', zone: 'us-east-1a', usd: 0.28 }, { type: 'c8a.16xlarge', zone: 'us-east-1b', usd: 1.05 },
    ]);
    expect(calls[0].url).toBe('https://ec2.us-east-1.amazonaws.com/');
    expect(calls[0].auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ec2\/aws4_request/);
    expect(Object.fromEntries(calls[0].form)).toMatchObject({ Action: 'DescribeSpotPriceHistory', Version: '2016-11-15',
      'ProductDescription.1': 'Linux/UNIX', 'InstanceType.1': 'c8a.4xlarge', 'InstanceType.2': 'c8a.16xlarge', StartTime: NOW.toISOString() });
  });

  it('launches one tagged, IMDSv2, terminate-on-interruption Spot instance with a max price and the user data', async () => {
    const { fetchFn, calls } = fake(() => xml('<instancesSet><item><instanceId>i-0abc</instanceId></item></instancesSet>'));
    const id = await ec2(LIMITS, fetchFn).runSpot({ type: 'c8a.16xlarge', subnet: 'subnet-b', maxPrice: '1.2600', name: 'frostsim-worker-x', userData: '#cloud-config\n' });
    expect(id).toBe('i-0abc');
    expect(Object.fromEntries(calls[0].form)).toMatchObject({
      Action: 'RunInstances', ImageId: 'ami-1', InstanceType: 'c8a.16xlarge', MinCount: '1', MaxCount: '1', SubnetId: 'subnet-b', 'SecurityGroupId.1': 'sg-1',
      'InstanceMarketOptions.MarketType': 'spot', 'InstanceMarketOptions.SpotOptions.MaxPrice': '1.2600',
      'InstanceMarketOptions.SpotOptions.InstanceInterruptionBehavior': 'terminate', InstanceInitiatedShutdownBehavior: 'terminate',
      'MetadataOptions.HttpTokens': 'required', UserData: Buffer.from('#cloud-config\n').toString('base64'),
      'TagSpecification.1.ResourceType': 'instance', 'TagSpecification.1.Tag.1.Key': 'frostsim', 'TagSpecification.1.Tag.1.Value': 'worker',
      'TagSpecification.1.Tag.2.Value': 'frostsim-worker-x', 'TagSpecification.2.ResourceType': 'volume',
    });
  });

  it('lists tagged instances across pages, and treats a missing instance as terminated', async () => {
    const { fetchFn, calls } = fake((form) => form.get('Action') === 'TerminateInstances' ? error('InvalidInstanceID.NotFound')
      : form.get('NextToken') ? xml('<reservationSet><item><instancesSet><item><instanceId>i-3</instanceId></item></instancesSet></item></reservationSet>')
        : xml('<reservationSet><item><instancesSet><item><instanceId>i-1</instanceId></item><item><instanceId>i-2</instanceId></item></instancesSet></item></reservationSet><nextToken>t2</nextToken>'));
    const api = ec2(LIMITS, fetchFn);
    expect(await api.workerInstances()).toEqual(['i-1', 'i-2', 'i-3']);
    expect(calls[0].form.get('Filter.1.Name')).toBe('tag:frostsim');
    await expect(api.terminate('i-9')).resolves.toBeUndefined();
  });

  it('reports only the error code, never the body', async () => {
    const { fetchFn } = fake(() => error('UnauthorizedOperation', 403));
    await expect(ec2(LIMITS, fetchFn).terminate('i-1')).rejects.toThrow(/^ec2 TerminateInstances failed with status 403 \(UnauthorizedOperation\)$/);
  });
});

describe('ec2Provider', () => {
  const prices = `<spotPriceHistorySet>${price('c8a.16xlarge', 'us-east-1a', '1.0000')}${price('c8a.16xlarge', 'us-east-1b', '0.9000')}${price('c8a.16xlarge', 'us-east-1c', '0.1000')}${price('c8a.4xlarge', 'us-east-1a', '0.3000')}</spotPriceHistorySet>`;

  it('offers configured zones only, cheapest first, with a 20% max price over the quote plus IPv4 and disk', async () => {
    const { fetchFn, calls } = fake(() => xml(prices));
    const provider = ec2Provider(LIMITS, fetchFn);
    const offers = await provider.offers(NOW);
    expect(offers.map((o) => [o.size, o.zone, o.cores])).toEqual([['c8a.4xlarge', 'us-east-1a', 16], ['c8a.16xlarge', 'us-east-1b', 64], ['c8a.16xlarge', 'us-east-1a', 64]]);
    expect(offers[1]).toMatchObject({ hourlyUsd: 0.906, maxHourlyUsd: 1.086, billing: 'second' });
    await provider.offers(new Date(NOW.getTime() + 60_000));
    // Cached across providers too: the autoscaler builds a new one every tick.
    await ec2Provider(LIMITS, fetchFn).offers(new Date(NOW.getTime() + 120_000));
    expect(calls).toHaveLength(1);
  });

  it('falls back to the next pool of the same size when AWS has no capacity, and stops on any other error', async () => {
    const { fetchFn } = fake(() => xml(prices));
    const offers = await ec2Provider(LIMITS, fetchFn).offers(NOW);
    const big = offers.filter((o) => o.cores === 64);
    let runs: URLSearchParams[] = [];
    const run = (first: string) => fake((form) => { runs.push(form); return runs.length === 1 ? error(first) : xml('<instanceId>i-2</instanceId>'); });

    const capacity = run('InsufficientInstanceCapacity');
    expect(await ec2Provider(LIMITS, capacity.fetchFn).create(big, { name: 'n', userData: 'u' })).toEqual({ id: 'i-2', offer: big[1] });
    expect(runs.map((f) => [f.get('SubnetId'), f.get('InstanceMarketOptions.SpotOptions.MaxPrice')])).toEqual([['subnet-b', '1.0800'], ['subnet-a', '1.2000']]);

    // The pool that had no capacity is left out of offers for a while, for every provider built from now on.
    const later = (await ec2Provider(LIMITS, fake(() => xml(prices)).fetchFn).offers(NOW)).filter((o) => o.cores === 64);
    expect(later.map((o) => `${o.size}@${o.zone}`)).toEqual(['c8a.16xlarge@us-east-1a']);

    runs = [];
    const quota = run('MaxSpotInstanceCountExceeded');
    await expect(ec2Provider(LIMITS, quota.fetchFn).create(big, { name: 'n', userData: 'u' })).rejects.toThrow(/MaxSpotInstanceCountExceeded/);
    expect(runs).toHaveLength(1);
  });
});
