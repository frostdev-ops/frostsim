// Discord sign-in (CLAUDE.md D15, DESIGN.md C7): authorization code flow, scope identify, profile from /users/@me. URLs per
// discord-api-docs topics/oauth2.mdx (authorize, token) and the account-linking guides (users/@me on v10), checked 2026-09-23.

import type { ProviderSpec } from './index';

export const discord: ProviderSpec = {
  id: 'discord',
  label: 'Discord',
  clientIdEnv: 'DISCORD_CLIENT_ID',
  clientSecretEnv: 'DISCORD_CLIENT_SECRET',
  authorizeEndpoint: 'https://discord.com/oauth2/authorize',
  tokenEndpoint: 'https://discord.com/api/oauth2/token',
  userEndpoint: 'https://discord.com/api/v10/users/@me',
  scope: 'identify',
  // `id` is the stable snowflake; `global_name` is the display name when set, else the unique username.
  user: (profile) => ({
    subject: typeof profile.id === 'string' ? profile.id : '',
    displayName: typeof profile.global_name === 'string' && profile.global_name ? profile.global_name
      : typeof profile.username === 'string' ? profile.username : '',
  }),
};
