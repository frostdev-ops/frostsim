// Account-server config (CLAUDE.md D15, DESIGN.md C3): defaults, feature parsing, fatal problems, per-feature credentials, names-only report.

import { describe, expect, it } from 'vitest';
import { configured, envReport, loadConfig } from './config';

describe('loadConfig', () => {
  it('defaults to everything off on loopback with no problems', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ host: '127.0.0.1', port: 3012, publicOrigin: 'https://sim.frostdev.io', adminOnly: false, problems: [] });
    expect([...config.features]).toEqual([]);
    expect(config.env.R2_ENGINES_BUCKET).toBe('frostsim-engines');
  });

  it('parses features, admin lists and the origin', () => {
    const config = loadConfig({
      FEATURES: ' accounts, billing ', PUBLIC_ORIGIN: 'http://localhost:5173/', ADMIN_ONLY: '1',
      ADMIN_IDENTITIES: 'battlenet:1, discord:2', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32),
    });
    expect([...config.features]).toEqual(['accounts', 'billing']);
    expect(config.publicOrigin).toBe('http://localhost:5173');
    expect(config.adminOnly).toBe(true);
    expect([...config.adminIdentities]).toEqual(['battlenet:1', 'discord:2']);
    expect(config.problems).toEqual([]);
  });

  it('makes a typo, a missing database or a short secret fatal once anything is enabled', () => {
    expect(loadConfig({ FEATURES: 'account' }).problems[0]).toContain('unknown feature "account"');
    expect(loadConfig({ FEATURES: 'accounts' }).problems).toEqual([
      'DATABASE_URL is required when any feature is enabled',
      'SESSION_SECRET is required when any feature is enabled',
    ]);
    expect(loadConfig({ FEATURES: 'accounts', DATABASE_URL: 'x', SESSION_SECRET: 'short' }).problems).toEqual([
      'SESSION_SECRET must be at least 32 bytes',
    ]);
    expect(loadConfig({ PUBLIC_ORIGIN: 'not a url', FROSTSIM_ACCOUNT_PORT: '99999' }).problems).toHaveLength(2);
  });

  it('accepts only an https origin, or http on loopback', () => {
    for (const origin of ['localhost:5173', 'http://sim.frostdev.io', 'ftp://sim.frostdev.io', 'javascript:alert(1)']) {
      const config = loadConfig({ PUBLIC_ORIGIN: origin });
      expect(config.problems.join()).toMatch(/PUBLIC_ORIGIN/);
      expect(config.publicOrigin).toBe('');
    }
    for (const origin of ['https://staging.frostdev.io', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://[::1]:5173']) {
      expect(loadConfig({ PUBLIC_ORIGIN: origin }).problems).toEqual([]);
    }
  });

  it('knows which credentials each feature needs', () => {
    expect(configured(loadConfig({}), 'accounts')).toBe(true);
    expect(configured(loadConfig({}), 'billing')).toBe(false);
    expect(configured(loadConfig({ STRIPE_SECRET_KEY: 'a', STRIPE_WEBHOOK_SECRET: 'b' }), 'billing')).toBe(true);
    expect(configured(loadConfig({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b' }), 'shares')).toBe(false);
  });
});

describe('envReport', () => {
  it('lists names only, and a default is not "present"', () => {
    const report = envReport({ SESSION_SECRET: 'hunter2hunter2', STRIPE_SECRET_KEY: ' ', OTHER: 'x' });
    expect(report.present).toEqual(['SESSION_SECRET']);
    expect(report.missing).toContain('PUBLIC_ORIGIN');
    expect(report.missing).toContain('STRIPE_SECRET_KEY');
    expect(envReport({ ENGINE_INDEX_PATH: '/opt/x.json' }).present).toEqual(['ENGINE_INDEX_PATH']);
    expect(envReport({}).missing).toEqual(expect.arrayContaining(['ENGINE_INDEX_PATH', 'ENGINE_COMPAT']));
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });
});
