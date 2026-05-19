import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import { Db, queryOne } from './db.js';
import { verifyAccessToken } from './auth.js';

type Client = { ws: any; groupId: string; userId: string };

const groups = new Map<string, Set<Client>>();

function removeClient(c: Client) {
  const set = groups.get(c.groupId);
  if (!set) return;
  set.delete(c);
  if (set.size === 0) groups.delete(c.groupId);
}

export async function initRealtime(app: FastifyInstance, db: Db) {
  const wss = new WebSocketServer({ server: app.server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const token = url.searchParams.get('token') ?? '';
      const groupId = url.searchParams.get('groupId') ?? '';
      if (!token || !groupId) {
        ws.close(1008, 'unauthorized');
        return;
      }

      const user = verifyAccessToken(token);
      const ok = await queryOne<{ ok: number }>(db, 'SELECT 1 AS ok FROM group_memberships WHERE group_id = $1 AND user_id = $2', [
        groupId,
        user.sub,
      ]);
      if (!ok) {
        ws.close(1008, 'forbidden');
        return;
      }

      const client: Client = { ws, groupId, userId: user.sub };
      let set = groups.get(groupId);
      if (!set) {
        set = new Set();
        groups.set(groupId, set);
      }
      set.add(client);

      ws.on('close', () => removeClient(client));
      ws.on('error', () => removeClient(client));
      ws.send(JSON.stringify({ type: 'ready', groupId }));
    } catch {
      try {
        ws.close(1011, 'error');
      } catch {
      }
    }
  });
}

export function emitGroupEvent(input: { groupId: string; kind: 'inventory' | 'shopping' | 'groups' }) {
  const set = groups.get(input.groupId);
  if (!set || set.size === 0) return;
  const msg = JSON.stringify({ type: 'event', kind: input.kind, groupId: input.groupId, at: Date.now() });
  for (const c of set) {
    try {
      c.ws.send(msg);
    } catch {
    }
  }
}

