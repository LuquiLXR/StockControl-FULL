import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { Db, queryOne } from './db.js';
import { randomToken, sha256 } from './crypto.js';

type JwtUser = { sub: string; email?: string };

export function getJwtSecret() {
  const v = process.env.JWT_SECRET;
  if (!v) throw new Error('JWT_SECRET is required');
  return v;
}

export function signAccessToken(input: { userId: string; email?: string }) {
  const secret = getJwtSecret();
  return jwt.sign({ email: input.email ?? null }, secret, { subject: input.userId, expiresIn: '12h' });
}

export function verifyAccessToken(token: string) {
  const secret = getJwtSecret();
  const decoded = jwt.verify(token, secret) as jwt.JwtPayload;
  const sub = decoded.sub;
  const email = typeof decoded.email === 'string' ? decoded.email : undefined;
  if (!sub) throw new Error('Invalid token');
  return { sub, email } satisfies JwtUser;
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST;
  const portRaw = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM;
  if (!host || !portRaw || !from) return null;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) throw new Error('SMTP_PORT is invalid');
  return { host, port, user: user ?? null, pass: pass ?? null, from };
}

async function sendMagicLinkEmail(input: { email: string; link: string }) {
  const cfg = getSmtpConfig();
  if (!cfg) return;
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  await transporter.sendMail({
    from: cfg.from,
    to: input.email,
    subject: 'Tu acceso a StockControl',
    text: `Abrí este link para ingresar:\n\n${input.link}\n\nSi no lo pediste, ignoralo.`,
  });
}

function buildMagicLink(token: string) {
  const template = process.env.MAGIC_LINK_CALLBACK_URL;
  if (template) return template.replace('{{token}}', encodeURIComponent(token));
  return `http://localhost/auth?token=${encodeURIComponent(token)}`;
}

export async function registerAuthRoutes(app: FastifyInstance, db: Db) {
  async function issueTokens(userId: string) {
    const refreshToken = randomToken(32);
    const refreshHash = sha256(refreshToken);
    const refreshDays = Number(process.env.REFRESH_TTL_DAYS ?? '30');
    const ttlDays = Number.isFinite(refreshDays) && refreshDays > 0 ? refreshDays : 30;
    await db.query('INSERT INTO refresh_tokens(user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 || \' days\')::interval)', [
      userId,
      refreshHash,
      String(ttlDays),
    ]);

    const user = await queryOne<{ email: string | null }>(db, 'SELECT email FROM users WHERE id = $1', [userId]);
    const accessToken = signAccessToken({ userId, email: user?.email ?? undefined });
    return { accessToken, refreshToken };
  }

  app.post('/auth/device/register', async (_req, reply) => {
    const row = await queryOne<{ id: string }>(db, 'INSERT INTO users(email) VALUES (NULL) RETURNING id', []);
    const userId = row?.id;
    if (!userId) return reply.code(500).send({ error: 'No se pudo crear usuario' });

    const deviceKey = randomToken(24);
    const keyHash = sha256(deviceKey);
    await db.query('INSERT INTO user_device_keys(user_id, key_hash) VALUES ($1, $2)', [userId, keyHash]);

    const { accessToken, refreshToken } = await issueTokens(userId);
    return reply.send({ deviceKey, accessToken, refreshToken });
  });

  app.post('/auth/device/login', async (req, reply) => {
    const body = req.body as { deviceKey?: unknown };
    const deviceKey = typeof body?.deviceKey === 'string' ? body.deviceKey.trim() : '';
    if (!deviceKey) return reply.code(400).send({ error: 'Código inválido' });
    const keyHash = sha256(deviceKey);

    const row = await queryOne<{ user_id: string; id: string }>(
      db,
      'SELECT id, user_id FROM user_device_keys WHERE key_hash = $1 AND revoked_at IS NULL LIMIT 1',
      [keyHash]
    );
    if (!row) return reply.code(401).send({ error: 'Código inválido' });

    await db.query('UPDATE user_device_keys SET last_used_at = now() WHERE id = $1', [row.id]);

    const { accessToken, refreshToken } = await issueTokens(row.user_id);
    return reply.send({ accessToken, refreshToken });
  });

  app.post('/auth/request-link', async (req, reply) => {
    const body = req.body as { email?: unknown };
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@')) return reply.code(400).send({ error: 'Email inválido' });

    const smtpCfg = getSmtpConfig();
    const allowDevReturn = process.env.AUTH_DEV_RETURN_TOKEN === 'true';
    if (!smtpCfg && !allowDevReturn) {
      return reply
        .code(500)
        .send({ error: 'SMTP no configurado. Configurá SMTP_* o activá AUTH_DEV_RETURN_TOKEN=true para obtener un token de prueba.' });
    }

    const user = await queryOne<{ id: string; email: string }>(db, 'SELECT id, email FROM users WHERE email = $1', [email]);
    const userId =
      user?.id ??
      (await queryOne<{ id: string }>(db, 'INSERT INTO users(email) VALUES ($1) RETURNING id', [email]))?.id;
    if (!userId) return reply.code(500).send({ error: 'No se pudo crear usuario' });

    const token = randomToken(24);
    const tokenHash = sha256(token);
    const expiresAtMinutes = Number(process.env.MAGIC_LINK_TTL_MINUTES ?? '15');
    const ttlMinutes = Number.isFinite(expiresAtMinutes) && expiresAtMinutes > 0 ? expiresAtMinutes : 15;
    await db.query('INSERT INTO magic_links(user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 || \' minutes\')::interval)', [
      userId,
      tokenHash,
      String(ttlMinutes),
    ]);

    const link = buildMagicLink(token);
    if (!smtpCfg && allowDevReturn) return reply.send({ devToken: token, devLink: link });

    try {
      await sendMagicLinkEmail({ email, link });
    } catch {
      return reply.code(500).send({ error: 'No se pudo enviar el email. Verificá SMTP_*.' });
    }

    return reply.code(204).send();
  });

  app.post('/auth/verify', async (req, reply) => {
    const body = req.body as { token?: unknown };
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token) return reply.code(400).send({ error: 'Token inválido' });
    const tokenHash = sha256(token);
    const row = await queryOne<{ id: string; user_id: string }>(
      db,
      'SELECT id, user_id FROM magic_links WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1',
      [tokenHash]
    );
    if (!row) return reply.code(401).send({ error: 'Token expirado o inválido' });

    await db.query('UPDATE magic_links SET used_at = now() WHERE id = $1', [row.id]);

    const { accessToken, refreshToken } = await issueTokens(row.user_id);
    return reply.send({ accessToken, refreshToken });
  });

  app.post('/auth/refresh', async (req, reply) => {
    const body = req.body as { refreshToken?: unknown };
    const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken.trim() : '';
    if (!refreshToken) return reply.code(400).send({ error: 'Refresh token inválido' });
    const refreshHash = sha256(refreshToken);
    const row = await queryOne<{ user_id: string }>(
      db,
      'SELECT user_id FROM refresh_tokens WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1',
      [refreshHash]
    );
    if (!row) return reply.code(401).send({ error: 'Refresh token inválido' });

    const user = await queryOne<{ email: string | null }>(db, 'SELECT email FROM users WHERE id = $1', [row.user_id]);
    const accessToken = signAccessToken({ userId: row.user_id, email: user?.email ?? undefined });
    return reply.send({ accessToken });
  });
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const auth = req.headers.authorization ?? '';
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token) return reply.code(401).send({ error: 'Unauthorized' });
  try {
    const user = verifyAccessToken(token);
    (req as FastifyRequest & { user: JwtUser }).user = user;
  } catch {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}
