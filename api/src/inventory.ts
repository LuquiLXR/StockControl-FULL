import { FastifyInstance } from 'fastify';
import { Db, queryAll, queryOne } from './db.js';
import { requireAuth } from './auth.js';

function normalizeKey(input: string) {
  return input
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export async function registerInventoryRoutes(app: FastifyInstance, db: Db) {
  app.get('/locations', { preHandler: requireAuth }, async (_req, reply) => {
    const rows = await queryAll<{ id: string; name: string; parent_id: string | null; sort_order: number }>(
      db,
      'SELECT id, name, parent_id, sort_order FROM locations ORDER BY sort_order ASC, name ASC'
    );
    return reply.send({ locations: rows });
  });

  app.get('/inventory', { preHandler: requireAuth }, async (_req, reply) => {
    const rows = await queryAll<{
      stock_item_id: string;
      stock_current: string;
      stock_min: string | null;
      stock_unit: string;
      product_id: string;
      brand: string;
      display_name: string;
      location_id: string;
      location_path: string;
    }>(
      db,
      [
        'WITH RECURSIVE loc_paths(id, name, parent_id, path) AS (',
        '  SELECT id, name, parent_id, name AS path FROM locations WHERE parent_id IS NULL',
        '  UNION ALL',
        '  SELECT l.id, l.name, l.parent_id, loc_paths.path || \' / \' || l.name',
        '  FROM locations l JOIN loc_paths ON l.parent_id = loc_paths.id',
        ')',
        'SELECT',
        '  si.id AS stock_item_id,',
        '  si.stock_current AS stock_current,',
        '  si.stock_min AS stock_min,',
        '  si.stock_unit AS stock_unit,',
        '  p.id AS product_id,',
        '  p.brand AS brand,',
        '  p.display_name AS display_name,',
        '  si.location_id AS location_id,',
        '  lp.path AS location_path',
        'FROM stock_items si',
        'JOIN products p ON p.id = si.product_id',
        'JOIN loc_paths lp ON lp.id = si.location_id',
        'WHERE si.deleted_at IS NULL',
        'ORDER BY lp.path ASC, p.display_name ASC, p.brand ASC',
      ].join('\n')
    );
    return reply.send({ items: rows });
  });

  app.post('/inventory/items', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as {
      displayName?: unknown;
      brand?: unknown;
      locationId?: unknown;
      stockCurrent?: unknown;
      stockMin?: unknown;
      stockUnit?: unknown;
    };
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const brand = typeof body.brand === 'string' ? body.brand.trim() : '';
    const locationId = typeof body.locationId === 'string' ? body.locationId.trim() : 'loc_sin_ubicacion';
    const stockUnit = typeof body.stockUnit === 'string' ? body.stockUnit.trim() : 'unidades';
    const stockCurrent = Number(body.stockCurrent);
    const stockMin = body.stockMin == null ? null : Number(body.stockMin);

    if (!displayName) return reply.code(400).send({ error: 'displayName requerido' });
    const finalBrand = brand || 'Sin marca';
    if (!locationId) return reply.code(400).send({ error: 'locationId inválido' });
    if (!Number.isFinite(stockCurrent) || stockCurrent < 0) return reply.code(400).send({ error: 'stockCurrent inválido' });
    if (stockMin != null && (!Number.isFinite(stockMin) || stockMin < 0)) return reply.code(400).send({ error: 'stockMin inválido' });

    const normName = normalizeKey(displayName);
    const normBrand = normalizeKey(finalBrand);

    await db.query('BEGIN');
    try {
      const product =
        (await queryOne<{ id: string }>(db, 'SELECT id FROM products WHERE norm_name = $1 AND norm_brand = $2', [normName, normBrand])) ??
        (await queryOne<{ id: string }>(
          db,
          'INSERT INTO products(display_name, brand, norm_name, norm_brand) VALUES ($1,$2,$3,$4) RETURNING id',
          [displayName, finalBrand, normName, normBrand]
        ));
      if (!product) throw new Error('No se pudo crear producto');

      const existing = await queryOne<{ id: string; stock_current: string }>(
        db,
        'SELECT id, stock_current FROM stock_items WHERE product_id = $1 AND location_id = $2 AND deleted_at IS NULL',
        [product.id, locationId]
      );

      let stockItemId: string;
      if (existing) {
        stockItemId = existing.id;
        await db.query('UPDATE stock_items SET stock_current = $2, stock_min = $3, stock_unit = $4, updated_at = now() WHERE id = $1', [
          stockItemId,
          stockCurrent,
          stockMin,
          stockUnit,
        ]);
      } else {
        const created = await queryOne<{ id: string }>(
          db,
          'INSERT INTO stock_items(product_id, location_id, stock_current, stock_min, stock_unit) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [product.id, locationId, stockCurrent, stockMin, stockUnit]
        );
        if (!created) throw new Error('No se pudo crear stock_item');
        stockItemId = created.id;
      }

      await db.query('COMMIT');
      return reply.send({ stockItemId });
    } catch (e) {
      await db.query('ROLLBACK');
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'Error' });
    }
  });

  app.post('/inventory/movements', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { stockItemId?: unknown; delta?: unknown; reason?: unknown };
    const stockItemId = typeof body.stockItemId === 'string' ? body.stockItemId.trim() : '';
    const delta = Number(body.delta);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : null;
    if (!stockItemId) return reply.code(400).send({ error: 'stockItemId requerido' });
    if (!Number.isFinite(delta) || delta === 0) return reply.code(400).send({ error: 'delta inválido' });

    await db.query('BEGIN');
    try {
      const item = await queryOne<{ stock_current: string }>(db, 'SELECT stock_current FROM stock_items WHERE id = $1 AND deleted_at IS NULL', [
        stockItemId,
      ]);
      if (!item) return reply.code(404).send({ error: 'Ítem no encontrado' });
      const current = Number(item.stock_current);
      const next = current + delta;
      if (next < 0) return reply.code(400).send({ error: 'Stock insuficiente' });

      await db.query('UPDATE stock_items SET stock_current = $2, updated_at = now() WHERE id = $1', [stockItemId, next]);
      await db.query('INSERT INTO stock_movements(stock_item_id, delta, reason) VALUES ($1,$2,$3)', [stockItemId, delta, reason]);
      await db.query('COMMIT');
      return reply.send({ stockCurrent: next });
    } catch (e) {
      await db.query('ROLLBACK');
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'Error' });
    }
  });
}
