// Импорт аккаунтов из CSV-файла без запуска браузера.
// CSV-формат: email,status,password,...,<jwt_token>
// Запуск: node scripts/importCsvAccounts.js [путь_к_csv]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadTokens, saveTokens } from '../src/api/tokenManager.js';
import { SESSION_DIR, ACCOUNTS_DIR } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const csvPath = process.argv[2] || path.join(ROOT, 'Qwen.csv');

if (!fs.existsSync(csvPath)) {
    console.error(`CSV-файл не найден: ${csvPath}`);
    process.exit(1);
}

function parseJwtExpiry(token) {
    try {
        const payload = token.split('.')[1];
        const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
        return decoded.exp ? decoded.exp * 1000 : null;
    } catch {
        return null;
    }
}

function ensureAccountDir(id) {
    const dir = path.join(ROOT, SESSION_DIR, ACCOUNTS_DIR, id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
const header = lines[0].split(',');
const tokenColIndex = header.length - 1; // последняя колонка

const existing = loadTokens();
const existingTokens = new Set(existing.map(t => t.token));

let added = 0, skipped = 0, expired = 0, noToken = 0;

for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const email = cols[0]?.trim();
    const token = cols[tokenColIndex]?.trim();

    if (!token) { noToken++; continue; }

    if (existingTokens.has(token)) { skipped++; continue; }

    const expMs = parseJwtExpiry(token);
    if (expMs && expMs < Date.now()) {
        console.warn(`[EXPIRED] ${email} — токен истёк ${new Date(expMs).toISOString()}`);
        expired++;
        continue;
    }

    const id = 'acc_' + Buffer.from(email).toString('hex').slice(0, 16) + '_' + Date.now();
    const dir = ensureAccountDir(id);
    fs.writeFileSync(path.join(dir, 'token.txt'), token, 'utf8');

    existing.push({ id, token, resetAt: null });
    existingTokens.add(token);

    const expiresIn = expMs ? `истекает ${new Date(expMs).toLocaleDateString('ru-RU')}` : 'без expiry';
    console.log(`[+] ${email} → ${id} (${expiresIn})`);
    added++;
}

saveTokens(existing);

console.log(`\nИтого: добавлено ${added}, пропущено дублей ${skipped}, истекших ${expired}, без токена ${noToken}`);
console.log(`Всего аккаунтов в пуле: ${existing.length}`);
