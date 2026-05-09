import { Db, queryAll, queryOne } from './db.js';
import { parseVitalTicketWords, tesseractTsv } from './ocr.js';

export function startOcrWorker(db: Db) {
  const enabled = process.env.OCR_WORKER_ENABLED !== 'false';
  if (!enabled) return;
  const intervalMs = Number(process.env.OCR_WORKER_POLL_MS ?? '2000');
  const pollMs = Number.isFinite(intervalMs) && intervalMs >= 500 ? intervalMs : 2000;

  const tick = async () => {
    try {
      const next = await claimNextTicket(db);
      if (!next) return;
      await processTicket(db, next.ticketId);
    } catch {
    }
  };

  void tick();
  setInterval(() => void tick(), pollMs);
}

async function claimNextTicket(db: Db) {
  await db.query('BEGIN');
  try {
    const ticket = await queryOne<{ id: string }>(
      db,
      "SELECT id FROM tickets WHERE status = 'uploaded' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
    );
    if (!ticket) {
      await db.query('COMMIT');
      return null;
    }
    await db.query("UPDATE tickets SET status = 'processing', updated_at = now() WHERE id = $1", [ticket.id]);
    await db.query('COMMIT');
    return { ticketId: ticket.id };
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

async function processTicket(db: Db, ticketId: string) {
  try {
    const pages = await queryAll<{ page_index: number; file_path: string }>(
      db,
      'SELECT page_index, file_path FROM ticket_pages WHERE ticket_id = $1 ORDER BY page_index ASC',
      [ticketId]
    );
    if (pages.length === 0) throw new Error('Ticket sin páginas');

    await db.query('DELETE FROM ticket_lines WHERE ticket_id = $1', [ticketId]);

    let lineIndex = 0;
    for (const p of pages) {
      const words6 = await tesseractTsv(p.file_path, { psm: 6 });
      const parsed6 = parseVitalTicketWords(words6, p.page_index);

      const words4 = parsed6.length === 0 ? await tesseractTsv(p.file_path, { psm: 4 }) : null;
      const parsed4 = words4 ? parseVitalTicketWords(words4, p.page_index) : [];

      const parsed = parsed4.length > parsed6.length ? parsed4 : parsed6;
      for (const l of parsed) {
        await db.query(
          [
            'INSERT INTO ticket_lines(',
            'ticket_id, line_index, source_page, quantity_units, description, raw_quantity, raw_description, raw_uxb, avg_confidence, ignored',
            ') VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          ].join(' '),
          [
            ticketId,
            lineIndex++,
            l.sourcePage,
            l.quantityUnits,
            l.description,
            l.rawQuantity,
            l.rawDescription,
            l.rawUxb,
            l.avgConfidence,
            l.ignored,
          ]
        );
      }
    }

    if (lineIndex === 0) {
      await db.query("UPDATE tickets SET status = 'failed', error_text = $2, updated_at = now() WHERE id = $1", [
        ticketId,
        'OCR completado, pero no se detectaron líneas. Probá con fotos más nítidas o usá Reprocesar.',
      ]);
      return;
    }

    await db.query("UPDATE tickets SET status = 'done', error_text = NULL, updated_at = now() WHERE id = $1", [ticketId]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'OCR failed';
    await db.query("UPDATE tickets SET status = 'failed', error_text = $2, updated_at = now() WHERE id = $1", [ticketId, msg.slice(0, 500)]);
  }
}
