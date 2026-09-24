// Battle.net sign-in (CLAUDE.md D15, DESIGN.md C7): authorization code flow on oauth.battle.net (US/EU/APAC; CN is a separate host and
// not offered), scope openid, profile from /userinfo. Endpoints per develop.battle.net "Using OAuth" and "OAuth APIs" (ctx7, 2026-09-23).

import type { ProviderSpec } from './index';

export const battlenet: ProviderSpec = {
  id: 'battlenet',
  label: 'Battle.net',
  clientIdEnv: 'BATTLENET_CLIENT_ID',
  clientSecretEnv: 'BATTLENET_CLIENT_SECRET',
  authorizeEndpoint: 'https://oauth.battle.net/authorize',
  tokenEndpoint: 'https://oauth.battle.net/token',
  userEndpoint: 'https://oauth.battle.net/userinfo',
  scope: 'openid',
  // The docs promise "Account ID and BattleTag" without naming fields; `sub` (OIDC) is preferred, the numeric `id` is the fallback.
  user: (profile) => ({
    subject: typeof profile.sub === 'string' ? profile.sub : Number.isSafeInteger(profile.id) ? String(profile.id) : '',
    displayName: typeof profile.battletag === 'string' ? profile.battletag : '',
  }),
};
