/* Encrypted, account-free transfer via ntfy. Not a permanent backup service.
   Official API: https://docs.ntfy.sh/publish/ and https://docs.ntfy.sh/subscribe/api/ */
const SERVICE = 'https://ntfy.sh';
const PROTOCOL = 'hemis-planner-sync-v1';
const CHUNK_SIZE = 3450;
const MAX_PARTS = 16;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SYNC_INFO = Object.freeze({
  title: 'Зашифрованный перенос через ntfy.sh',
  description: 'Одинаковые ID студента и пароль синхронизации на двух устройствах открывают один канал. Сначала загрузите облачную копию, затем отправляйте изменения.',
  retention: 'ntfy хранит сообщения временно: по умолчанию около 12 часов. Это перенос между устройствами, не постоянный архив. Храните резервную копию JSON.',
  security: 'Данные шифруются AES-256-GCM до отправки. Ключ и адрес канала получаются через PBKDF2/SHA-256. Пароль и токен HEMIS не сохраняются и не отправляются. Выберите отдельный длинный пароль; восстановить его нельзя.',
  limits: 'До 16 частей по 3450 символов за отправку. Частые запросы могут временно ограничиваться. Изменения с двух устройств отправляйте по очереди: у ntfy нет атомарной блокировки записи.',
  notifications: 'Вечерние уведомления проверяются, пока приложение открыто. Браузер может задерживать фоновые вкладки. Для гарантированной доставки при закрытом приложении нужен push-сервер.',
  source: 'https://docs.ntfy.sh/publish/#message-caching',
  sources: ['https://docs.ntfy.sh/publish/', 'https://docs.ntfy.sh/subscribe/api/']
});

export class SyncError extends Error {
  constructor(message, code = 'SYNC_ERROR') { super(message); this.name = 'SyncError'; this.code = code; }
}

function bytesToBase64(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
function base64ToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new SyncError('Повреждена облачная копия.', 'CORRUPT');
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function safeSnapshot(state) {
  // The export schema intentionally excludes auth, tokens and crypto sessions.
  const forbidden = /^(?:password|passphrase|token|access_?token|refresh_?token|bearer|authorization|credentials|syncPassword|syncKey|secret|jwt)$/i;
  const scrub = (value, depth = 0) => {
    if (depth > 24) throw new SyncError('Данные слишком глубоко вложены.', 'INVALID_DATA');
    if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([key]) => !forbidden.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key)).map(([key, item]) => [key, scrub(item, depth + 1)]));
    }
    return value;
  };
  if (!state || state.version !== 1 || !Array.isArray(state.schedule) || !Array.isArray(state.subjects) || !Array.isArray(state.tasks)) {
    throw new SyncError('Неподдерживаемый формат данных планировщика.', 'INVALID_DATA');
  }
  const snapshot = {};
  for (const field of ['version', 'mode', 'profile', 'schedule', 'subjects', 'tasks', 'settings', 'updatedAt']) {
    if (state[field] !== undefined) snapshot[field] = scrub(state[field]);
  }
  return snapshot;
}

export class CloudSync {
  #studentId; #password; #key = null; #topic = ''; #onStatus;
  #observedRevision; #messages = new Map(); #cursor = null;
  #controllers = new Set(); #generation = 0; #busy = false; #lastPush = 0;

  constructor({ studentId, password, onStatus } = {}) {
    this.#studentId = String(studentId || '').trim().normalize('NFKC');
    this.#password = String(password || '');
    this.#onStatus = typeof onStatus === 'function' ? onStatus : () => {};
  }
  #status(state, message, extra = {}) { try { this.#onStatus({ state, message, ...extra }); } catch { /* UI callbacks cannot break a transfer. */ } }
  #assertConnected() { if (!this.#key || !this.#topic) throw new SyncError('Сначала подключите синхронизацию.', 'NOT_CONNECTED'); }
  #assertSession(generation) { if (generation !== this.#generation) throw new SyncError('Синхронизация отключена.', 'CANCELLED'); }

  async connect() {
    if (this.#key) return { provider: 'ntfy.sh', encrypted: true, retentionHours: 12 };
    if (!globalThis.crypto?.subtle) throw new SyncError('Шифрование доступно на HTTPS или localhost.', 'INSECURE_CONTEXT');
    if (!this.#studentId) throw new SyncError('Введите ID студента.', 'STUDENT_ID');
    if (this.#password.length < 8) throw new SyncError('Пароль синхронизации должен содержать хотя бы 8 символов. Лучше использовать длинную уникальную фразу.', 'PASSWORD');
    this.#status('connecting', 'Создаём ключ шифрования…');
    const generation = this.#generation;
    const material = await crypto.subtle.importKey('raw', encoder.encode(this.#password), 'PBKDF2', false, ['deriveBits']);
    const salt = encoder.encode(`${PROTOCOL}:student:${this.#studentId}`);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, material, 512));
    this.#assertSession(generation);
    const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const topic = `hp-${await digest(`${PROTOCOL}:topic:${bytesToBase64(bits.slice(32))}`)}`;
    bits.fill(0);
    this.#assertSession(generation);
    this.#key = key; this.#topic = topic;
    this.#password = ''; this.#studentId = '';
    this.#status('ready', 'Ключ готов. Загрузите копию или отправьте данные.');
    return { provider: 'ntfy.sh', encrypted: true, retentionHours: 12 };
  }

  async #request(path, body) {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const options = { method: body === undefined ? 'GET' : 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', signal: controller.signal, cache: 'no-store' };
      if (body !== undefined) { options.headers = { 'Content-Type': 'text/plain;charset=UTF-8' }; options.body = body; }
      const response = await fetch(`${SERVICE}/${this.#topic}${path}`, options);
      if (!response.ok) {
        if (response.status === 429) throw new SyncError('ntfy временно ограничил запросы. Подождите несколько минут; при дневном лимите используйте JSON-копию.', 'RATE_LIMIT');
        if (response.status === 413) throw new SyncError('Снимок слишком большой для ntfy. Используйте экспорт JSON.', 'TOO_LARGE');
        throw new SyncError(`Облачный сервис вернул HTTP ${response.status}. Попробуйте позже.`, 'HTTP_ERROR');
      }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new SyncError('Ответ облака слишком большой. Используйте JSON-копию.', 'TOO_LARGE');
      const text = await response.text();
      if (encoder.encode(text).byteLength > MAX_RESPONSE_BYTES) throw new SyncError('Ответ облака слишком большой. Используйте JSON-копию.', 'TOO_LARGE');
      return text;
    } catch (error) {
      if (error instanceof SyncError) throw error;
      if (controller.signal.aborted) throw new SyncError('Запрос прерван или облако не ответило за 25 секунд. Попробуйте снова.', 'TIMEOUT');
      throw new SyncError('Не удалось связаться с ntfy.sh. Проверьте интернет и доступность сервиса; локальные данные сохранены.', 'NETWORK');
    } finally { clearTimeout(timeout); this.#controllers.delete(controller); }
  }

  async #readRemote() {
    const since = this.#cursor || 'all';
    const response = await this.#request(`/json?poll=1&since=${encodeURIComponent(since)}`);
    for (const line of response.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.event !== 'message' || !event.id) continue;
      this.#cursor = event.id;
      if (typeof event.message !== 'string') continue;
      try {
        const envelope = JSON.parse(event.message);
        if (envelope.protocol !== PROTOCOL || !/^[a-f0-9]{32}$/.test(envelope.revision || '')) continue;
        this.#messages.set(event.id, { ...envelope, _expires: event.expires, _eventId: event.id });
      } catch { /* Ignore unrelated messages; no executable data is evaluated. */ }
    }
    const now = Date.now() / 1000;
    for (const [id, message] of this.#messages) if (message._expires && message._expires <= now) this.#messages.delete(id);
    if (this.#messages.size > 4096) throw new SyncError('Слишком много облачных сообщений. Создайте новый пароль канала или импортируйте JSON.', 'TOO_LARGE');
    const groups = new Map();
    const commits = [];
    for (const message of this.#messages.values()) {
      if (message.type === 'part' && Number.isInteger(message.index) && message.index >= 0 && message.index < MAX_PARTS && typeof message.data === 'string' && message.data.length <= CHUNK_SIZE) {
        if (!groups.has(message.revision)) groups.set(message.revision, new Map());
        groups.get(message.revision).set(message.index, message.data);
      } else if (message.type === 'commit' && Number.isInteger(message.parts) && message.parts > 0 && message.parts <= MAX_PARTS) commits.push(message);
    }
    // Server delivery order, not device clocks, determines the newest complete snapshot.
    for (const commit of commits.reverse()) {
      const parts = groups.get(commit.revision);
      if (!parts || parts.size !== commit.parts) continue;
      let ciphertext = '';
      for (let i = 0; i < commit.parts; i++) { if (!parts.has(i)) break; ciphertext += parts.get(i); }
      if (await digest(ciphertext) !== commit.hash) continue;
      return { ...commit, ciphertext };
    }
    return null;
  }

  #aad(revision, previousRevision, createdAt) { return encoder.encode(JSON.stringify({ protocol: PROTOCOL, revision, previousRevision, createdAt })); }

  async pull() {
    this.#assertConnected();
    if (this.#busy) throw new SyncError('Дождитесь текущей синхронизации.', 'BUSY');
    this.#busy = true;
    const generation = this.#generation;
    try {
      this.#status('downloading', 'Проверяем облачную копию…');
      const remote = await this.#readRemote();
      this.#assertSession(generation);
      if (!remote) {
        this.#observedRevision = null;
        this.#status('idle', 'Облачной копии нет или срок её хранения истёк. Локальные данные не изменены.');
        return null;
      }
      let plaintext;
      try {
        plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(remote.iv), additionalData: this.#aad(remote.revision, remote.previousRevision, remote.createdAt), tagLength: 128 }, this.#key, base64ToBytes(remote.ciphertext));
      } catch { throw new SyncError('Не удалось расшифровать копию. Проверьте ID и пароль или импортируйте резервную копию JSON.', 'DECRYPTION'); }
      this.#assertSession(generation);
      let state;
      try { state = safeSnapshot(JSON.parse(decoder.decode(plaintext))); } catch { throw new SyncError('Облачная копия повреждена или имеет неподдерживаемый формат.', 'INVALID_DATA'); }
      this.#observedRevision = remote.revision;
      this.#status('ready', 'Облачная копия загружена.', { revision: remote.revision });
      return state;
    } catch (error) { this.#status('error', error.message); throw error; }
    finally { this.#busy = false; }
  }

  async push(state, { force = false } = {}) {
    this.#assertConnected();
    if (this.#busy) throw new SyncError('Дождитесь текущей синхронизации.', 'BUSY');
    if (Date.now() - this.#lastPush < 30000) throw new SyncError('Между отправками нужно подождать 30 секунд, чтобы не исчерпать лимит сервиса.', 'COOLDOWN');
    const plaintext = encoder.encode(JSON.stringify(safeSnapshot(state)));
    if (plaintext.byteLength > Math.floor(MAX_PARTS * CHUNK_SIZE * 3 / 4) - 32) throw new SyncError('Данные превышают лимит переноса (около 40 КБ). Используйте экспорт и импорт JSON.', 'TOO_LARGE');
    this.#busy = true;
    const generation = this.#generation;
    try {
      this.#status('uploading', 'Проверяем изменения с другого устройства…');
      const remote = await this.#readRemote();
      this.#assertSession(generation);
      const remoteRevision = remote?.revision || null;
      if (!force && ((this.#observedRevision === undefined && remoteRevision !== null) || (this.#observedRevision !== undefined && remoteRevision !== this.#observedRevision && remoteRevision !== null))) {
        throw new SyncError('В облаке есть изменения с другого устройства. Сначала экспортируйте локальную JSON-копию, затем загрузите облачную и объедините нужные данные.', 'CONFLICT');
      }
      const revision = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const createdAt = new Date().toISOString();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.#aad(revision, remoteRevision, createdAt), tagLength: 128 }, this.#key, plaintext);
      this.#assertSession(generation);
      const ciphertext = bytesToBase64(new Uint8Array(encrypted));
      const parts = Math.ceil(ciphertext.length / CHUNK_SIZE);
      this.#lastPush = Date.now();
      for (let index = 0; index < parts; index++) {
        this.#assertSession(generation);
        this.#status('uploading', `Отправляем зашифрованную копию: ${index + 1}/${parts}…`, { part: index + 1, parts });
        await this.#request('', JSON.stringify({ protocol: PROTOCOL, type: 'part', revision, index, data: ciphertext.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE) }));
      }
      // Re-check before commit to catch a write that finished during this upload.
      const beforeCommit = await this.#readRemote();
      this.#assertSession(generation);
      if (!force && beforeCommit?.revision && beforeCommit.revision !== remoteRevision) throw new SyncError('Другое устройство успело отправить изменения. Ваша копия не опубликована; сохраните JSON и загрузите новую облачную копию.', 'CONFLICT');
      const commit = { protocol: PROTOCOL, type: 'commit', revision, previousRevision: remoteRevision, createdAt, parts, iv: bytesToBase64(iv), hash: await digest(ciphertext) };
      await this.#request('', JSON.stringify(commit));
      this.#assertSession(generation);
      this.#observedRevision = revision;
      this.#status('ready', 'Зашифрованная копия отправлена. Загрузите её на другом устройстве в течение срока хранения.', { revision });
      return { revision, parts, syncedAt: createdAt };
    } catch (error) { this.#status('error', error.message); throw error; }
    finally { this.#busy = false; }
  }

  disconnect() {
    this.#generation++;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear(); this.#key = null; this.#topic = ''; this.#password = ''; this.#studentId = '';
    this.#messages.clear(); this.#cursor = null; this.#observedRevision = undefined;
    this.#status('idle', 'Синхронизация отключена. Ключ удалён из памяти.');
  }
}
