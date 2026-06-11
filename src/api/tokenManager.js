import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError } from '../logger/index.js';
import { SESSION_DIR, ACCOUNTS_DIR, RATE_LIMIT_HOURS } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION_PATH = path.resolve(__dirname, '..', '..', SESSION_DIR);
const ACCOUNTS_PATH = path.join(SESSION_PATH, ACCOUNTS_DIR);
const TOKENS_FILE = path.join(SESSION_PATH, 'tokens.json');
const TOKENS_CACHE_TTL_MS = 1_000;

let pointer = 0;
let directoriesReady = false;
let tokensCache = [];
let tokensCacheMtimeMs = -1;
let tokensCacheCheckedAt = 0;

function ensureSessionDir() {
    if (directoriesReady) return;
    if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
    if (!fs.existsSync(ACCOUNTS_PATH)) fs.mkdirSync(ACCOUNTS_PATH, { recursive: true });
    directoriesReady = true;
}

function isTokenReady(token, now = Date.now()) {
    return !token.invalid && (!token.resetAt || Date.parse(token.resetAt) <= now);
}

export function loadTokens() {
    ensureSessionDir();
    const now = Date.now();

    if (now - tokensCacheCheckedAt < TOKENS_CACHE_TTL_MS) return tokensCache;

    try {
        const stat = fs.statSync(TOKENS_FILE);
        tokensCacheCheckedAt = now;

        if (stat.mtimeMs === tokensCacheMtimeMs) return tokensCache;

        tokensCache = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
        tokensCacheMtimeMs = stat.mtimeMs;
        return tokensCache;
    } catch (e) {
        if (e.code !== 'ENOENT') {
            logError('TokenManager: failed to read tokens.json', e);
        }
        tokensCache = [];
        tokensCacheMtimeMs = -1;
        tokensCacheCheckedAt = now;
        return tokensCache;
    }
}

export function saveTokens(tokens) {
    ensureSessionDir();
    try {
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
        tokensCache = tokens;
        tokensCacheMtimeMs = fs.statSync(TOKENS_FILE).mtimeMs;
        tokensCacheCheckedAt = Date.now();
    } catch (e) {
        logError('TokenManager: failed to save tokens.json', e);
    }
}

export async function getAvailableToken() {
    const tokens = loadTokens();
    const now = Date.now();
    const valid = tokens.filter(t => isTokenReady(t, now));
    if (!valid.length) return null;

    const token = valid[pointer % valid.length];
    pointer = (pointer + 1) % valid.length;
    return token;
}

export function getAvailableTokenById(id) {
    if (!id) return null;
    const now = Date.now();
    return loadTokens().find(t => t.id === id && isTokenReady(t, now)) || null;
}

export function hasValidTokens() {
    const now = Date.now();
    return loadTokens().some(t => isTokenReady(t, now));
}

export function markRateLimited(id, hours = RATE_LIMIT_HOURS) {
    const tokens = loadTokens();
    const token = tokens.find(t => t.id === id);
    if (!token) return;

    token.resetAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    saveTokens(tokens);
}

export function removeToken(id) {
    saveTokens(loadTokens().filter(t => t.id !== id));
}

export { removeToken as removeInvalidToken };

export function markInvalid(id) {
    const tokens = loadTokens();
    const token = tokens.find(t => t.id === id);
    if (!token) return;

    token.invalid = true;
    saveTokens(tokens);
}

export function markValid(id, newToken) {
    const tokens = loadTokens();
    const token = tokens.find(t => t.id === id);
    if (!token) return;

    token.invalid = false;
    token.resetAt = null;
    if (newToken) token.token = newToken;
    saveTokens(tokens);
}

export function listTokens() {
    return loadTokens();
}
