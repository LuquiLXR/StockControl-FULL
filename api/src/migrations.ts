import { Db } from './db.js';

type Migration = { version: number; up: string };

const HARDCODED_LOCATIONS: { id: string; name: string; parentId: string | null; sortOrder: number }[] = [
  { id: 'loc_mueble', name: 'Mueble', parentId: null, sortOrder: 0 },
  { id: 'loc_mueble_izquierda', name: 'Izquierda', parentId: 'loc_mueble', sortOrder: 0 },
  { id: 'loc_mueble_izquierda_arriba', name: 'Arriba', parentId: 'loc_mueble_izquierda', sortOrder: 0 },
  { id: 'loc_mueble_izquierda_abajo', name: 'Abajo', parentId: 'loc_mueble_izquierda', sortOrder: 1 },
  { id: 'loc_mueble_centro', name: 'Centro', parentId: 'loc_mueble', sortOrder: 1 },
  { id: 'loc_mueble_centro_arriba', name: 'Arriba', parentId: 'loc_mueble_centro', sortOrder: 0 },
  { id: 'loc_mueble_centro_abajo', name: 'Abajo', parentId: 'loc_mueble_centro', sortOrder: 1 },
  { id: 'loc_mueble_derecha', name: 'Derecha', parentId: 'loc_mueble', sortOrder: 2 },
  { id: 'loc_mueble_derecha_arriba', name: 'Arriba', parentId: 'loc_mueble_derecha', sortOrder: 0 },
  { id: 'loc_mueble_derecha_abajo', name: 'Abajo', parentId: 'loc_mueble_derecha', sortOrder: 1 },
  { id: 'loc_freezer', name: 'Freezer', parentId: null, sortOrder: 1 },
  { id: 'loc_heladera', name: 'Heladera', parentId: null, sortOrder: 2 },
  { id: 'loc_sin_ubicacion', name: 'Sin ubicación', parentId: null, sortOrder: 99 },
];

const migrations: Migration[] = [
  {
    version: 1,
    up: [
      'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
      'CREATE EXTENSION IF NOT EXISTS citext;',
      'CREATE TABLE IF NOT EXISTS schema_migrations (',
      '  version INT PRIMARY KEY,',
      '  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      ');',
      'CREATE TABLE IF NOT EXISTS users (',
      '  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),',
      '  email CITEXT NOT NULL UNIQUE,',
      '  created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      ');',
      'CREATE TABLE IF NOT EXISTS magic_links (',
      '  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),',
      '  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,',
      '  token_hash TEXT NOT NULL,',
      '  expires_at TIMESTAMPTZ NOT NULL,',
      '  used_at TIMESTAMPTZ NULL,',
      '  created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      ');',
      'CREATE TABLE IF NOT EXISTS refresh_tokens (',
      '  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),',
      '  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,',
      '  token_hash TEXT NOT NULL,',
      '  expires_at TIMESTAMPTZ NOT NULL,',
      '  revoked_at TIMESTAMPTZ NULL,',
      '  created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      ');',
      'CREATE TABLE IF NOT EXISTS locations (',
      '  id TEXT PRIMARY KEY,',
      '  name TEXT NOT NULL,',
      '  parent_id TEXT NULL REFERENCES locations(id) ON DELETE RESTRICT,',
      '  sort_order INT NOT NULL DEFAULT 0',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_id);',
      'CREATE TABLE IF NOT EXISTS products (',
      '  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),',
      '  display_name TEXT NOT NULL,',
      '  brand TEXT NOT NULL,',
      '  norm_name TEXT NOT NULL,',
      '  norm_brand TEXT NOT NULL,',
      '  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
      '  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
      '  UNIQUE(norm_name, norm_brand)',
      ');',
      'CREATE TABLE IF NOT EXISTS stock_items (',
      '  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),',
      '  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,',
      '  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,',
      '  stock_current NUMERIC NOT NULL DEFAULT 0,',
      '  stock_min NUMERIC NULL,',
      '  stock_unit TEXT NOT NULL DEFAULT \'unidades\',',
      '  deleted_at TIMESTAMPTZ NULL,',
      '  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
      '  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      ');',
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_items_active ON stock_items(product_id, location_id) WHERE deleted_at IS NULL;',
      'CREATE INDEX IF NOT EXISTS idx_stock_items_product ON stock_items(product_id);',
      'CREATE TABLE IF NOT EXISTS stock_movements (',
      '  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),',
      '  stock_item_id UUID NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,',
      '  delta NUMERIC NOT NULL,',
      '  reason TEXT NULL,',
      '  created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(stock_item_id);',
      'CREATE TABLE IF NOT EXISTS tickets (',
      '  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),',
      '  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,',
      '  status TEXT NOT NULL,',
      '  error_text TEXT NULL,',
      '  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
      '  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);',
      'CREATE TABLE IF NOT EXISTS ticket_pages (',
      '  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),',
      '  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,',
      '  page_index INT NOT NULL,',
      '  file_path TEXT NOT NULL,',
      '  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
      '  UNIQUE(ticket_id, page_index)',
      ');',
      'CREATE TABLE IF NOT EXISTS ticket_lines (',
      '  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),',
      '  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,',
      '  line_index INT NOT NULL,',
      '  source_page INT NOT NULL,',
      '  quantity_units NUMERIC NOT NULL,',
      '  description TEXT NOT NULL,',
      '  raw_quantity TEXT NULL,',
      '  raw_description TEXT NULL,',
      '  raw_uxb TEXT NULL,',
      '  avg_confidence REAL NULL,',
      '  ignored BOOLEAN NOT NULL DEFAULT false,',
      '  created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_ticket_lines_ticket ON ticket_lines(ticket_id);',
    ].join('\n'),
  },
];

export async function runMigrations(db: Db) {
  await db.query(
    [
      'CREATE TABLE IF NOT EXISTS schema_migrations (',
      '  version INT PRIMARY KEY,',
      '  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()',
      ');',
    ].join('\n')
  );

  const applied = await db.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version ASC');
  const appliedSet = new Set(applied.rows.map((r) => r.version));

  for (const m of migrations.sort((a, b) => a.version - b.version)) {
    if (appliedSet.has(m.version)) continue;
    await db.query('BEGIN');
    try {
      await db.query(m.up);
      await db.query('INSERT INTO schema_migrations(version) VALUES ($1)', [m.version]);
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  }

  await ensureHardcodedLocations(db);
}

async function ensureHardcodedLocations(db: Db) {
  const rows = await db.query<{ id: string }>('SELECT id FROM locations');
  const existing = new Set(rows.rows.map((r) => r.id));
  const missing = HARDCODED_LOCATIONS.filter((l) => !existing.has(l.id));
  if (missing.length === 0) return;
  const values: string[] = [];
  const params: (string | number | null)[] = [];
  let i = 1;
  for (const l of missing) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(l.id, l.name, l.parentId, l.sortOrder);
  }
  await db.query(`INSERT INTO locations(id, name, parent_id, sort_order) VALUES ${values.join(', ')}`, params);
}

