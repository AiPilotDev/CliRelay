import { getAvailableToken, markRateLimited, removeInvalidToken } from './tokenManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logError, logWarn, logDebug, logRaw } from '../logger/index.js';
import crypto from 'crypto';
import {
    CHAT_API_URL, CREATE_CHAT_URL, TASK_STATUS_URL,
    RETRY_DELAY,
    DEFAULT_MODEL, MAX_RETRY_COUNT,
    TASK_POLL_MAX_ATTEMPTS, TASK_POLL_INTERVAL,
    RATE_LIMIT_HOURS
} from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_FILE = path.join(__dirname, '..', 'AvailableModels.txt');
const AUTH_KEYS_FILE = path.join(__dirname, '..', 'Authorization.txt');

let authToken = null;
let availableModels = null;
let availableModelSet = null;
let availableModelResponse = null;
let openAIModelResponse = null;
let authKeys = null;
let authKeySet = null;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function buildQwenHeaders(token) {
    return {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Version': '0.2.63',
        'source': 'desktop',
        'Timezone': new Date().toString().replace(/\s*\(.+\)$/, ''),
        'X-Request-Id': crypto.randomUUID(),
        'X-Accel-Buffering': 'no'
    };
}

function buildQwenStreamingHeaders(token) {
    return {
        ...buildQwenHeaders(token),
        'Accept': 'text/event-stream, application/json'
    };
}

async function readQwenResponse(response) {
    const bodyText = await response.text();
    const trimmed = bodyText.trim();
    let data = null;

    if (trimmed) {
        try {
            data = JSON.parse(trimmed);
        } catch {
            data = null;
        }
    }

    return { bodyText, data };
}

function compactLogValue(value, maxLength = 500) {
    if (value === null || value === undefined || value === '') return 'no details';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function extractCreatedChatId(data) {
    return data?.data?.id || data?.chat_id || data?.id || null;
}

function isWafChallengeBody(body) {
    const text = String(body || '').toLowerCase();
    return text.includes('aliyun_waf') ||
        text.includes('x5sec') ||
        text.includes('waf') && text.includes('<html') ||
        text.includes('punish') && text.includes('aliyun');
}

// ─── Page helpers ────────────────────────────────────────────────────────────

export const pagePool = {
    async getPage() {
        throw new Error('Browser page pool is disabled. Use token-based Qwen requests.');
    },

    releasePage() {},

    async clear() {}
};

async function fetchTaskStatusWithNode(taskId, token) {
    try {
        if (!token) return { success: false, error: 'Authorization token not found' };
        if (typeof fetch !== 'function') return { success: false, error: 'Fetch API is unavailable' };

        const response = await fetch(`${TASK_STATUS_URL}/${taskId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            return { success: false, status: response.status, error: await response.text() };
        }

        return { success: true, data: await response.json() };
    } catch (error) {
        return { success: false, error: error.toString() };
    }
}

export async function pollTaskStatus(taskId, token, maxAttempts = TASK_POLL_MAX_ATTEMPTS, interval = TASK_POLL_INTERVAL) {
    logInfo(`Начинаем опрос статуса задачи: ${taskId}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            let result = await fetchTaskStatusWithNode(taskId, token);

            if (!result.success) {
                logWarn(`Ошибка при проверке статуса (попытка ${attempt}/${maxAttempts}): ${result.error}`);
                if (attempt < maxAttempts) await delay(interval);
                continue;
            }

            const taskData = result.data;
            const taskStatus = taskData.task_status || taskData.status || 'unknown';
            logDebug(`Статус задачи (${attempt}/${maxAttempts}): ${taskStatus}`);

            if (taskStatus === 'completed' || taskStatus === 'success') {
                logInfo('Задача завершена успешно');
                return { success: true, status: 'completed', data: taskData };
            }

            if (taskStatus === 'failed' || taskStatus === 'error') {
                logError('Задача завершилась с ошибкой');
                return { success: false, status: 'failed', error: taskData.error || taskData.message || 'Задача завершилась ошибкой', data: taskData };
            }

            if (attempt < maxAttempts) await delay(interval);
        } catch (error) {
            logError(`Ошибка при опросе задачи (попытка ${attempt}/${maxAttempts})`, error);
            if (attempt < maxAttempts) await delay(interval);
        }
    }

    logError(`Превышен лимит попыток (${maxAttempts}) для задачи ${taskId}`);
    return { success: false, status: 'timeout', error: 'Превышен таймаут polling задачи' };
}

// ─── Token extraction ────────────────────────────────────────────────────────

export async function extractAuthToken() {
    return authToken;
}

export function getAvailableModelsFromFile() {
    try {
        if (!fs.existsSync(MODELS_FILE)) {
            logError(`Файл с моделями не найден: ${MODELS_FILE}`);
            return [DEFAULT_MODEL];
        }
        const models = fs.readFileSync(MODELS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));

        logInfo('===== ДОСТУПНЫЕ МОДЕЛИ =====');
        models.forEach(m => logInfo(`- ${m}`));
        logInfo('============================');
        availableModels = models;
        availableModelSet = new Set(models);
        availableModelResponse = null;
        openAIModelResponse = null;
        return models;
    } catch (error) {
        logError('Ошибка при чтении файла с моделями', error);
        return [DEFAULT_MODEL];
    }
}

function getAuthKeysFromFile() {
    try {
        if (!fs.existsSync(AUTH_KEYS_FILE)) {
            const template = `# Файл API-ключей для прокси\n# --------------------------------------------\n# В этом файле перечислены токены, которые\n# прокси будет считать «действительными».\n# Один ключ — одна строка без пробелов.\n#\n# 1) Хотите ОТКЛЮЧИТЬ авторизацию целиком?\n#    Оставьте файл пустым — сервер перестанет\n#    проверять заголовок Authorization.\n#\n# 2) Хотите разрешить доступ нескольким людям?\n#    Впишите каждый ключ в отдельной строке:\n#      d35ab3e1-a6f9-4d...\n#      f2b1cd9c-1b2e-4a...\n#\n# Пустые строки и строки, начинающиеся с «#»,\n# игнорируются.`;
            try {
                fs.writeFileSync(AUTH_KEYS_FILE, template, { encoding: 'utf8', flag: 'wx' });
                logInfo(`Создан шаблон файла ключей: ${AUTH_KEYS_FILE}`);
            } catch (e) {
                logError('Не удалось создать шаблон Authorization.txt', e);
            }
            return [];
        }
        return fs.readFileSync(AUTH_KEYS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
    } catch (error) {
        logError('Ошибка при чтении файла с ключами авторизации', error);
        return [];
    }
}

export function isValidModel(modelName) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    if (!availableModelSet) availableModelSet = new Set(availableModels);
    return availableModelSet.has(modelName);
}

export function getAllModels() {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    if (availableModelResponse) return availableModelResponse;
    availableModelResponse = {
        models: availableModels.map(model => ({
            id: model,
            name: model,
            description: `Модель ${model}`
        }))
    };
    return availableModelResponse;
}

export function getOpenAIModels() {
    if (openAIModelResponse) return openAIModelResponse;

    openAIModelResponse = {
        object: 'list',
        data: getAllModels().models.map(m => ({
            id: m.id || m.name || m,
            object: 'model',
            created: 0,
            owned_by: 'qwen',
            permission: []
        }))
    };
    return openAIModelResponse;
}

export function getApiKeys() {
    if (!authKeys) {
        authKeys = getAuthKeysFromFile();
        authKeySet = new Set(authKeys);
    }
    return authKeys;
}

export function isValidApiKey(token) {
    if (!authKeys) getApiKeys();
    return authKeySet.has(token);
}

// ─── sendMessage — helper functions ──────────────────────────────────────────

function validateAndPrepareMessage(message) {
    if (message === null || message === undefined) {
        return { error: 'Сообщение не может быть пустым' };
    }
    if (typeof message === 'string') return { content: message };
    if (Array.isArray(message)) {
        const isValid = message.every(item =>
            (item.type === 'text' && typeof item.text === 'string') ||
            (item.type === 'image' && typeof item.image === 'string') ||
            (item.type === 'file' && typeof item.file === 'string')
        );
        if (!isValid) return { error: 'Некорректная структура составного сообщения' };
        return { content: message };
    }
    return { error: 'Неподдерживаемый формат сообщения' };
}

async function resolveAuthToken() {
    const tokenObj = await getAvailableToken();
    if (tokenObj?.token) {
        authToken = tokenObj.token;
        logInfo(`Используется аккаунт: ${tokenObj.id}`);
        return tokenObj;
    }

    return null;
}

function buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType = 't2t', size = null) {
    const userMessageId = crypto.randomUUID();

    const isVideo = chatType === 't2v';

    const featureConfig = {
        thinking_enabled: isVideo,
        output_schema: 'phase',
        research_mode: 'normal',
        auto_search: false
    };
    if (isVideo) {
        featureConfig.auto_thinking = true;
        featureConfig.thinking_format = 'summary';
        featureConfig.auto_search = true;
    }

    const newMessage = {
        fid: userMessageId,
        childrenIds: [],
        role: 'user',
        content: messageContent,
        user_action: 'chat',
        timestamp: Math.floor(Date.now() / 1000),
        models: [model],
        chat_type: chatType,
        feature_config: featureConfig,
        extra: { meta: { subChatType: chatType } },
        sub_chat_type: chatType
    };

    if (files && files.length > 0) newMessage.files = files;

    const payload = {
        stream: !isVideo,
        version: '2.1',
        incremental_output: true,
        chat_mode: 'normal',
        model,
        chat_id: chatId,
        timestamp: Math.floor(Date.now() / 1000),
        messages: [newMessage]
    };

    if (size) payload.size = size;

    if (systemMessage) {
        payload.system_message = systemMessage;
        logDebug(`System message: ${systemMessage.substring(0, 100)}${systemMessage.length > 100 ? '...' : ''}`);
    }
    if (tools && Array.isArray(tools) && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = toolChoice || 'auto';
    }

    return payload;
}

function parseNonSseCompletionBody(body) {
    if (typeof body === 'string' && body.includes('data:')) {
        const responseOrder = [];
        const responseIndexes = new Map();
        const contentByResponseId = new Map();
        let usage = null;

        for (const rawLine of body.split('\n')) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;

            const jsonStr = line.substring(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;

            try {
                const chunk = JSON.parse(jsonStr);
                if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
                    return { success: false, status: 429, errorBody: JSON.stringify(chunk) };
                }
                if (chunk.error && !chunk.choices) {
                    return { success: false, status: 500, errorBody: JSON.stringify(chunk) };
                }

                const created = chunk['response.created'];
                if (created?.response_id) {
                    responseOrder.push(created.response_id);
                    responseIndexes.set(created.response_id, String(created.response_index ?? ''));
                    continue;
                }
                if (chunk.usage) usage = chunk.usage;

                const delta = chunk.choices?.[0]?.delta;
                if (delta?.phase && delta.phase !== 'answer') continue;
                if (typeof delta?.content === 'string') {
                    const responseId = chunk.response_id || 'default';
                    if (!responseOrder.includes(responseId)) responseOrder.push(responseId);
                    contentByResponseId.set(responseId, `${contentByResponseId.get(responseId) || ''}${delta.content}`);
                }
            } catch {
                // Ignore malformed SSE lines and keep parsing the rest.
            }
        }

        const responseId = responseOrder.find(id => responseIndexes.get(id) === '0') ||
            responseOrder.find(id => (contentByResponseId.get(id) || '').trim() !== '') ||
            null;
        const fullContent = responseId ? (contentByResponseId.get(responseId) || '') : '';

        if (fullContent || responseId) {
            return {
                success: true,
                isTask: false,
                data: {
                    id: responseId || 'chatcmpl-' + Date.now(),
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
                    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    response_id: responseId
                }
            };
        }
    }

    try {
        const parsed = JSON.parse(body);
        const topLevelCode = parsed?.code;
        const nestedCode = parsed?.data?.code;
        const retCodes = Array.isArray(parsed?.ret) ? parsed.ret : [];
        const hasStructuredError =
            parsed?.success === false ||
            Boolean(parsed?.error) ||
            Boolean(parsed?.data?.error) ||
            Boolean(topLevelCode) ||
            Boolean(nestedCode) ||
            retCodes.length > 0;

        if (hasStructuredError) {
            const isRateLimited = topLevelCode === 'RateLimited' || nestedCode === 'RateLimited';
            const needsValidation = retCodes.some(code => String(code).includes('VALIDATE')) ||
                Boolean(parsed?.data?.url && String(parsed.data.url).includes('captcha'));
            return {
                success: false,
                status: isRateLimited ? 429 : needsValidation ? 403 : 500,
                errorBody: body
            };
        }

        if (parsed.choices || parsed.id || (parsed.success === true && parsed.data)) {
            return { success: true, isTask: false, data: parsed };
        }
    } catch {
        // Ignore parse errors here and return a generic failure below.
    }

    return { success: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
}

async function executeApiRequestWithNodeStreaming(apiUrl, payload, token, onChunk) {
    try {
        if (!token) return { success: false, error: 'Authorization token not found' };
        if (typeof fetch !== 'function') return { success: false, error: 'Fetch API is unavailable' };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: buildQwenStreamingHeaders(token),
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            return { success: false, status: response.status, statusText: response.statusText, errorBody: await response.text() };
        }

        if (payload.stream === false) {
            const jsonResponse = await response.json();
            if (jsonResponse.code === 'RateLimited' || jsonResponse.error) {
                return { success: false, status: 429, errorBody: JSON.stringify(jsonResponse) };
            }
            return { success: true, isTask: true, data: jsonResponse };
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
            const body = await response.text();
            if (isWafChallengeBody(body)) {
                return {
                    success: false,
                    status: response.status,
                    statusText: response.statusText,
                    wafChallenge: true,
                    error: 'Qwen returned Aliyun WAF challenge HTML.',
                    errorBody: body
                };
            }
            return parseNonSseCompletionBody(body);
        }

        const reader = response.body?.getReader?.();
        if (!reader) {
            const body = await response.text();
            if (isWafChallengeBody(body)) {
                return {
                    success: false,
                    status: response.status,
                    statusText: response.statusText,
                    wafChallenge: true,
                    error: 'Qwen returned Aliyun WAF challenge HTML.',
                    errorBody: body
                };
            }
            return parseNonSseCompletionBody(body);
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        let responseId = null;
        let primaryResponseId = null;
        const responseIndexes = new Map();
        let usage = null;
        let finished = false;
        let streamError = null;
        let hasStreamedChunks = false;

        while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line || !line.startsWith('data:')) continue;

                const jsonStr = line.substring(5).trim();
                if (!jsonStr) continue;
                if (jsonStr === '[DONE]') {
                    finished = true;
                    break;
                }

                try {
                    const chunk = JSON.parse(jsonStr);

                    if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
                        streamError = { status: 429, errorBody: JSON.stringify(chunk) };
                        finished = true;
                        break;
                    }
                    if (chunk.error && !chunk.choices) {
                        streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                        finished = true;
                        break;
                    }

                    const created = chunk['response.created'];
                    if (created?.response_id) {
                        responseIndexes.set(created.response_id, String(created.response_index ?? ''));
                        if (String(created.response_index ?? '') === '0' || !primaryResponseId) {
                            primaryResponseId = created.response_id;
                            responseId = created.response_id;
                        }
                        continue;
                    }

                    const delta = chunk.choices?.[0]?.delta;
                    if (delta?.phase && delta.phase !== 'answer') continue;
                    const chunkResponseId = chunk.response_id || responseId || 'default';
                    if (responseIndexes.size > 0 && primaryResponseId && chunkResponseId !== primaryResponseId) {
                        continue;
                    }
                    if (delta?.content) {
                        responseId = chunkResponseId;
                        fullContent += delta.content;
                        if (typeof onChunk === 'function') {
                            onChunk(delta.content);
                            hasStreamedChunks = true;
                        }
                    }
                    if (delta?.status === 'finished' || chunk.choices?.[0]?.finish_reason) finished = true;
                    if (chunk.usage) usage = chunk.usage;
                } catch {
                    // Ignore malformed SSE chunks.
                }
            }
        }

        if (streamError) {
            return { success: false, ...streamError, hasStreamedChunks };
        }

        return {
            success: true,
            isTask: false,
            hasStreamedChunks,
            data: {
                id: responseId || 'chatcmpl-' + Date.now(),
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: payload.model,
                choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
                usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                response_id: responseId
            }
        };
    } catch (error) {
        return { success: false, error: error.toString() };
    }
}

async function executeApiRequest(apiUrl, payload, token, onChunk = null) {
    return executeApiRequestWithNodeStreaming(apiUrl, payload, token, onChunk);
}

async function handleApiError(response, tokenObj, message, model, chatId, parentId, files, retryCount, chatType, size, waitForCompletion, onChunk = null) {
    logRaw(JSON.stringify(response));    logError(`Ошибка при получении ответа: ${response.error || response.statusText}`);
    if (response.errorBody) logDebug(`Тело ответа с ошибкой: ${response.errorBody}`);

    if (response.html && response.html.includes('Verification')) {        logInfo('Обнаружена необходимость верификации, перезапуск браузера в видимом режиме...');
        authToken = null;
        return { error: 'Qwen requires verification/captcha for this account or request.', verification: true, chatId };
    }

    if (response.status === 403 && response.errorBody && (response.errorBody.includes('FAIL_SYS_USER_VALIDATE') || response.errorBody.includes('captcha'))) {        authToken = null;
        return {
            error: 'Qwen requires verification/captcha for this account or request.',
            verification: true,
            chatId,
            details: response.errorBody
        };
    }

    if (response.status === 401 || (response.errorBody && (response.errorBody.includes('Unauthorized') || response.errorBody.includes('Token has expired')))) {
        logWarn(`Токен ${tokenObj?.id} недействителен (401). Удаляем и пробуем другой.`);
        authToken = null;
        if (tokenObj?.id) {
            const { markInvalid } = await import('./tokenManager.js');
            markInvalid(tokenObj.id);
        }
        const { hasValidTokens } = await import('./tokenManager.js');
        if (hasValidTokens() && retryCount < MAX_RETRY_COUNT) {
            return sendMessage(message, model, null, null, files, null, null, null, chatType, size, waitForCompletion, retryCount + 1, onChunk);
        }
        logError('Не осталось валидных токенов или исчерпаны попытки.');
        return { error: 'Все токены недействительны (401). Требуется повторная авторизация.', chatId };
    }

    if (response.status === 429 || (response.errorBody && response.errorBody.includes('RateLimited'))) {
        let hours = RATE_LIMIT_HOURS;
        try {
            const rateInfo = JSON.parse(response.errorBody);
            hours = Number(rateInfo.num) || RATE_LIMIT_HOURS;
        } catch { /* errorBody might not be valid JSON */ }
        if (tokenObj?.id) {
            markRateLimited(tokenObj.id, hours);
            logWarn(`Токен ${tokenObj.id} достиг лимита. Помечаем на ${hours}ч и пробуем другой токен...`);
        }

        authToken = null;
        const { hasValidTokens } = await import('./tokenManager.js');
        if (hasValidTokens() && retryCount < MAX_RETRY_COUNT) {
            return sendMessage(message, model, null, null, files, null, null, null, chatType, size, waitForCompletion, retryCount + 1, onChunk);
        }
        return { error: `Все токены заблокированы по лимиту (${hours}ч)`, chatId };
    }

    if (response.errorBody && response.errorBody.includes('The chat is in progress') && retryCount < MAX_RETRY_COUNT) {
        logWarn(`Qwen chat ${chatId} is still processing. Retrying ${retryCount + 1}/${MAX_RETRY_COUNT} after ${RETRY_DELAY}ms...`);
        await delay(RETRY_DELAY);
        return sendMessage(message, model, chatId, parentId, files, null, null, null, chatType, size, waitForCompletion, retryCount + 1, onChunk);
    }

    return { error: response.error || response.statusText || 'Qwen API request failed', details: response.errorBody || 'Нет дополнительных деталей', chatId };
}

// ─── Main public API ─────────────────────────────────────────────────────────

export async function sendMessage(message, model = DEFAULT_MODEL, chatId = null, parentId = null, files = null, tools = null, toolChoice = null, systemMessage = null, chatType = 't2t', size = null, waitForCompletion = true, retryCount = 0, onChunk = null) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();

    // Резолвим аккаунт ОДИН раз: одним и тем же токеном создаём чат и
    // отправляем сообщение — иначе round-robin разнесёт их по разным
    // аккаунтам и Qwen вернёт «chat is not exist».
    const tokenObj = await resolveAuthToken();
    if (!tokenObj) return { error: 'Ошибка авторизации: не удалось получить токен', chatId };

    const requestToken = tokenObj.token;

    if (!chatId) {
        const newChatResult = await createChatV2(model, 'Новый чат', 0, chatType, tokenObj);
        if (newChatResult.error) return { error: 'Не удалось создать чат: ' + newChatResult.error };
        chatId = newChatResult.chatId;
        logInfo(`Создан новый чат v2 с ID: ${chatId}`);
    }

    const validated = validateAndPrepareMessage(message);
    if (validated.error) {
        logError(validated.error);
        return { error: validated.error, chatId };
    }
    const messageContent = validated.content;

    if (!model || model.trim() === '') {
        model = DEFAULT_MODEL;
    } else if (!isValidModel(model)) {
        logWarn(`Модель "${model}" не найдена в списке доступных. Используется модель по умолчанию.`);
        model = DEFAULT_MODEL;
    }
    logInfo(`Используемая модель: "${model}"`);
    if (chatType !== 't2t') {
        const typeLabels = { t2i: 'изображение', t2v: 'видео' };
        logInfo(`Тип генерации: ${chatType} (${typeLabels[chatType] || chatType})${size ? `, размер: ${size}` : ''}`);
    }
    try {
        logInfo('Sending request to Qwen API v2...');

        const payload = buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType, size);
        logDebug('=== PAYLOAD V2 ===\n' + JSON.stringify(payload, null, 2));
        logDebug(`Отправка сообщения в чат ${chatId} с parent_id: ${parentId || 'null'}`);

        const apiUrl = `${CHAT_API_URL}?chat_id=${chatId}`;
        let response = await executeApiRequest(apiUrl, payload, requestToken, onChunk);

        if (response.success && response.isTask) {
            logInfo('Обнаружен ответ с задачей (видеогенерация)');
            logRaw(JSON.stringify(response.data));

            const taskId = extractTaskId(response.data);
            if (!taskId) {
                logError('Task ID не найден в ответе');
                return { error: 'Task ID не найден в ответе', chatId, rawResponse: response.data };
            }

            logInfo(`Task ID: ${taskId}`);

            if (!waitForCompletion) {
                logInfo('Возвращаем task_id для клиентского polling');
                return {
                    id: taskId,
                    object: 'chat.completion.task',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    task_id: taskId,
                    chatId,
                    parentId: response.data.data?.parent_id || taskId,
                    status: 'processing',
                    message: 'Задача генерации видео создана. Для прогресса используйте GET /api/tasks/status/:taskId.'
                };
            }

            logInfo('Начинаем polling для получения видео...');
            const taskResult = await pollTaskStatus(taskId, requestToken);

            if (taskResult.success && taskResult.status === 'completed') {
                logInfo('Видео успешно сгенерировано');
                const videoUrl = extractVideoUrl(taskResult.data);
                return {
                    id: taskId,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: videoUrl || JSON.stringify(taskResult.data) },
                        finish_reason: 'stop'
                    }],
                    usage: taskResult.data.usage || { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 },
                    response_id: taskId,
                    chatId,
                    parentId: taskId,
                    task_id: taskId,
                    video_url: videoUrl
                };
            }

            logError(`Не удалось получить видео: ${taskResult.error}`);
            return { error: taskResult.error || 'Video generation failed', status: taskResult.status, chatId, task_id: taskId };
        }

        if (response.success) {
            logRaw(JSON.stringify(response.data));
            logInfo('Ответ получен успешно');
            response.data.chatId = chatId;
            response.data.parentId = response.data.response_id;
            response.data.id = response.data.id || 'chatcmpl-' + Date.now();
            
            // Fallback: если поток чанков не был отдан, отправляем контент единым куском.
            if (typeof onChunk === 'function' && response.data.choices?.[0]?.message?.content && !response.hasStreamedChunks) {
                onChunk(response.data.choices[0].message.content);
            }
            
            return response.data;
        }

        return handleApiError(response, tokenObj, message, model, chatId, parentId, files, retryCount, chatType, size, waitForCompletion, onChunk);
    } catch (error) {
        logError('Ошибка при отправке сообщения', error);
        return { error: error.toString(), chatId };
    }
}

// ─── Task response helpers ───────────────────────────────────────────────────

function extractTaskId(data) {
    const firstMsg = data.data?.messages?.[0];
    if (firstMsg?.extra?.wanx?.task_id) return firstMsg.extra.wanx.task_id;
    return data.id || data.task_id || data.response_id || data.data?.message_id || null;
}

function findMediaUrl(value, extensions = ['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp']) {
    if (!value) return null;
    if (typeof value === 'string') {
        const direct = value.match(/https?:\/\/[^\s"'<>]+/g)?.find(url => extensions.some(ext => url.toLowerCase().includes(ext)));
        return direct || null;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findMediaUrl(item, extensions);
            if (found) return found;
        }
        return null;
    }
    if (typeof value === 'object') {
        const preferredKeys = ['video_url', 'image_url', 'url', 'content', 'result', 'output', 'data', 'message'];
        for (const key of preferredKeys) {
            if (key in value) {
                const found = findMediaUrl(value[key], extensions);
                if (found) return found;
            }
        }
        for (const item of Object.values(value)) {
            const found = findMediaUrl(item, extensions);
            if (found) return found;
        }
    }
    return null;
}

export function extractMediaUrl(value, type = 'any') {
    const extensions = type === 'video'
        ? ['.mp4', '.mov', '.webm']
        : type === 'image'
            ? ['.png', '.jpg', '.jpeg', '.webp']
            : ['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp'];
    return findMediaUrl(value, extensions);
}

function extractVideoUrl(taskData) {
    return extractMediaUrl(taskData, 'video');
}

export async function pollQwenTaskStatus(taskId, waitForCompletion = false) {

    const tokenObj = await resolveAuthToken();
    if (!tokenObj?.token) return { error: 'Ошибка авторизации: не удалось получить токен', task_id: taskId };
    const result = waitForCompletion
        ? await pollTaskStatus(taskId, tokenObj.token)
        : await pollTaskStatus(taskId, tokenObj.token, 1, 0);

    const mediaUrl = extractMediaUrl(result.data || result, 'video') || extractMediaUrl(result.data || result, 'image');
    availableModelResponse = {
        task_id: taskId,
        success: result.success,
        status: result.status,
        error: result.error,
        video_url: extractMediaUrl(result.data || result, 'video'),
        image_url: extractMediaUrl(result.data || result, 'image'),
        media_url: mediaUrl,
        data: result.data
    };
}

export async function clearPagePool() {
    await pagePool.clear();
}

export function getAuthToken() {
    return authToken;
}

// ─── createChatV2 ────────────────────────────────────────────────────────────

async function createChatWithNodeFetch(payload, token) {
    try {
        if (!token) return { success: false, error: 'Authorization token not found' };
        if (typeof fetch !== 'function') return { success: false, error: 'Fetch API is unavailable' };

        const response = await fetch(CREATE_CHAT_URL, {
            method: 'POST',
            headers: buildQwenHeaders(token),
            body: JSON.stringify({})
        });
        const { bodyText, data } = await readQwenResponse(response);

        if (isWafChallengeBody(bodyText)) {
            return {
                success: false,
                status: response.status,
                statusText: response.statusText,
                wafChallenge: true,
                error: 'Qwen returned Aliyun WAF challenge HTML for the token-only request.',
                errorBody: bodyText
            };
        }

        if (response.ok) {
            return { success: true, status: response.status, statusText: response.statusText, data, body: bodyText };
        }

        return { success: false, status: response.status, statusText: response.statusText, errorBody: bodyText, data };
    } catch (error) {
        return {
            success: false,
            error: error.message || error.toString(),
            cause: error.cause?.code || error.cause?.message || null
        };
    }
}

export async function createChatV2(model = DEFAULT_MODEL, title = 'Новый чат', retryCount = 0, chatType = 't2t', tokenObj = null) {

    // tokenObj может прийти от sendMessage — тогда создание чата и отправка
    // идут под ОДНИМ аккаунтом (иначе round-robin создаст чат на одном
    // аккаунте, а сообщение уйдёт под другим → «chat is not exist»).
    if (!tokenObj) tokenObj = await getAvailableToken();
    if (!tokenObj?.token) return { error: 'No available token' };
    if (tokenObj?.token) {
        authToken = tokenObj.token;
        logInfo(`Используется аккаунт для создания чата: ${tokenObj.id}`);
    }

    if (!tokenObj?.token) return { error: 'No available token' };
    const requestToken = tokenObj.token;
    try {
        const payload = { title, models: [model], chat_mode: 'normal', chat_type: chatType, timestamp: Date.now() };
        let result = await createChatWithNodeFetch(payload, requestToken);

        const createdChatId = result.success ? extractCreatedChatId(result.data) : null;
        if (createdChatId) {
            logInfo(`Чат создан: ${createdChatId}`);
            return { success: true, chatId: createdChatId, requestId: result.data?.request_id, tokenId: tokenObj?.id };
        }

        const isNetworkError = !result.status && Boolean(result.error);
        const isTransient = isNetworkError || (result.status >= 500 && result.status < 600);
        if (isTransient && retryCount < MAX_RETRY_COUNT) {
            logWarn(`Создание чата: ${result.status || result.error || 'network error'}, ретрай ${retryCount + 1}/${MAX_RETRY_COUNT} через ${RETRY_DELAY}мс...`);
            await delay(RETRY_DELAY);
            return createChatV2(model, title, retryCount + 1, chatType, tokenObj);
        }

        const cleanError = result.wafChallenge
            ? 'Qwen вернул Aliyun WAF challenge вместо JSON для token-only запроса.'
            : isTransient
            ? `Qwen API недоступен (${result.status || result.error}). Повторите позже.`
            : (result.errorBody || result.error || result.body || 'Неизвестная ошибка');
        const detail = result.wafChallenge
            ? 'Aliyun WAF challenge HTML'
            : (result.errorBody || result.error || result.body || result.data || result.statusText || result.cause);
        logError(`Ошибка при создании чата: ${result.status || result.error || 'unknown'} (попытка ${retryCount + 1}); details=${compactLogValue(detail)}`);
        return { error: cleanError };
    } catch (error) {
        logError('Ошибка при создании чата', error);
        return { error: error.toString() };
    }
}

// ─── testToken ───────────────────────────────────────────────────────────────

export async function testToken(token) {
    if (!token) return 'UNAUTHORIZED';
    try {
        const response = await fetch(CHAT_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'Accept': '*/*'
            },
            body: JSON.stringify({
                chat_type: 't2t',
                messages: [{ role: 'user', content: 'ping', chat_type: 't2t' }],
                model: DEFAULT_MODEL,
                stream: false
            })
        });

        if (response.ok || response.status === 400) return 'OK';
        if (response.status === 401 || response.status === 403) return 'UNAUTHORIZED';
        if (response.status === 429) return 'RATELIMIT';
        return 'ERROR';
    } catch (e) {
        logError('testToken error', e);
        return 'ERROR';
    }
}
