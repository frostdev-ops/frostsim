// EC2 Spot for compute workers (CLAUDE.md D14; DESIGN.md C8): the few Query API calls the autoscaler makes, as a fleet provider
// (fleet.ts). Signed with aws4fetch like R2; responses are XML, read with small tag extractors because each call needs a handful of
// flat fields. Error bodies are read for their <Code> only. Spot only, never on-demand. API shapes checked 2026-09-25 against the
// EC2 API Reference (RunInstances, SpotMarketOptions, DescribeSpotPriceHistory, DescribeInstances, TerminateInstances).

import { AwsClient } from 'aws4fetch';
import type { Config } from '../config';
import type { Offer, Provider } from './fleet';

const VERSION = '2016-11-15';
const TIMEOUT_MS = 15_000;
const PRICE_TTL_MS = 5 * 60_000;
/** Seconds from RunInstances to a worker's first claim (boot, cloud-init, agent start). */
const BOOT_S = 60;
/** Billed beside the instance: a public IPv4 address ($0.005/h) and the root gp3 volume (8 GB at $0.08/GB-month, about $0.001/h). */
const EXTRAS_USD_PER_HOUR = 0.006;
/** MaxPrice over the quoted Spot price. It bounds what an instance can cost (and what users are charged for it); AWS interrupts the
 *  instance rather than bill past it, and the lost job requeues unmetered. */
const MAX_PRICE_MARGIN = 1.2;
/** The Spot MaxPrice for a quoted price, in the 4 decimals EC2 takes, rounded up. */
const maxPrice = (spotUsd: number) => Math.ceil(spotUsd * MAX_PRICE_MARGIN * 1e4) / 1e4;
/** Capacity errors worth trying the next-cheapest pool for. Any other error (a quota, a bad AMI) would repeat, so it is thrown. */
const TRY_NEXT = new Set(['InsufficientInstanceCapacity', 'SpotMaxPriceTooLow', 'Unsupported', 'InsufficientFreeAddressesInSubnet']);
const MAX_POOLS = 3;
const TAG = { Key: 'frostsim', Value: 'worker' };

export interface Ec2Limits {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  ami: string;
  /** Availability zone -> subnet, from AWS_SUBNETS (`us-east-1a:subnet-0abc,...`). */
  subnets: Map<string, string>;
  securityGroup: string;
  types: string[];
  /** Spot vCPU across every live worker: the account's Spot quota. */
  maxVcpu: number;
}

/** Null unless every value EC2 needs is set. */
export function ec2Limits(config: Config): Ec2Limits | null {
  const e = config.env;
  const subnets = new Map((e.AWS_SUBNETS ?? '').split(',').map((s) => s.trim().split(':')).filter((p) => p.length === 2 && p[0] && p[1]) as [string, string][]);
  const types = (e.AWS_INSTANCE_TYPES ?? '').split(',').map((t) => t.trim()).filter((t) => vcpus(t) > 0);
  const maxVcpu = Math.floor(Number(e.AWS_MAX_VCPU));
  if (!e.AWS_REGION || !e.AWS_ACCESS_KEY_ID || !e.AWS_SECRET_ACCESS_KEY || !e.AWS_AMI_ID || !e.AWS_SECURITY_GROUP_ID
    || !subnets.size || !types.length || !(maxVcpu >= 1)) return null;
  return { region: e.AWS_REGION, accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY, ami: e.AWS_AMI_ID, subnets,
    securityGroup: e.AWS_SECURITY_GROUP_ID, types, maxVcpu };
}

/** vCPU of an x86 compute type by its size (c7a, c8a, c7i, c6a, m7a, ...: AWS's naming convention), 0 for anything else.
 *  ponytail: a name table instead of DescribeInstanceTypes, whose nested XML the tag extractors cannot read; metal is left out. */
export function vcpus(type: string): number {
  const size = /^[a-z]\d+[a-z]*\.(large|xlarge|(\d+)xlarge)$/.exec(type);
  if (!size) return 0;
  return size[1] === 'large' ? 2 : size[1] === 'xlarge' ? 4 : 4 * Number(size[2]);
}

/** Text of every `<tag>` element, in order. For flat fields only: nested `<item>` lists are never split with it. */
export const tags = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]);
/** The `<item>` bodies of a list whose items hold no nested items. */
const items = (xml: string): string[] => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

export class Ec2Error extends Error {
  constructor(readonly action: string, readonly status: number, readonly code: string) {
    super(`ec2 ${action} failed with status ${status} (${code})`);
  }
}

export function ec2(limits: Ec2Limits, fetchFn: typeof fetch) {
  // retries 0: aws4fetch's own retry loop would bypass the injected fetch.
  const aws = new AwsClient({ accessKeyId: limits.accessKeyId, secretAccessKey: limits.secretAccessKey, service: 'ec2', region: limits.region, retries: 0 });
  const endpoint = `https://ec2.${limits.region}.amazonaws.com/`;

  async function call(action: string, params: Record<string, string>): Promise<string> {
    const body = new URLSearchParams({ Action: action, Version: VERSION, ...params }).toString();
    const res = await fetchFn(await aws.sign(endpoint, {
      method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    }));
    const text = await res.text();
    if (!res.ok) throw new Ec2Error(action, res.status, tags(text, 'Code')[0]?.slice(0, 80) ?? 'unknown');
    return text;
  }

  return {
    /** The current Spot price of each type in each zone: the newest entry per pair, Linux only. */
    async spotPrices(types: string[], now: Date): Promise<{ type: string; zone: string; usd: number }[]> {
      const params: Record<string, string> = { 'ProductDescription.1': 'Linux/UNIX', StartTime: now.toISOString() };
      types.forEach((t, i) => { params[`InstanceType.${i + 1}`] = t; });
      const newest = new Map<string, { type: string; zone: string; usd: number; at: string }>();
      for (let token: string | null = null, pages = 0; pages < 10; pages++) {
        const xml = await call('DescribeSpotPriceHistory', token ? { ...params, NextToken: token } : params);
        for (const item of items(xml)) {
          const [type] = tags(item, 'instanceType'), [zone] = tags(item, 'availabilityZone'), [price] = tags(item, 'spotPrice'), [at] = tags(item, 'timestamp');
          const usd = Number(price);
          const key = `${type}@${zone}`;
          const seen = newest.get(key);
          if (type && zone && usd > 0 && (!seen || seen.at <= at)) newest.set(key, { type, zone, usd, at });
        }
        token = tags(xml, 'nextToken')[0] || null;
        if (!token) break;
      }
      return [...newest.values()].map(({ type, zone, usd }) => ({ type, zone, usd }));
    },
    /** One Spot instance, terminated (never stopped) on interruption or shutdown. Returns its instance id. */
    async runSpot(o: { type: string; subnet: string; maxPrice: string; name: string; userData: string }): Promise<string> {
      const xml = await call('RunInstances', {
        ImageId: limits.ami, InstanceType: o.type, MinCount: '1', MaxCount: '1', SubnetId: o.subnet, 'SecurityGroupId.1': limits.securityGroup,
        'InstanceMarketOptions.MarketType': 'spot',
        'InstanceMarketOptions.SpotOptions.MaxPrice': o.maxPrice,
        'InstanceMarketOptions.SpotOptions.SpotInstanceType': 'one-time',
        'InstanceMarketOptions.SpotOptions.InstanceInterruptionBehavior': 'terminate',
        InstanceInitiatedShutdownBehavior: 'terminate',
        'MetadataOptions.HttpTokens': 'required',
        UserData: Buffer.from(o.userData).toString('base64'),
        'TagSpecification.1.ResourceType': 'instance',
        'TagSpecification.1.Tag.1.Key': TAG.Key, 'TagSpecification.1.Tag.1.Value': TAG.Value,
        'TagSpecification.1.Tag.2.Key': 'Name', 'TagSpecification.1.Tag.2.Value': o.name,
        'TagSpecification.2.ResourceType': 'volume',
        'TagSpecification.2.Tag.1.Key': TAG.Key, 'TagSpecification.2.Tag.1.Value': TAG.Value,
      });
      const id = tags(xml, 'instanceId')[0];
      if (!id?.startsWith('i-')) throw new Error('ec2 RunInstances returned no instance id');
      return id;
    },
    /** Ids of every tagged worker instance that is not terminated or terminating, all pages. */
    async workerInstances(): Promise<string[]> {
      const params = {
        'Filter.1.Name': `tag:${TAG.Key}`, 'Filter.1.Value.1': TAG.Value,
        'Filter.2.Name': 'instance-state-name', 'Filter.2.Value.1': 'pending', 'Filter.2.Value.2': 'running',
        // Not shutting-down: that instance is already terminating, and listing it would have every tick terminate it again.
        'Filter.2.Value.3': 'stopping', 'Filter.2.Value.4': 'stopped',
        MaxResults: '1000',
      };
      const ids = new Set<string>();
      for (let token: string | null = null, pages = 0; pages < 10; pages++) {
        const xml = await call('DescribeInstances', token ? { ...params, NextToken: token } : params);
        for (const id of tags(xml, 'instanceId')) if (id.startsWith('i-')) ids.add(id);
        // The response's own nextToken is its last element; nested ones do not exist in DescribeInstances.
        token = tags(xml, 'nextToken').at(-1) || null;
        if (!token) break;
      }
      return [...ids];
    },
    /** An instance that no longer exists counts as terminated. */
    async terminate(id: string): Promise<void> {
      try {
        await call('TerminateInstances', { 'InstanceId.1': id });
      } catch (err) {
        if (!(err instanceof Ec2Error && err.code === 'InvalidInstanceID.NotFound')) throw err;
      }
    },
  };
}

export type Ec2 = ReturnType<typeof ec2>;

export function ec2Provider(limits: Ec2Limits, fetchFn: typeof fetch): Provider {
  const api = ec2(limits, fetchFn);
  let cache: { until: number; offers: Offer[] } | null = null;
  return {
    name: 'ec2',
    list: () => api.workerInstances(),
    /** One offer per type and configured zone, cheapest first; the expected price includes the IPv4 address and disk. */
    async offers(now) {
      if (cache && cache.until > now.getTime()) return cache.offers;
      const prices = await api.spotPrices(limits.types, now);
      const offers = prices.filter((p) => limits.subnets.has(p.zone)).map((p): Offer => ({
        provider: 'ec2', size: p.type, cores: vcpus(p.type), hourlyUsd: p.usd + EXTRAS_USD_PER_HOUR,
        maxHourlyUsd: maxPrice(p.usd) + EXTRAS_USD_PER_HOUR, billing: 'second', bootS: BOOT_S, zone: p.zone,
      })).sort((a, b) => a.hourlyUsd - b.hourlyUsd);
      cache = { until: now.getTime() + PRICE_TTL_MS, offers };
      return offers;
    },
    /** The first offer's pool, then the next-cheapest pools of the same size while AWS has no capacity, up to MAX_POOLS. */
    async create(offers, spec) {
      const [first] = offers;
      const pools = offers.filter((o) => o.provider === 'ec2' && o.cores === first.cores).slice(0, MAX_POOLS);
      let last: unknown;
      for (const offer of pools) {
        const max = (offer.maxHourlyUsd - EXTRAS_USD_PER_HOUR).toFixed(4);
        try {
          const id = await api.runSpot({ type: offer.size, subnet: limits.subnets.get(offer.zone!)!, maxPrice: max, ...spec });
          return { id, offer };
        } catch (err) {
          if (!(err instanceof Ec2Error && TRY_NEXT.has(err.code))) throw err;
          last = err;
        }
      }
      throw last ?? new Error('ec2 has no Spot offer to create');
    },
    remove: (id) => api.terminate(id),
  };
}
