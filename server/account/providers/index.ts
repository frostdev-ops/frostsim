// OAuth sign-in providers (CLAUDE.md D15, DESIGN.md C7): each provider file is data (endpoints, scope, env names, profile mapping);
// this file turns it into the C7 module shape and holds the Map. A Loothing provider later is one more file plus its env keys.
// Provider tokens are used once for the profile call and discarded (A9).
//
// PKCE: both providers get code_challenge (S256) and code_verifier. Neither provider's web OAuth2 page documents PKCE (Discord's
// Social SDK does); RFC 6749 §3.1/§3.2 require servers to ignore unknown parameters, so sending them is harmless where unsupported.
// The client secret and the state check protect the flow either way.

import type { Config, EnvName } from '../config';
import { battlenet } from './battlenet';
import { discord } from './discord';

export interface ProviderUser {
  subject: string;
  displayName: string;
}

export interface Provider {
  id: string;
  label: string;
  configured(config: Config): boolean;
  authorizeUrl(config: Config, args: { state: string; codeChallenge: string; redirectUri: string }): string;
  /** Throws on any provider failure; the message carries a status at most, never a response body. */
  exchange(config: Config, args: { code: string; codeVerifier: string; redirectUri: string }, fetchFn: typeof fetch): Promise<ProviderUser>;
}

export interface ProviderSpec {
  id: string;
  label: string;
  clientIdEnv: EnvName;
  clientSecretEnv: EnvName;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  userEndpoint: string;
  scope: string;
  /** Maps the profile JSON; an empty subject means the profile was unusable. */
  user(profile: Record<string, unknown>): ProviderUser;
}

const TIMEOUT_MS = 10_000;
const MAX_NAME = 64;
/** Characters a shown name must not carry: controls, and invisible ones that reorder or hide text (bidi marks, embeddings, overrides
 *  and isolates, zero-width space, word joiner, BOM), which let one name pass for another. ZWJ and ZWNJ stay: emoji and some scripts
 *  need them. */
export const HIDDEN_CHAR = /[\p{Cc}\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;

export function provider(spec: ProviderSpec): Provider {
  const credentials = (config: Config) => ({ id: config.env[spec.clientIdEnv] ?? '', secret: config.env[spec.clientSecretEnv] ?? '' });
  return {
    id: spec.id,
    label: spec.label,
    configured: (config) => Boolean(config.env[spec.clientIdEnv] && config.env[spec.clientSecretEnv]),
    authorizeUrl(config, { state, codeChallenge, redirectUri }) {
      const url = new URL(spec.authorizeEndpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: credentials(config).id,
        scope: spec.scope,
        state,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },
    async exchange(config, { code, codeVerifier, redirectUri }, fetchFn) {
      const { id, secret } = credentials(config);
      const token = await call(fetchFn, spec.tokenEndpoint, 'token', {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier }),
      });
      if (typeof token.access_token !== 'string' || !token.access_token) throw new Error(`${spec.id} token answer has no access_token`);
      const profile = await call(fetchFn, spec.userEndpoint, 'profile', {
        headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' },
      });
      const user = spec.user(profile);
      if (!user.subject || user.subject.length > 128) throw new Error(`${spec.id} profile has no usable subject`);
      return { subject: user.subject, displayName: cleanName(user.displayName) || `${spec.label} user` };
    },
  };
}

async function call(fetchFn: typeof fetch, url: string, step: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    // The body may echo the code or a token: never read it.
    await res.body?.cancel();
    throw new Error(`${step} request failed with status ${res.status}`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new Error(`${step} answer is not a JSON object`);
  return body as Record<string, unknown>;
}

/** Provider names are shown in our UI: no HIDDEN_CHAR, at most 64 code points. */
function cleanName(name: string): string {
  return [...name.replace(new RegExp(HIDDEN_CHAR.source, 'gu'), '').trim()].slice(0, MAX_NAME).join('').trim();
}

export const PROVIDERS: ReadonlyMap<string, Provider> = new Map([battlenet, discord].map((spec) => [spec.id, provider(spec)]));
