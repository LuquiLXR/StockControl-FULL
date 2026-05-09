import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type TsvWord = {
  pageNum: number;
  blockNum: number;
  parNum: number;
  lineNum: number;
  wordNum: number;
  left: number;
  top: number;
  width: number;
  height: number;
  conf: number;
  text: string;
};

export type OcrParsedLine = {
  sourcePage: number;
  lineIndex: number;
  quantityUnits: number;
  description: string;
  rawQuantity: string | null;
  rawDescription: string | null;
  rawUxb: string | null;
  avgConfidence: number | null;
  ignored: boolean;
};

export async function tesseractTsv(imagePath: string) {
  const args = [imagePath, 'stdout', '-l', 'spa', '--psm', '6', 'tsv'];
  const { stdout } = await execFileAsync('tesseract', args, { maxBuffer: 50 * 1024 * 1024 });
  return parseTsv(stdout);
}

function parseTsv(tsv: string): TsvWord[] {
  const lines = tsv.split(/\r?\n/);
  const out: TsvWord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 12) continue;
    const level = Number(parts[0]);
    if (level !== 5) continue;
    const text = (parts[11] ?? '').trim();
    if (!text) continue;
    const conf = Number(parts[10]);
    const w: TsvWord = {
      pageNum: Number(parts[1]),
      blockNum: Number(parts[2]),
      parNum: Number(parts[3]),
      lineNum: Number(parts[4]),
      wordNum: Number(parts[5]),
      left: Number(parts[6]),
      top: Number(parts[7]),
      width: Number(parts[8]),
      height: Number(parts[9]),
      conf,
      text,
    };
    if (!Number.isFinite(w.left) || !Number.isFinite(w.top)) continue;
    out.push(w);
  }
  return out;
}

function normToken(input: string) {
  return input
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

type LineKey = string;
function lineKey(w: TsvWord): LineKey {
  return `${w.pageNum}:${w.blockNum}:${w.parNum}:${w.lineNum}`;
}

export function parseVitalTicketWords(words: TsvWord[], sourcePage: number): OcrParsedLine[] {
  const byLine = new Map<LineKey, TsvWord[]>();
  for (const w of words) {
    const k = lineKey(w);
    const arr = byLine.get(k);
    if (arr) arr.push(w);
    else byLine.set(k, [w]);
  }

  const lines = Array.from(byLine.entries()).map(([k, ws]) => {
    const sorted = [...ws].sort((a, b) => a.left - b.left);
    const top = Math.min(...sorted.map((x) => x.top));
    const tokens = sorted.map((x) => normToken(x.text));
    return { key: k, words: sorted, top, tokens };
  });
  lines.sort((a, b) => a.top - b.top);

  const header = lines.find((l) => l.tokens.some((t) => t === 'CANT.' || t === 'CANT') && l.tokens.some((t) => t.startsWith('DESCRIP')));
  const cantWord = header?.words.find((w) => {
    const t = normToken(w.text);
    return t === 'CANT.' || t === 'CANT';
  });
  const descWord = header?.words.find((w) => normToken(w.text).startsWith('DESCRIP'));
  const uxbWord = header?.words.find((w) => {
    const t = normToken(w.text);
    return t === 'UXB' || t === 'UX8' || t === 'UXB.' || t === 'UXB,' || t === 'UXB:' || t === 'UXB;';
  });

  if (!header || !cantWord || !descWord) return [];

  const headerTop = header.top;
  const xCant = cantWord.left;
  const xDesc = descWord.left;
  const xUxb = uxbWord?.left ?? null;

  const qtyMin = Math.max(0, xCant - 40);
  const qtyMax = Math.max(qtyMin + 1, xDesc - 10);
  const descMin = xDesc - 10;
  const descMax = xUxb != null ? xUxb - 10 : xDesc + 900;
  const uxbMin = xUxb != null ? xUxb - 20 : null;
  const uxbMax = xUxb != null ? xUxb + 120 : null;

  const out: OcrParsedLine[] = [];
  let inPromos = false;
  let runningLineIndex = 0;

  for (const l of lines) {
    if (l.top <= headerTop + 10) continue;

    const hasPromos = l.tokens.some((t) => t.includes('PROMOCIONES'));
    if (hasPromos) {
      inPromos = true;
      continue;
    }
    if (inPromos) continue;

    const qtyWords = l.words.filter((w) => w.left >= qtyMin && w.left <= qtyMax).sort((a, b) => a.left - b.left);
    const descWords = l.words.filter((w) => w.left >= descMin && w.left <= descMax).sort((a, b) => a.left - b.left);
    const uxbWords =
      uxbMin != null && uxbMax != null ? l.words.filter((w) => w.left >= uxbMin && w.left <= uxbMax).sort((a, b) => a.left - b.left) : [];

    const rawQuantity = joinWords(qtyWords);
    const rawDescription = joinWords(descWords);
    const rawUxb = joinWords(uxbWords);

    const descIsEmpty = !rawDescription || rawDescription.length < 2;
    if (descIsEmpty) continue;

    const maybeWrap = (!rawQuantity || rawQuantity.length === 0) && (!rawUxb || rawUxb.length === 0);
    if (maybeWrap && out.length > 0) {
      const prev = out[out.length - 1];
      prev.description = cleanSpaces(`${prev.description} ${rawDescription}`);
      prev.rawDescription = cleanSpaces(`${prev.rawDescription ?? ''} ${rawDescription}`.trim()) || prev.rawDescription;
      continue;
    }

    const { quantityUnits, description, ignored, avgConfidence } = normalizeLine({
      rawQuantity,
      rawDescription,
      rawUxb,
      confidence: avgLineConfidence(l.words),
    });

    out.push({
      sourcePage,
      lineIndex: runningLineIndex++,
      quantityUnits,
      description,
      rawQuantity: rawQuantity || null,
      rawDescription: rawDescription || null,
      rawUxb: rawUxb || null,
      avgConfidence,
      ignored,
    });
  }

  return out.filter((l) => !l.ignored);
}

function joinWords(words: TsvWord[]) {
  return cleanSpaces(words.map((w) => w.text).join(' '));
}

function cleanSpaces(input: string) {
  return input.replace(/\s+/g, ' ').trim();
}

function avgLineConfidence(words: TsvWord[]) {
  const vals = words.map((w) => w.conf).filter((c) => Number.isFinite(c) && c >= 0);
  if (vals.length === 0) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  return sum / vals.length;
}

function parseDecimal(input: string) {
  const cleaned = input.replace(/\./g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeLine(input: { rawQuantity: string; rawDescription: string; rawUxb: string; confidence: number | null }) {
  const rawQuantity = cleanSpaces(input.rawQuantity);
  const rawDescription = cleanSpaces(input.rawDescription);
  const rawUxb = cleanSpaces(input.rawUxb);

  const descTokens = normToken(rawDescription);
  if (descTokens.includes('TOTAL') && !descTokens.includes('TOTALMENTE')) return { quantityUnits: 0, description: rawDescription, ignored: true, avgConfidence: input.confidence };

  const qtyMatch = rawQuantity.match(/(\d+[.,]?\d*)/);
  const qtyText = qtyMatch?.[1] ?? '';
  const qtyNum = qtyText ? parseDecimal(qtyText) : null;

  const unit = normToken(rawQuantity).includes('KG') ? 'KG' : 'OTHER';
  const uxbMatch = rawUxb.match(/(\d{1,3})/);
  const uxb = uxbMatch ? Number(uxbMatch[1]) : null;

  if (unit === 'KG' && qtyText) {
    const baseDesc = cleanSpaces(rawDescription.replace(/\bxkg\b/gi, '').replace(/\bXKG\b/g, '').trim());
    const description = cleanSpaces(`${baseDesc} ${qtyText}KG`);
    return { quantityUnits: 1, description, ignored: false, avgConfidence: input.confidence };
  }

  const baseQty = qtyNum != null ? qtyNum : 0;
  const pack = uxb != null && Number.isFinite(uxb) && uxb > 0 ? uxb : 1;
  const quantityUnits = Math.round(baseQty * pack);
  const description = rawDescription;

  if (!description || quantityUnits <= 0) return { quantityUnits: 0, description, ignored: true, avgConfidence: input.confidence };
  return { quantityUnits, description, ignored: false, avgConfidence: input.confidence };
}

