import { FastifyInstance } from 'fastify';
import { Db, queryAll, queryOne } from './db.js';
import { requireAuth } from './auth.js';
import { getGroupId, makeRequireGroup } from './groups.js';
import { emitGroupEvent } from './realtime.js';

function normalizeKey(input: string) {
  return input
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

async function ensureShoppingTables(db: Db) {
  await db.query(
    [
      'CREATE TABLE IF NOT EXISTS group_shopping_desired (',
      '  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),',
      '  group_id UUID NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,',
      '  display_name TEXT NOT NULL,',
      '  brand TEXT NOT NULL,',
      '  in_cart BOOLEAN NOT NULL DEFAULT false,',
      '  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,',
      '  created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_group_shopping_desired_group ON group_shopping_desired(group_id, created_at DESC);',
      '',
      'CREATE TABLE IF NOT EXISTS group_shopping_low (',
      '  group_id UUID NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,',
      '  stock_item_id UUID NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,',
      '  in_cart BOOLEAN NOT NULL DEFAULT false,',
      '  updated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,',
      '  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
      '  PRIMARY KEY (group_id, stock_item_id)',
      ');',
    ].join('\n')
  );
}

export async function registerInventoryRoutes(app: FastifyInstance, db: Db) {
  const requireGroup = makeRequireGroup(db);

  app.get('/locations', { preHandler: requireAuth }, async (_req, reply) => {
    const rows = await queryAll<{ id: string; name: string; parent_id: string | null; sort_order: number }>(
      db,
      'SELECT id, name, parent_id, sort_order FROM locations ORDER BY sort_order ASC, name ASC'
    );
    return reply.send({ locations: rows });
  });

  app.get('/inventory', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    const groupId = getGroupId(req);
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
        'WHERE si.deleted_at IS NULL AND si.group_id = $1 AND p.group_id = $1',
        'ORDER BY lp.path ASC, p.display_name ASC, p.brand ASC',
      ].join('\n')
      ,
      [groupId]
    );
    return reply.send({ items: rows });
  });

  app.post('/inventory/items', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    const groupId = getGroupId(req);
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
        (await queryOne<{ id: string }>(db, 'SELECT id FROM products WHERE group_id = $1 AND norm_name = $2 AND norm_brand = $3', [
          groupId,
          normName,
          normBrand,
        ])) ??
        (await queryOne<{ id: string }>(
          db,
          'INSERT INTO products(group_id, display_name, brand, norm_name, norm_brand) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [groupId, displayName, finalBrand, normName, normBrand]
        ));
      if (!product) throw new Error('No se pudo crear producto');

      const existing = await queryOne<{ id: string; stock_current: string }>(
        db,
        'SELECT id, stock_current FROM stock_items WHERE group_id = $1 AND product_id = $2 AND location_id = $3 AND deleted_at IS NULL',
        [groupId, product.id, locationId]
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
          'INSERT INTO stock_items(group_id, product_id, location_id, stock_current, stock_min, stock_unit) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [groupId, product.id, locationId, stockCurrent, stockMin, stockUnit]
        );
        if (!created) throw new Error('No se pudo crear stock_item');
        stockItemId = created.id;
      }

      await db.query('COMMIT');
      emitGroupEvent({ groupId, kind: 'inventory' });
      emitGroupEvent({ groupId, kind: 'shopping' });
      return reply.send({ stockItemId });
    } catch (e) {
      await db.query('ROLLBACK');
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'Error' });
    }
  });

  app.post('/inventory/movements', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    const groupId = getGroupId(req);
    const body = req.body as { stockItemId?: unknown; delta?: unknown; reason?: unknown };
    const stockItemId = typeof body.stockItemId === 'string' ? body.stockItemId.trim() : '';
    const delta = Number(body.delta);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : null;
    if (!stockItemId) return reply.code(400).send({ error: 'stockItemId requerido' });
    if (!Number.isFinite(delta) || delta === 0) return reply.code(400).send({ error: 'delta inválido' });

    await db.query('BEGIN');
    try {
      const item = await queryOne<{ stock_current: string }>(
        db,
        'SELECT stock_current FROM stock_items WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL',
        [stockItemId, groupId]
      );
      if (!item) return reply.code(404).send({ error: 'Ítem no encontrado' });
      const current = Number(item.stock_current);
      const next = current + delta;
      if (next < 0) return reply.code(400).send({ error: 'Stock insuficiente' });

      await db.query('UPDATE stock_items SET stock_current = $2, updated_at = now() WHERE id = $1', [stockItemId, next]);
      await db.query('INSERT INTO stock_movements(group_id, stock_item_id, delta, reason) VALUES ($1,$2,$3,$4)', [groupId, stockItemId, delta, reason]);
      await db.query('COMMIT');
      emitGroupEvent({ groupId, kind: 'inventory' });
      emitGroupEvent({ groupId, kind: 'shopping' });
      return reply.send({ stockCurrent: next });
    } catch (e) {
      await db.query('ROLLBACK');
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'Error' });
    }
  });

  app.get('/inventory/items/:id', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    const groupId = getGroupId(req);
    const id = (req.params as any).id as string;
    if (!id) return reply.code(400).send({ error: 'id requerido' });

    const row = await queryOne<{
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
        'WHERE si.id = $1 AND si.deleted_at IS NULL AND si.group_id = $2 AND p.group_id = $2',
        'LIMIT 1',
      ].join('\n'),
      [id, groupId]
    );
    if (!row) return reply.code(404).send({ error: 'Ítem no encontrado' });
    return reply.send({ item: row });
  });

  app.post('/inventory/items/:id/edit', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    const groupId = getGroupId(req);
    const id = (req.params as any).id as string;
    const body = req.body as { displayName?: unknown; brand?: unknown; locationId?: unknown };
    if (!id) return reply.code(400).send({ error: 'id requerido' });

    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : null;
    const brand = typeof body.brand === 'string' ? body.brand.trim() : null;
    const locationId = typeof body.locationId === 'string' ? body.locationId.trim() : null;
    if (displayName == null && brand == null && locationId == null) return reply.code(400).send({ error: 'Nada para editar' });
    if (displayName != null && !displayName) return reply.code(400).send({ error: 'displayName inválido' });
    if (locationId != null && !locationId) return reply.code(400).send({ error: 'locationId inválido' });

    await db.query('BEGIN');
    try {
      const row = await queryOne<{ stock_item_id: string; product_id: string; current_location_id: string; display_name: string; brand: string; stock_current: string; stock_min: string | null }>(
        db,
        [
          'SELECT',
          '  si.id AS stock_item_id,',
          '  si.product_id AS product_id,',
          '  si.location_id AS current_location_id,',
          '  si.stock_current AS stock_current,',
          '  si.stock_min AS stock_min,',
          '  p.display_name AS display_name,',
          '  p.brand AS brand',
          'FROM stock_items si',
          'JOIN products p ON p.id = si.product_id',
          'WHERE si.id = $1 AND si.group_id = $2 AND si.deleted_at IS NULL AND p.group_id = $2',
          'FOR UPDATE',
        ].join('\n'),
        [id, groupId]
      );
      if (!row) {
        await db.query('ROLLBACK');
        return reply.code(404).send({ error: 'Ítem no encontrado' });
      }

      const nextName = displayName ?? row.display_name;
      const nextBrand = (brand ?? row.brand) || 'Sin marca';
      const nextLocationId = locationId ?? row.current_location_id;

      if (locationId != null) {
        const okLoc = await queryOne<{ ok: number }>(db, 'SELECT 1 AS ok FROM locations WHERE id = $1', [nextLocationId]);
        if (!okLoc) {
          await db.query('ROLLBACK');
          return reply.code(400).send({ error: 'Ubicación inválida' });
        }
      }

      if (displayName != null || brand != null) {
        const normName = normalizeKey(nextName);
        const normBrand = normalizeKey(nextBrand);
        const collision = await queryOne<{ id: string }>(
          db,
          'SELECT id FROM products WHERE group_id = $1 AND norm_name = $2 AND norm_brand = $3 AND id <> $4 LIMIT 1',
          [groupId, normName, normBrand, row.product_id]
        );
        if (collision) {
          await db.query('ROLLBACK');
          return reply.code(400).send({ error: 'Ya existe un producto con ese nombre y marca' });
        }

        await db.query('UPDATE products SET display_name = $2, brand = $3, norm_name = $4, norm_brand = $5, updated_at = now() WHERE id = $1 AND group_id = $6', [
          row.product_id,
          nextName,
          nextBrand,
          normName,
          normBrand,
          groupId,
        ]);
      }

      let finalStockItemId = row.stock_item_id;
      if (nextLocationId !== row.current_location_id) {
        const other = await queryOne<{ id: string; stock_current: string; stock_min: string | null }>(
          db,
          'SELECT id, stock_current, stock_min FROM stock_items WHERE group_id = $1 AND product_id = $2 AND location_id = $3 AND deleted_at IS NULL AND id <> $4 FOR UPDATE',
          [groupId, row.product_id, nextLocationId, row.stock_item_id]
        );
        if (other) {
          const mergedMin =
            other.stock_min == null
              ? row.stock_min
              : row.stock_min == null
                ? other.stock_min
                : String(Math.max(Number(other.stock_min), Number(row.stock_min)));
          const mergedCurrent = Number(other.stock_current) + Number(row.stock_current);
          await db.query('UPDATE stock_items SET stock_current = $2, stock_min = $3, updated_at = now() WHERE id = $1', [other.id, mergedCurrent, mergedMin]);
          await db.query('UPDATE stock_items SET deleted_at = now(), updated_at = now() WHERE id = $1', [row.stock_item_id]);
          finalStockItemId = other.id;
        } else {
          await db.query('UPDATE stock_items SET location_id = $2, updated_at = now() WHERE id = $1', [row.stock_item_id, nextLocationId]);
        }
      }

      await db.query('COMMIT');
      emitGroupEvent({ groupId, kind: 'inventory' });
      emitGroupEvent({ groupId, kind: 'shopping' });
      return reply.send({ stockItemId: finalStockItemId });
    } catch (e) {
      await db.query('ROLLBACK');
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'Error' });
    }
  });

  app.post('/inventory/items/:id/min', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    const groupId = getGroupId(req);
    const id = (req.params as any).id as string;
    const body = req.body as { stockMin?: unknown; stockUnit?: unknown };
    const stockUnit = typeof body?.stockUnit === 'string' ? body.stockUnit.trim() : null;
    const stockMin = body?.stockMin == null ? null : Number(body.stockMin);
    if (!id) return reply.code(400).send({ error: 'id requerido' });
    if (stockMin != null && (!Number.isFinite(stockMin) || stockMin < 0)) return reply.code(400).send({ error: 'stockMin inválido' });
    if (stockUnit != null && !stockUnit) return reply.code(400).send({ error: 'stockUnit inválido' });

    const updated = await queryOne<{ id: string }>(
      db,
      [
        'UPDATE stock_items',
        'SET stock_min = $3,',
        stockUnit != null ? '    stock_unit = $4,' : '',
        '    updated_at = now()',
        'WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL',
        'RETURNING id',
      ]
        .filter(Boolean)
        .join('\n'),
      stockUnit != null ? [id, groupId, stockMin, stockUnit] : [id, groupId, stockMin]
    );
    if (!updated) return reply.code(404).send({ error: 'Ítem no encontrado' });
    emitGroupEvent({ groupId, kind: 'inventory' });
    emitGroupEvent({ groupId, kind: 'shopping' });
    return reply.send({ ok: true });
  });

  app.delete('/inventory/items/:id', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    const groupId = getGroupId(req);
    const id = (req.params as any).id as string;
    if (!id) return reply.code(400).send({ error: 'id requerido' });
    const updated = await queryOne<{ id: string }>(
      db,
      'UPDATE stock_items SET deleted_at = now(), updated_at = now() WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL RETURNING id',
      [id, groupId]
    );
    if (!updated) return reply.code(404).send({ error: 'Ítem no encontrado' });
    emitGroupEvent({ groupId, kind: 'inventory' });
    emitGroupEvent({ groupId, kind: 'shopping' });
    return reply.send({ ok: true });
  });

  app.get('/shopping', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    await ensureShoppingTables(db);
    const groupId = getGroupId(req);
    const faltantes = await queryAll<{
      stock_item_id: string;
      stock_current: string;
      stock_min: string;
      stock_unit: string;
      brand: string;
      display_name: string;
      location_path: string;
      in_cart: boolean;
    }>(
      db,
      [
        'WITH RECURSIVE loc_paths(id, name, parent_id, path) AS (',
        '  SELECT id, name, parent_id, name AS path FROM locations WHERE parent_id IS NULL',
        '  UNION ALL',
        "  SELECT l.id, l.name, l.parent_id, loc_paths.path || ' / ' || l.name",
        '  FROM locations l JOIN loc_paths ON l.parent_id = loc_paths.id',
        ')',
        'SELECT',
        '  si.id AS stock_item_id,',
        '  si.stock_current AS stock_current,',
        '  si.stock_min AS stock_min,',
        '  si.stock_unit AS stock_unit,',
        '  p.brand AS brand,',
        '  p.display_name AS display_name,',
        '  lp.path AS location_path,',
        '  COALESCE(gl.in_cart, false) AS in_cart',
        'FROM stock_items si',
        'JOIN products p ON p.id = si.product_id',
        'JOIN loc_paths lp ON lp.id = si.location_id',
        'LEFT JOIN group_shopping_low gl ON gl.group_id = si.group_id AND gl.stock_item_id = si.id',
        'WHERE si.deleted_at IS NULL',
        '  AND si.group_id = $1 AND p.group_id = $1',
        '  AND si.stock_min IS NOT NULL',
        '  AND si.stock_current <= si.stock_min',
        'ORDER BY COALESCE(gl.in_cart, false) ASC, lp.path ASC, p.display_name ASC, p.brand ASC',
      ].join('\n'),
      [groupId]
    );

    const deseados = await queryAll<{ id: string; display_name: string; brand: string; in_cart: boolean; created_at: string }>(
      db,
      'SELECT id, display_name, brand, in_cart, created_at FROM group_shopping_desired WHERE group_id = $1 ORDER BY in_cart ASC, created_at DESC',
      [groupId]
    );

    return reply.send({ faltantes, deseados });
  });

  app.post('/shopping/low/:stockItemId/in-cart', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    await ensureShoppingTables(db);
    const userId = (req as any).user.sub as string;
    const groupId = getGroupId(req);
    const stockItemId = (req.params as any).stockItemId as string;
    const body = req.body as { inCart?: unknown };
    const inCart = Boolean(body?.inCart);
    if (!stockItemId) return reply.code(400).send({ error: 'stockItemId requerido' });

    const ok = await queryOne<{ ok: number }>(
      db,
      'SELECT 1 AS ok FROM stock_items WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL LIMIT 1',
      [stockItemId, groupId]
    );
    if (!ok) return reply.code(404).send({ error: 'Ítem no encontrado' });

    await db.query(
      [
        'INSERT INTO group_shopping_low(group_id, stock_item_id, in_cart, updated_by)',
        'VALUES ($1,$2,$3,$4)',
        'ON CONFLICT (group_id, stock_item_id)',
        'DO UPDATE SET in_cart = EXCLUDED.in_cart, updated_by = EXCLUDED.updated_by, updated_at = now()',
      ].join('\n'),
      [groupId, stockItemId, inCart, userId]
    );
    emitGroupEvent({ groupId, kind: 'shopping' });
    return reply.send({ ok: true });
  });

  app.post('/shopping/desired', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    await ensureShoppingTables(db);
    const userId = (req as any).user.sub as string;
    const groupId = getGroupId(req);
    const body = req.body as { displayName?: unknown; brand?: unknown };
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const brand = typeof body.brand === 'string' ? body.brand.trim() : '';
    if (!displayName) return reply.code(400).send({ error: 'displayName requerido' });
    const finalBrand = brand || 'Sin marca';

    const created = await queryOne<{ id: string }>(
      db,
      'INSERT INTO group_shopping_desired(group_id, display_name, brand, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [groupId, displayName, finalBrand, userId]
    );
    if (!created) return reply.code(500).send({ error: 'No se pudo crear' });
    emitGroupEvent({ groupId, kind: 'shopping' });
    return reply.send({ id: created.id });
  });

  app.post('/shopping/desired/:id/in-cart', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    await ensureShoppingTables(db);
    const groupId = getGroupId(req);
    const id = (req.params as any).id as string;
    const body = req.body as { inCart?: unknown };
    const inCart = Boolean(body?.inCart);
    if (!id) return reply.code(400).send({ error: 'id requerido' });

    const updated = await queryOne<{ id: string }>(
      db,
      'UPDATE group_shopping_desired SET in_cart = $2 WHERE id = $1 AND group_id = $3 RETURNING id',
      [id, inCart, groupId]
    );
    if (!updated) return reply.code(404).send({ error: 'No encontrado' });
    emitGroupEvent({ groupId, kind: 'shopping' });
    return reply.send({ ok: true });
  });

  app.delete('/shopping/desired/:id', { preHandler: [requireAuth, requireGroup] }, async (req, reply) => {
    await ensureShoppingTables(db);
    const groupId = getGroupId(req);
    const id = (req.params as any).id as string;
    if (!id) return reply.code(400).send({ error: 'id requerido' });
    const deleted = await queryOne<{ id: string }>(db, 'DELETE FROM group_shopping_desired WHERE id = $1 AND group_id = $2 RETURNING id', [id, groupId]);
    if (!deleted) return reply.code(404).send({ error: 'No encontrado' });
    emitGroupEvent({ groupId, kind: 'shopping' });
    return reply.send({ ok: true });
  });
}
