import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Db, queryAll, queryOne } from './db.js';
import { randomToken } from './crypto.js';
import { requireAuth } from './auth.js';

export function makeRequireGroup(db: Db) {
  return async function requireGroup(req: FastifyRequest, reply: FastifyReply) {
    const userId = (req as any).user?.sub as string | undefined;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const groupIdHeader = req.headers['x-group-id'];
    const groupId = typeof groupIdHeader === 'string' ? groupIdHeader.trim() : '';
    if (!groupId) return reply.code(400).send({ error: 'x-group-id requerido' });

    const ok = await queryOne<{ ok: number }>(db, 'SELECT 1 AS ok FROM group_memberships WHERE group_id = $1 AND user_id = $2', [
      groupId,
      userId,
    ]);
    if (!ok) return reply.code(403).send({ error: 'No pertenecés al grupo' });
    (req as any).groupId = groupId;
  };
}

export function getGroupId(req: FastifyRequest) {
  return (req as any).groupId as string;
}

function inviteCode() {
  return randomToken(6).toUpperCase();
}

export async function registerGroupRoutes(app: FastifyInstance, db: Db) {
  const requireGroup = makeRequireGroup(db);

  app.get('/groups', { preHandler: requireAuth }, async (req, reply) => {
    const userId = (req as any).user.sub as string;
    const rows = await queryAll<{ id: string; name: string; role: string }>(
      db,
      [
        'SELECT g.id, g.name, m.role',
        'FROM group_memberships m',
        'JOIN family_groups g ON g.id = m.group_id',
        'WHERE m.user_id = $1',
        'ORDER BY m.created_at ASC, g.created_at ASC',
      ].join('\n'),
      [userId]
    );
    return reply.send({ groups: rows });
  });

  app.post('/groups', { preHandler: requireAuth }, async (req, reply) => {
    const userId = (req as any).user.sub as string;
    const body = req.body as { name?: unknown };
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'name requerido' });

    await db.query('BEGIN');
    try {
      const created = await queryOne<{ id: string }>(
        db,
        'INSERT INTO family_groups(name, created_by) VALUES ($1, $2) RETURNING id',
        [name, userId]
      );
      if (!created) throw new Error('No se pudo crear grupo');
      await db.query("INSERT INTO group_memberships(group_id, user_id, role) VALUES ($1,$2,'owner')", [created.id, userId]);
      const code = inviteCode();
      await db.query('INSERT INTO group_invites(group_id, code, created_by) VALUES ($1,$2,$3)', [created.id, code, userId]);
      await db.query('COMMIT');
      return reply.send({ groupId: created.id, inviteCode: code });
    } catch (e) {
      await db.query('ROLLBACK');
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'Error' });
    }
  });

  app.post('/groups/join', { preHandler: requireAuth }, async (req, reply) => {
    const userId = (req as any).user.sub as string;
    const body = req.body as { code?: unknown };
    const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (!code) return reply.code(400).send({ error: 'code requerido' });

    await db.query('BEGIN');
    try {
      const inv = await queryOne<{ id: string; group_id: string; uses: number; max_uses: number | null; expires_at: string | null }>(
        db,
        'SELECT id, group_id, uses, max_uses, expires_at FROM group_invites WHERE code = $1 FOR UPDATE',
        [code]
      );
      if (!inv) return reply.code(404).send({ error: 'Código inválido' });
      if (inv.expires_at && new Date(inv.expires_at).getTime() <= Date.now()) return reply.code(400).send({ error: 'Código expirado' });
      if (inv.max_uses != null && inv.uses >= inv.max_uses) return reply.code(400).send({ error: 'Código sin cupos' });

      const inserted = await queryOne<{ group_id: string }>(
        db,
        'INSERT INTO group_memberships(group_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (group_id, user_id) DO NOTHING RETURNING group_id',
        [inv.group_id, userId, 'member']
      );
      if (inserted) await db.query('UPDATE group_invites SET uses = uses + 1 WHERE id = $1', [inv.id]);

      const group = await queryOne<{ id: string; name: string }>(db, 'SELECT id, name FROM family_groups WHERE id = $1', [inv.group_id]);
      await db.query('COMMIT');
      return reply.send({ groupId: inv.group_id, groupName: group?.name ?? 'Grupo' });
    } catch (e) {
      await db.query('ROLLBACK');
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'Error' });
    }
  });

  app.post('/groups/:id/invite/rotate', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    const userId = (req as any).user.sub as string;
    const groupId = getGroupId(req);
    const id = (req.params as any).id as string;
    if (id !== groupId) return reply.code(403).send({ error: 'Grupo inválido' });

    const role = await queryOne<{ role: string }>(db, 'SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
    if (!role || role.role !== 'owner') return reply.code(403).send({ error: 'Solo admin' });

    const code = inviteCode();
    await db.query('INSERT INTO group_invites(group_id, code, created_by) VALUES ($1,$2,$3)', [groupId, code, userId]);
    return reply.send({ inviteCode: code });
  });
}
