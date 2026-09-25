// Account-server configuration from the environment (CLAUDE.md D15). Values never leave this module except to the code that uses them; startup prints names only.

export const FEATURES = ['accounts', 'billing', 'compute', 'shares', 'discord'] as const;
export type Feature = (typeof FEATURES)[number];

export const ENV_NAMES = [
  'FROSTSIM_ACCOUNT_HOST', 'FROSTSIM_ACCOUNT_PORT', 'PUBLIC_ORIGIN', 'FEATURES', 'ADMIN_ONLY', 'ADMIN_IDENTITIES',
  'DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET',
  'BATTLENET_CLIENT_ID', 'BATTLENET_CLIENT_SECRET',
  'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_PUBLIC_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PORTAL_CONFIGURATION',
  'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENGINES_BUCKET', 'R2_DATA_BUCKET', 'R2_ENDPOINT',
  'HCLOUD_TOKEN', 'HCLOUD_LOCATION', 'HCLOUD_SNAPSHOT_ID', 'HCLOUD_SERVER_TYPE', 'WORKER_MAX', 'WORKER_MONTHLY_EUR_CAP',
  'LOOTHING_TOKEN_SHA256', 'ENGINE_INDEX_PATH', 'ENGINE_COMPAT', 'WOW_API_ORIGIN',
] as const;
export type EnvName = (typeof ENV_NAMES)[number];

const DEFAULTS: Partial<Record<EnvName, string>> = {
  FROSTSIM_ACCOUNT_HOST: '127.0.0.1',
  FROSTSIM_ACCOUNT_PORT: '3012',
  PUBLIC_ORIGIN: 'https://sim.frostdev.io',
  R2_ENGINES_BUCKET: 'frostsim-engines',
  R2_DATA_BUCKET: 'frostsim-data',
  HCLOUD_SERVER_TYPE: 'cpx62',
  // The Battle.net proxy (server/api-server.mjs), which alone holds the Blizzard credential; /sim's Armory lookups go through it.
  WOW_API_ORIGIN: 'http://127.0.0.1:3011',
};

const R2_KEYS: EnvName[] = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Credentials a feature cannot answer without: enabled but missing -> 503 unconfigured on its routes. Finer checks belong to the owning module. */
export const FEATURE_ENV: Record<Feature, EnvName[]> = {
  accounts: [],
  billing: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  compute: R2_KEYS,
  shares: R2_KEYS,
  discord: ['DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID'],
};

export interface Config {
  host: string;
  port: number;
  /** Origin every URL, redirect and CSRF check is built from; the Host header is never trusted. */
  publicOrigin: string;
  features: ReadonlySet<Feature>;
  /** Staging: sessions exist only for admins. */
  adminOnly: boolean;
  /** `provider:subject` pairs promoted to admin on login. */
  adminIdentities: ReadonlySet<string>;
  /** Raw values with defaults applied. Read secrets from here; never log them. */
  env: Readonly<Partial<Record<EnvName, string>>>;
  /** Fatal startup problems; the entry refuses to listen while any exist. */
  problems: string[];
}

const list = (value: string | undefined): string[] => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(source: Record<string, string | undefined>): Config {
  const env: Partial<Record<EnvName, string>> = {};
  for (const name of ENV_NAMES) {
    const value = source[name]?.trim() || DEFAULTS[name];
    if (value) env[name] = value;
  }
  const problems: string[] = [];

  const features = new Set<Feature>();
  for (const name of list(env.FEATURES)) {
    if ((FEATURES as readonly string[]).includes(name)) features.add(name as Feature);
    else problems.push(`FEATURES names an unknown feature "${name}" (known: ${FEATURES.join(', ')})`);
  }

  let publicOrigin = '';
  try {
    const url = new URL(env.PUBLIC_ORIGIN!);
    // Any other scheme has the opaque origin "null", which would break every URL and let `Origin: null` pass CSRF. __Host- cookies
    // need a secure context: https, or plain http on loopback for local runs.
    if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) publicOrigin = url.origin;
    else problems.push('PUBLIC_ORIGIN must be an https:// origin (http:// only on localhost)');
  } catch {
    problems.push('PUBLIC_ORIGIN is not a URL');
  }

  const port = Number(env.FROSTSIM_ACCOUNT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) problems.push('FROSTSIM_ACCOUNT_PORT is not a port number');

  if (features.size) {
    if (!env.DATABASE_URL) problems.push('DATABASE_URL is required when any feature is enabled');
    if (!env.SESSION_SECRET) problems.push('SESSION_SECRET is required when any feature is enabled');
    else if (Buffer.byteLength(env.SESSION_SECRET) < 32) problems.push('SESSION_SECRET must be at least 32 bytes');
  }

  return {
    host: env.FROSTSIM_ACCOUNT_HOST!,
    port,
    publicOrigin,
    features,
    adminOnly: env.ADMIN_ONLY === '1',
    adminIdentities: new Set(list(env.ADMIN_IDENTITIES)),
    env,
    problems,
  };
}

/** Whether an enabled feature has the credentials it needs. */
export function configured(config: Config, feature: Feature): boolean {
  return FEATURE_ENV[feature].every((name) => Boolean(config.env[name]));
}

/** Names only, for the startup log. Defaults do not count as present. */
export function envReport(source: Record<string, string | undefined>): { present: string[]; missing: string[] } {
  const present: string[] = ENV_NAMES.filter((name) => source[name]?.trim());
  return { present, missing: ENV_NAMES.filter((name) => !present.includes(name)) };
}

/** One log line; callers never pass secrets or upstream bodies. */
export type Log = (line: string) => void;
