import { z } from 'zod';

// Stable aliases are also encrypted state names. Do not rename them during an
// upgrade: the same app/user pair must keep its original alias.
const alias = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).refine(value => !['constructor', 'prototype', '__proto__'].includes(value));
const account = z.object({
  appId: z.string().regex(/^cli_[A-Za-z0-9]{6,128}$/),
  expectedOpenId: z.string().regex(/^ou_[A-Za-z0-9_-]{6,128}$/),
  label: z.string().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  scopes: z.array(z.string().regex(/^[a-z][a-z0-9_.:-]{0,159}$/)).min(1).max(512)
    .refine(values => values.includes('offline_access') && new Set(values).size === values.length),
  brand: z.literal('feishu').optional(),
}).strict();
const schema = z.record(alias, account).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 16);

export type AccountConfig = z.infer<typeof account>;
export type AccountsConfig = Record<string, AccountConfig>;

// Account bindings come only from instance configuration, never a source file.
export function parseAccountsConfig(raw: string): AccountsConfig {
  try {
    if (!raw || Buffer.byteLength(raw) > 48 * 1024) throw new Error();
    const parsed = JSON.parse(raw);
    const result = schema.parse(parsed);
    return result;
  } catch {
    // Validation details may contain identity or permission information.
    throw new Error('Invalid FEISHU_ACCOUNTS_JSON; see docs/deployment.md');
  }
}

export function loadAccountsConfig(env: Record<string, string | undefined> = process.env): AccountsConfig {
  return parseAccountsConfig(env.FEISHU_ACCOUNTS_JSON ?? '');
}

export function deploymentIssuer(env: Record<string, string | undefined> = process.env): string {
  const issuer = env.BRIDGE_ISSUER;
  try {
    const url = new URL(issuer!);
    if (url.protocol !== 'https:' || url.origin !== issuer || url.username || url.password) throw new Error();
    return issuer!;
  } catch {
    throw new Error('BRIDGE_ISSUER must be an explicit canonical HTTPS origin without a trailing slash');
  }
}
