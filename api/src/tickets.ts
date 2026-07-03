import { FastifyInstance } from 'fastify';
import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Db, queryAll, queryOne } from './db.js';
import { requireAuth } from './auth.js';
import { getGroupId, makeRequireGroup } from './groups.js';

async function ensureDefaultLocationId(db: Db, groupId: string) {
  const existing = await queryOne<{ id: string }>(
    db,
    "SELECT id::text AS id FROM group_locations WHERE group_id = $1 AND parent_id IS NULL AND lower(name) = lower('Sin ubicación') ORDER BY sort_order ASC, name ASC LIMIT 1",
    [groupId]
  );
  if (existing?.id) return existing.id;
  const created = await queryOne<{ id: string }>(
    db,
    "INSERT INTO group_locations(group_id, name, detail, parent_id, sort_order) VALUES ($1, 'Sin ubicación', NULL, NULL, 99) RETURNING id::text AS id",
    [groupId]
  );
  if (created?.id) return created.id;
  const again = await queryOne<{ id: string }>(
    db,
    "SELECT id::text AS id FROM group_locations WHERE group_id = $1 AND parent_id IS NULL AND lower(name) = lower('Sin ubicación') ORDER BY sort_order ASC, name ASC LIMIT 1",
    [groupId]
  );
  if (!again?.id) throw new Error('No se pudo asegurar ubicación por defecto');
  return again.id;
}

export async function registerTicketRoutes(app: FastifyInstance, db: Db) {
  const requireGroup = makeRequireGroup(db);

  app.post('/tickets', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    const userId = (req as any).user.sub as string;
    const groupId = getGroupId(req);

    const parts = (req as any).files?.();
    if (!parts) return reply.code(400).send({ error: 'Se requiere multipart' });

    const created = await queryOne<{ id: string }>(
      db,
      'INSERT INTO tickets(user_id, group_id, status) VALUES ($1, $2, $3) RETURNING id',
      [userId, groupId, 'uploaded']
    );
    const ticketId = created?.id;
    if (!ticketId) return reply.code(500).send({ error: 'No se pudo crear ticket' });

    const uploadRoot = process.env.UPLOAD_DIR ?? '/data/uploads';
    const ticketDir = path.join(uploadRoot, ticketId);
    await mkdir(ticketDir, { recursive: true });

    let pageIndex = 0;
    for await (const part of parts) {
      if (part.type !== 'file') continue;
      const ext = inferExt(part.mimetype);
      const fileName = `${String(pageIndex).padStart(2, '0')}${ext}`;
      const filePath = path.join(ticketDir, fileName);
      await pipeline(part.file, createWriteStream(filePath));
      await db.query('INSERT INTO ticket_pages(ticket_id, page_index, file_path) VALUES ($1, $2, $3)', [ticketId, pageIndex, filePath]);
      pageIndex++;
    }

    if (pageIndex === 0) return reply.code(400).send({ error: 'No se recibieron imágenes' });
    return reply.send({ ticketId });
  });

  app.get('/tickets/:id', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    const groupId = getGroupId(req);
    const id = (req.params as any).id as string;

    const ticket = await queryOne<{ id: string; status: string; error_text: string | null; created_at: string }>(
      db,
      'SELECT id, status, error_text, created_at FROM tickets WHERE id = $1 AND group_id = $2',
      [id, groupId]
    );
    if (!ticket) return reply.code(404).send({ error: 'Ticket no encontrado' });

    const lines = await queryAll<{
      id: string;
      line_index: number;
      source_page: number;
      quantity_units: string;
      description: string;
      avg_confidence: number | null;
    }>(db, 'SELECT id, line_index, source_page, quantity_units, description, avg_confidence FROM ticket_lines WHERE ticket_id = $1 ORDER BY line_index ASC', [id]);

    return reply.send({ ticket, lines });
  });

  app.post('/tickets/:id/reprocess', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    const groupId = getGroupId(req);
    const id = (req.params as any).id as string;
    const updated = await queryOne<{ id: string }>(
      db,
      'UPDATE tickets SET status = $3, error_text = NULL, updated_at = now() WHERE id = $1 AND group_id = $2 RETURNING id',
      [id, groupId, 'uploaded']
    );
    if (!updated) return reply.code(404).send({ error: 'Ticket no encontrado' });
    await db.query('DELETE FROM ticket_lines WHERE ticket_id = $1', [id]);
    return reply.send({ ok: true });
  });

  app.post('/tickets/:id/apply', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    const groupId = getGroupId(req);
    const id = (req.params as any).id as string;
    const body = req.body as { lineIds?: unknown; locationId?: unknown };
    let locationId = typeof body?.locationId === 'string' && body.locationId.trim() ? body.locationId.trim() : '';
    const lineIds = Array.isArray(body?.lineIds) ? body.lineIds.filter((x) => typeof x === 'string') : [];
    if (lineIds.length === 0) return reply.code(400).send({ error: 'lineIds requerido' });

    const ticket = await queryOne<{ id: string }>(db, 'SELECT id FROM tickets WHERE id = $1 AND group_id = $2', [id, groupId]);
    if (!ticket) return reply.code(404).send({ error: 'Ticket no encontrado' });

    if (!locationId) locationId = await ensureDefaultLocationId(db, groupId);

    const okLoc = await queryOne<{ ok: number }>(db, 'SELECT 1 AS ok FROM group_locations WHERE id = $1::uuid AND group_id = $2', [locationId, groupId]);
    if (!okLoc) return reply.code(400).send({ error: 'Ubicación inválida' });

    await db.query('BEGIN');
    try {
      const lines = await queryAll<{ id: string; quantity_units: string; description: string }>(
        db,
        'SELECT id, quantity_units, description FROM ticket_lines WHERE ticket_id = $1 AND ignored = false AND id = ANY($2::uuid[])',
        [id, lineIds]
      );

      for (const l of lines) {
        const qty = Number(l.quantity_units);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        const displayName = l.description.trim();
        const brand = inferBrand(displayName) || 'Sin marca';
        const normName = normalizeKey(displayName);
        const normBrand = normalizeKey(brand);

        const product =
          (await queryOne<{ id: string }>(db, 'SELECT id FROM products WHERE group_id = $1 AND norm_name = $2 AND norm_brand = $3', [
            groupId,
            normName,
            normBrand,
          ])) ??
          (await queryOne<{ id: string }>(
            db,
            'INSERT INTO products(group_id, display_name, brand, norm_name, norm_brand) VALUES ($1,$2,$3,$4,$5) RETURNING id',
            [groupId, displayName, brand, normName, normBrand]
          ));
        if (!product) continue;

        const existing = await queryOne<{ id: string; stock_current: string; stock_unit: string }>(
          db,
          'SELECT id, stock_current, stock_unit FROM stock_items WHERE group_id = $1 AND product_id = $2 AND location_id = $3 AND deleted_at IS NULL',
          [groupId, product.id, locationId]
        );

        let stockItemId: string;
        let current = 0;
        if (existing) {
          stockItemId = existing.id;
          current = Number(existing.stock_current);
          const next = current + qty;
          await db.query('UPDATE stock_items SET stock_current = $2, updated_at = now() WHERE id = $1', [stockItemId, next]);
        } else {
          const created = await queryOne<{ id: string }>(
            db,
            'INSERT INTO stock_items(group_id, product_id, location_id, stock_current, stock_min, stock_unit) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [groupId, product.id, locationId, qty, null, 'unidades']
          );
          if (!created) continue;
          stockItemId = created.id;
        }

        await db.query('INSERT INTO stock_movements(group_id, stock_item_id, delta, reason) VALUES ($1,$2,$3,$4)', [
          groupId,
          stockItemId,
          qty,
          `ticket:${id}`,
        ]);
      }

      await db.query('UPDATE tickets SET status = $2, updated_at = now() WHERE id = $1', [id, 'confirmed']);
      await db.query('COMMIT');
      return reply.send({ ok: true });
    } catch (e) {
      await db.query('ROLLBACK');
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'Error' });
    }
  });

  app.post('/tickets/:id/confirm', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    const groupId = getGroupId(req);
    const id = (req.params as any).id as string;
    const updated = await queryOne<{ id: string }>(
      db,
      'UPDATE tickets SET status = $3, updated_at = now() WHERE id = $1 AND group_id = $2 RETURNING id',
      [id, groupId, 'confirmed']
    );
    if (!updated) return reply.code(404).send({ error: 'Ticket no encontrado' });
    return reply.send({ ok: true });
  });
}

function normalizeKey(input: string) {
  return input
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function inferBrand(description: string) {
  const tokens = description.split(/\s+/g);
  const candidates = tokens
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length >= 3)
    .filter((t) => /^[A-Z0-9]+$/.test(t))
    .filter((t) => t !== 'KG' && t !== 'UN' && t !== 'BTO');
  const best = candidates.sort((a, b) => b.length - a.length)[0];
  return best ?? null;
}

function inferExt(mime: string) {
  const m = mime.toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('webp')) return '.webp';
  return '.jpg';
}
