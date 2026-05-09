import pg from 'pg';

export type Db = pg.Pool;

export function createDbPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new pg.Pool({ connectionString, max: 10 });
}

export async function queryOne<T>(db: Db, text: string, params: unknown[] = []) {
  const res = await db.query(text, params);
  return (res.rows[0] as T | undefined) ?? null;
}

export async function queryAll<T>(db: Db, text: string, params: unknown[] = []) {
  const res = await db.query(text, params);
  return res.rows as T[];
}

