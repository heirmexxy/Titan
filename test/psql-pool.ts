// Test-only stand-in for pg.Pool that runs each query through the psql CLI.
// Used to check the Postgres store's SQL against a real database where the pg driver isn't installed.
import { execFileSync } from 'node:child_process';

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `'{${v.map((x) => `"${String(x).replace(/["\\]/g, '\\$&')}"`).join(',')}}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export class PsqlPool {
  constructor(private args: string[]) {}
  async query(text: string, values: unknown[] = []) {
    const sql = text.replace(/\$(\d+)/g, (_, n) => literal(values[Number(n) - 1]));
    const out = execFileSync('psql', ['-X', '--csv', '-v', 'ON_ERROR_STOP=1', ...this.args, '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = parseCsv(out.trimEnd());
    let rowCount: number | null = null;
    const last = lines.at(-1)?.[0] ?? '';
    const tag = /^(INSERT \d+|UPDATE|DELETE) (\d+)$/.exec(last);
    if (tag) { rowCount = Number(tag[2]); lines.pop(); }
    const [header, ...data] = lines;
    const rows: any[] = header ? data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === '' ? null : r[i]]))) : [];
    return { rows, rowCount: rowCount ?? rows.length };
  }
  async end() {}
}
