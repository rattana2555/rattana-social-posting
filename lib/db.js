import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DATA_DIR = path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const empty = () => ({ settings: {}, accounts: [], posts: [] });

function load() {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('อ่าน data/db.json ไม่ได้ เริ่มฐานข้อมูลใหม่:', e.message);
    return empty();
  }
}

export const db = load();

export function save() {
  const json = JSON.stringify(db, null, 2);
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, DB_FILE);
  } catch {
    // Windows can refuse the rename while another process holds the file; fall back to a direct write
    fs.writeFileSync(DB_FILE, json);
  }
}

export const newId = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');
