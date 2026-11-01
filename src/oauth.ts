import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { Provider, errors } from 'oidc-provider';
import { importJWK, jwtVerify } from 'jose';
import { createOAuthAdapter, IDLE_SECONDS } from './oauth-state.ts';
import { deriveKey, isStateFailure, STATE_RETRY_SECONDS } from './state.ts';

const CLAUDE_CODE_CLIENT = 'https://claude.ai/oauth/claude-code-client-metadata';
const TRUSTED_CLIENT_METADATA = new Set([
  'https://chatgpt.com/oauth/client.json',
  'https://chatgpt.com/oauth/codex/client.json',
  CLAUDE_CODE_CLIENT,
]);
const SCOPES = 'lark:read lark:write';
const DISCOVERY_PATHS = new Set(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']);
const REFRESH_RETRY_SECONDS = 60;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function protectedResourceMetadata(issuer: string) {
  return { resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: SCOPES.split(' '), bearer_methods_supported: ['header'] };
}

export function passwordHash(password, salt) {
  return `${salt}:${scryptSync(password, salt, 32).toString('base64url')}`;
}

function passwordMatches(password, hash) {
  const [salt, expected] = hash.split(':');
  const actual = scryptSync(password, salt, 32);
  const decoded = Buffer.from(expected || '', 'base64url');
  return decoded.length === actual.length && timingSafeEqual(decoded, actual);
}

export function allowedRedirect(uri) {
  try {
    const url = new URL(uri);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
    return url.origin === 'https://chatgpt.com' && url.pathname === '/connector_platform_oauth_redirect';
  } catch { return false; }
}

export function makeOAuth({ issuer, master, jwks, ownerHash, state, ownerId = process.env.BRIDGE_OWNER_ID || 'owner' }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) throw new Error('invalid_owner_id');
  const secure = issuer.startsWith('https:');
  const resource = `${issuer}/mcp`;
  const Adapter = createOAuthAdapter(state);
  const csrfKey = deriveKey(master, 'login-csrf');
  const cookieKey = deriveKey(master, 'oauth-cookies').toString('base64url');
  const retryKey = deriveKey(master, 'oauth-failed-refresh');
  // Negative results only: successful refreshes must always rotate in shared
  // state, and replay must still revoke the grant. Never retain raw credentials.
  const failedRefreshes = new Map<string, { until: number; body: { error: string; error_description: string } }>();
  const provider = new Provider(issuer, {
    adapter: Adapter, jwks,
    clients: [],
    clientDefaults: { grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', id_token_signed_response_alg: 'ES256' },
    responseTypes: ['code'],
    scopes: ['openid', 'offline_access', 'lark:read', 'lark:write'],
    claims: { openid: ['sub'] },
    pkce: { required: () => true },
    cookies: {
      keys: [cookieKey],
      names: { session: 'lark_session', interaction: 'lark_interaction', resume: 'lark_resume' },
      short: { httpOnly: true, secure, sameSite: 'lax' },
      long: { httpOnly: true, secure, sameSite: 'lax' },
    },
    routes: { authorization: '/authorize', token: '/token', registration: '/register', jwks: '/jwks', revocation: '/revoke' },
    ttl: { AccessToken: 12 * 60 * 60, AuthorizationCode: 120, Grant: IDLE_SECONDS, IdToken: 3600, Interaction: 600, RefreshToken: IDLE_SECONDS, Session: 30 * 24 * 60 * 60 },
    rotateRefreshToken: true,
    expiresWithSession: () => false,
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    extraTokenClaims: (_ctx, token) => ({ grant_id: 'grantId' in token ? token.grantId : undefined }),
    findAccount: (_ctx, id) => id === ownerId ? { accountId: ownerId, claims: async () => ({ sub: ownerId }) } : undefined,
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      clientIdMetadataDocument: {
        enabled: true, ack: 'draft-02',
        allowFetch: (_ctx, clientId) => TRUSTED_CLIENT_METADATA.has(clientId),
        allowClient: (_ctx, client) => Boolean(client.redirectUris?.length && client.redirectUris.every(allowedRedirect)),
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, identifier) => {
          if (identifier !== resource) throw new errors.InvalidTarget();
          return { scope: SCOPES, audience: resource, accessTokenTTL: 12 * 60 * 60, accessTokenFormat: 'jwt', jwt: { sign: { alg: 'ES256' } } };
        },
      },
    },
    extraClientMetadata: {
      properties: ['application_type'],
      validator: (_ctx, key, value, metadata) => {
        if (key === 'application_type' && metadata.client_id === CLAUDE_CODE_CLIENT) {
          // The official Claude CIMD omits application_type. Normalize only
          // this known native client before oidc-provider validates metadata,
          // so its RFC 8252 loopback port can vary without changing host/path.
          if (!metadata.redirect_uris?.length || !metadata.redirect_uris.every(uri => allowedRedirect(uri) && new URL(uri).protocol === 'http:')) throw new errors.InvalidClientMetadata('Claude Code requires loopback redirects');
          metadata.application_type = 'native';
        }
        // DCR's separate validRegistration check rejects external metadata
        // and private-client auth; CIMD remains restricted by the allowlist.
      },
    },
    renderError: (ctx, _out, error) => {
      ctx.type = 'html';
      ctx.body = isStateFailure(error)
        ? page('服务暂时不可用', '<p>授权存储暂时不可用，请稍后重试。无需重新登录或重新授权。</p>')
        : page('授权未完成', `<p>${escape(('error' in error && error.error) || 'authorization_error')}</p><p>请回到客户端重新发起连接。</p>`);
    },
  });
  provider.proxy = secure;
  provider.on('server_error', (ctx, error) => {
    // oidc-provider catches adapter failures internally; normalize the response
    // here as well as at /mcp, without turning a storage outage into invalid_grant.
    if (isStateFailure(error)) {
      ctx.status = 503;
      ctx.set('Retry-After', String(STATE_RETRY_SECONDS));
      if (ctx.type !== 'text/html') ctx.body = { error: 'temporarily_unavailable' };
    }
    console.error(JSON.stringify({ event: 'oauth_error', type: error.constructor.name }));
  });

  // DCR validation runs before the provider accepts or fetches any metadata.
  // Hook into the provider middleware so its body parser and error contract apply.
  provider.use(async (ctx, next) => {
    let fingerprint: string | undefined;
    if (ctx.path === '/token' && ctx.method === 'POST' && !ctx.get('origin') &&
        ctx.is('application/x-www-form-urlencoded') && ctx.accepts('json', 'html') === 'json') {
      let body: string;
      try { body = await readBody(ctx.req, 56 * 1024); }
      catch { ctx.status = 400; ctx.body = { error: 'invalid_request' }; return; }
      // Preserve the raw form so oidc-provider still rejects duplicate params.
      (ctx.req as typeof ctx.req & { body?: unknown }).body = body;
      if (new URLSearchParams(body).get('grant_type') === 'refresh_token') {
        fingerprint = createHmac('sha256', retryKey).update(JSON.stringify([body, ctx.get('authorization')])).digest('base64url');
        const cached = failedRefreshes.get(fingerprint);
        if (cached && cached.until > Date.now()) {
          ctx.status = 400;
          ctx.set('Cache-Control', 'no-store');
          ctx.set('Retry-After', String(Math.ceil((cached.until - Date.now()) / 1000)));
          ctx.body = cached.body;
          return;
        }
        failedRefreshes.delete(fingerprint);
      }
    }
    if (ctx.path === '/register' && ctx.method === 'POST') {
      let body = '';
      for await (const chunk of ctx.req) {
        body += chunk;
        if (Buffer.byteLength(body) > 16_384) { ctx.status = 413; ctx.body = { error: 'invalid_client_metadata' }; return; }
      }
      let metadata;
      try { metadata = JSON.parse(body); } catch { ctx.status = 400; ctx.body = { error: 'invalid_client_metadata' }; return; }
      if (!validRegistration(metadata)) { ctx.status = 400; ctx.body = { error: 'invalid_client_metadata' }; return; }
      (ctx.req as typeof ctx.req & { body?: unknown }).body = metadata;
    }
    await next();
    if (DISCOVERY_PATHS.has(ctx.path) && ['GET', 'HEAD'].includes(ctx.method) && ctx.status === 200) {
      // MCP clients such as Codex request the advertised scopes verbatim.
      // offline_access is an OIDC consent hint which the provider may strip
      // without prompt=consent; advertising it broke later scoped refreshes.
      // Refresh tokens are already issued explicitly above. Accept standard OIDC
      // requests compatible, but advertise only the actual MCP resource scopes.
      (ctx.body as { scopes_supported: string[] }).scopes_supported = SCOPES.split(' ');
    }
    const failure = ctx.body as { error?: string; scope?: string };
    if (fingerprint && ctx.status === 400 && ['invalid_scope', 'invalid_grant'].includes(failure?.error || '')) {
      const error = failure.error!;
      for (const [key, entry] of failedRefreshes) if (entry.until <= Date.now()) failedRefreshes.delete(key);
      if (failedRefreshes.size >= 256) failedRefreshes.delete(failedRefreshes.keys().next().value!);
      failedRefreshes.set(fingerprint, { until: Date.now() + REFRESH_RETRY_SECONDS * 1000,
        body: { error, error_description: error === 'invalid_scope' ? 'refresh token missing requested scope' : 'refresh token is invalid' } });
      ctx.set('Retry-After', String(REFRESH_RETRY_SECONDS));
      console.warn(JSON.stringify({ event: 'oauth_refresh_rejected', error,
        missingScopes: (failure.scope || '').split(' ').filter(scope => ['openid', 'offline_access', ...SCOPES.split(' ')].includes(scope)) }));
    }
  });

  const publicJwk = { ...jwks.keys[0] };
  delete publicJwk.d;
  const verificationKey = importJWK(publicJwk, 'ES256');
  async function verifyAccess(value) {
    const { payload } = await jwtVerify(value, await verificationKey, { issuer, audience: resource, algorithms: ['ES256'], typ: 'at+jwt' });
    if (payload.sub !== ownerId || !payload.grant_id || !payload.client_id) throw new Error('Invalid access token');
    const grant = await new Adapter('Grant').find(payload.grant_id);
    if (!grant || grant.clientId !== payload.client_id || grant.accountId !== ownerId) throw new Error('Grant revoked');
    return { token: value, clientId: payload.client_id, scopes: String(payload.scope || '').split(' '), expiresAt: payload.exp };
  }

  const csrf = uid => createHmac('sha256', csrfKey).update(uid).digest('base64url');
  async function handleInteraction(req, res) {
    const details = await provider.interactionDetails(req, res);
    const action = `/interaction/${encodeURIComponent(details.uid)}`;
    const client = await provider.Client.find(String(details.params.client_id));
    const label = client?.clientName || String(details.params.client_id);
    const returnOrigin = new URL(String(details.params.redirect_uri)).origin;
    securityHeaders(res, returnOrigin);
    if (req.method === 'GET') {
      const prompt = details.prompt.name;
      const password = prompt === 'login' ? '<label>实例所有者密码<input name="password" type="password" autocomplete="current-password" required></label>' : '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(page(prompt === 'login' ? '登录 larksmith' : '授权 larksmith', `<p>客户端：${escape(label)}</p><p>此连接可以调用你已连接的飞书 user 账户。每次操作仍须明确选择账户。</p><p>请求权限：${escape(details.params.scope || SCOPES)}</p><form action="${action}" method="post"><input type="hidden" name="csrf" value="${csrf(details.uid)}">${password}<button name="decision" value="allow">${prompt === 'login' ? '登录并继续' : '允许连接'}</button><button name="decision" value="deny" formnovalidate>取消</button></form>`));
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (req.headers.origin !== issuer) { res.writeHead(403).end('INVALID_FORM_ORIGIN'); return; }
    const form = new URLSearchParams(await readBody(req, 4096));
    if (form.get('csrf') !== csrf(details.uid)) { res.writeHead(403).end('INVALID_CSRF'); return; }
    if (form.get('decision') === 'deny') {
      await provider.interactionFinished(req, res, { error: 'access_denied' }, { mergeWithLastSubmission: false });
      return;
    }
    if (details.prompt.name === 'login') {
      if (!passwordMatches(form.get('password') || '', ownerHash)) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('密码不正确', `<p>请使用部署者保存的个人登录密码。</p><a href="${action}">返回登录</a>`));
        return;
      }
      await provider.interactionFinished(req, res, { login: { accountId: ownerId, remember: true } }, { mergeWithLastSubmission: false });
      return;
    }
    if (details.prompt.name !== 'consent' || details.session?.accountId !== ownerId) { res.writeHead(400).end('INVALID_INTERACTION'); return; }
    let grant = details.grantId && await provider.Grant.find(details.grantId);
    grant ||= new provider.Grant({ accountId: ownerId, clientId: String(details.params.client_id) });
    const missing = details.prompt.details;
    if (missing.missingOIDCScope) grant.addOIDCScope((missing.missingOIDCScope as string[]).join(' '));
    if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims as string[]);
    for (const [indicator, scopes] of Object.entries(missing.missingResourceScopes || {})) grant.addResourceScope(indicator, scopes.join(' '));
    const grantId = await grant.save();
    await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
  }
  return { provider, verifyAccess, handleInteraction, resource, Adapter };
}

export function validRegistration(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const allowed = new Set(['client_name', 'redirect_uris', 'grant_types', 'response_types', 'token_endpoint_auth_method', 'scope', 'client_uri', 'logo_uri', 'application_type']);
  if (Object.keys(metadata).some(key => !allowed.has(key))) return false;
  if (!Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length < 1 || metadata.redirect_uris.length > 8 || !metadata.redirect_uris.every(allowedRedirect)) return false;
  if (metadata.token_endpoint_auth_method && metadata.token_endpoint_auth_method !== 'none') return false;
  if (metadata.grant_types !== undefined && (!Array.isArray(metadata.grant_types) || metadata.grant_types.some(type => !['authorization_code', 'refresh_token'].includes(type)))) return false;
  if (metadata.response_types !== undefined && (!Array.isArray(metadata.response_types) || metadata.response_types.some(type => type !== 'code'))) return false;
  if (metadata.scope !== undefined && (typeof metadata.scope !== 'string' || metadata.scope.split(' ').some(scope => !['openid', 'offline_access', 'lark:read', 'lark:write'].includes(scope)))) return false;
  return true;
}

export function securityHeaders(res, redirectOrigin = '') {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`);
}
function page(title, body) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font:16px system-ui;margin:7vh auto;padding:24px;max-width:620px;line-height:1.65;color:#15202b}input{display:block;width:90%;padding:12px;margin:12px 0}button{padding:10px 20px;margin:12px 12px 0 0;font:inherit}h1{font-size:26px}</style><h1>${escape(title)}</h1>${body}</html>`;
}
export async function readBody(req, limit) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) throw new Error('Request too large');
  }
  return body;
}
