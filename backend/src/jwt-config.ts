import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';

const DEFAULT_JWT_SECRET = 'southfarm-secret-change-in-production';

// The primary secret is supplied by the runtime, never generated per process.
// A development fallback keeps local builds usable; the Windows launcher
// requires the persistent user-level secret before starting production.
const configuredPrimarySecret = String(
  process.env.JWT_SECRET || process.env.SOUTHFARM_JWT_SECRET || '',
).trim();

export const JWT_SECRET = configuredPrimarySecret || DEFAULT_JWT_SECRET;

const configuredLegacySecrets = String(
  process.env.SOUTHFARM_JWT_LEGACY_SECRETS || '',
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

// Keep the former auth.ts fallback available for local recovery when no
// explicit legacy list is configured. Production receives its list from the
// persistent Windows environment so old sessions survive the migration.
const fallbackLegacySecrets = configuredPrimarySecret
  ? []
  : ['southfarm-secret-change-in-production-2026'];

const verificationSecrets = [
  JWT_SECRET,
  ...configuredLegacySecrets,
  ...fallbackLegacySecrets,
].filter((secret, index, values) => values.indexOf(secret) === index);

const configuredAccessTokenTtl = String(
  process.env.SOUTHFARM_ACCESS_TOKEN_TTL || '15m',
).trim();

// Access tokens are intentionally short-lived. Long-lived continuity is
// provided by the hashed, rotating refresh-session records in the database.
// This keeps a stolen access token from becoming a permanent workspace key.
export const ACCESS_TOKEN_TTL: SignOptions['expiresIn'] = configuredAccessTokenTtl as SignOptions['expiresIn'];

export type SouthFarmJwtPayload = JwtPayload & { userId: number };

export function signSouthFarmJwt(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

export function verifySouthFarmJwt(token: string): SouthFarmJwtPayload {
  let lastError: unknown;
  for (const secret of verificationSecrets) {
    try {
      const payload = jwt.verify(token, secret);
      if (typeof payload === 'string' || typeof payload.userId !== 'number') {
        throw new Error('Invalid JWT payload');
      }
      return payload as SouthFarmJwtPayload;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Invalid token');
}
