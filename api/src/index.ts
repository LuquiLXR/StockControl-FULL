import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { createDbPool } from './db.js';
import { runMigrations } from './migrations.js';
import { registerAuthRoutes } from './auth.js';
import { registerTicketRoutes } from './tickets.js';
import { registerInventoryRoutes } from './inventory.js';
import { registerGroupRoutes } from './groups.js';
import { startOcrWorker } from './worker.js';
import { initRealtime } from './realtime.js';

const app = Fastify({ logger: true, bodyLimit: 30 * 1024 * 1024 });

await app.register(cors, {
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : true,
  credentials: true,
});

await app.register(multipart, {
  limits: {
    fileSize: 12 * 1024 * 1024,
    files: 6,
  },
});

app.get('/health', async () => ({ ok: true }));

const db = createDbPool();
await runMigrations(db);

await registerAuthRoutes(app, db);
await registerGroupRoutes(app, db);
await registerInventoryRoutes(app, db);
await registerTicketRoutes(app, db);

startOcrWorker(db);
await initRealtime(app, db);

const port = Number(process.env.PORT ?? '8080');
const host = process.env.HOST ?? '0.0.0.0';

await app.listen({ port, host });
