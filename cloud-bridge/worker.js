/* HEMIS Planner HTTPS bridge. Deploy as a Cloudflare Worker.
   Configure BRIDGE_KEY as a secret and ALLOWED_ORIGINS as a text variable.
   Never add console logging of request bodies, keys, tokens or upstream responses. */
const VERSION = '2026.10.20.5';
const DEFAULT_HOSTS = ['student.tift.uz', 'xmn.tuit.uz', 'student.tdtu.uz', 'talaba.tsue.uz', 'hstudent.nuu.uz', 'student.hemis.uz'];
const MAX_REQUEST = 16384;
const MAX_RESPONSE = 5 * 1024 * 1024;
const encoder = new TextEncoder();
const traffic = new Map();

class BridgeError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}
function values(value) { return String(value || '').split(/[\s,]+/).map(item => item.trim()).filter(Boolean); }
function headersFor(origin) {
  const headers = new Headers({'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  return headers;
}
function json(value, origin, status = 200) { return new Response(JSON.stringify(value), {status, headers:headersFor(origin)}); }
async function smallText(message, limit) {
  const declared = Number(message.headers.get('content-length'));
  if (declared > limit) throw new BridgeError('Размер данных превышает лимит моста.', 'TOO_LARGE', 413);
  if (!message.body) return '';
  const reader = message.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new BridgeError('Размер данных превышает лимит моста.', 'TOO_LARGE', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
async function sameKey(a, b) {
  const [left,right] = await Promise.all([a,b].map(value => crypto.subtle.digest('SHA-256',encoder.encode(value))));
  const x = new Uint8Array(left), y = new Uint8Array(right);
  let difference = 0;
  for (let i=0;i<x.length;i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
function rateLimit(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  if (traffic.size > 4096) for (const [key,item] of traffic) if (item.until < now) traffic.delete(key);
  const item = traffic.get(ip);
  if (!item || item.until < now) { traffic.set(ip,{until:now+60000,count:1}); return; }
  if (++item.count > 40) throw new BridgeError('Слишком много запросов к мосту. Подождите минуту.', 'RATE_LIMIT', 429);
}
function targetFor(value, env) {
  let target;
  try { target = new URL(value); } catch { throw new BridgeError('Некорректный адрес HEMIS.', 'TARGET_INVALID'); }
  const allowed = new Set([...DEFAULT_HOSTS,...values(env.ALLOWED_HOSTS)].map(host=>host.toLowerCase()));
  if (target.protocol !== 'https:' || target.username || target.password || target.port || target.hash || !allowed.has(target.hostname) || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(target.hostname)) {
    throw new BridgeError('Этот портал не разрешён владельцем моста.', 'TARGET_FORBIDDEN',403);
  }
  if (!/^\/rest\/v1\/(auth\/login|education\/(schedule|subjects|attendance))$/.test(target.pathname)) throw new BridgeError('Маршрут HEMIS не разрешён.', 'ENDPOINT_FORBIDDEN',403);
  const queries = [...target.searchParams];
  if (queries.length > 1 || queries.some(([key,value])=>key!=='page'||!/^\d{1,4}$/.test(value)) || target.pathname.endsWith('/auth/login') && queries.length) {
    throw new BridgeError('Параметры запроса не разрешены.', 'QUERY_FORBIDDEN',403);
  }
  return target;
}

export default {
  async fetch(request, env = {}) {
    let origin = '';
    try {
      const suppliedOrigin = request.headers.get('Origin') || '';
      const allowedOrigins = values(env.ALLOWED_ORIGINS);
      if (suppliedOrigin && !allowedOrigins.includes(suppliedOrigin)) return json({ok:false,code:'ORIGIN_FORBIDDEN',error:'Добавьте origin сайта в ALLOWED_ORIGINS моста.'},'',403);
      origin = suppliedOrigin;
      const key = String(env.BRIDGE_KEY || '').trim();
      if (!allowedOrigins.length || key.length < 24 || key.length > 256) return json({ok:false,code:'BRIDGE_SETUP_REQUIRED',error:'Владелец моста должен настроить BRIDGE_KEY (не менее 24 символов) и ALLOWED_ORIGINS.'},origin,503);
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:headersFor(origin)});
      if (url.pathname === '/health' && request.method === 'GET') return json({ok:true,service:'hemis-planner-bridge',protocol:1,version:VERSION,transport:'https',requiresKey:true},origin);
      if (url.pathname !== '/hemis-proxy') return json({ok:false,code:'NOT_FOUND',error:'Используйте /health или /hemis-proxy.'},origin,404);
      if (request.method !== 'POST') return json({ok:false,code:'METHOD_NOT_ALLOWED',error:'Нужен POST.'},origin,405);
      rateLimit(request);
      let payload;
      try { payload = JSON.parse(await smallText(request,MAX_REQUEST)); } catch(error) { if(error instanceof BridgeError)throw error;throw new BridgeError('Некорректный JSON.', 'JSON_INVALID'); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new BridgeError('Нужен объект запроса.', 'JSON_INVALID');
      const providedKey = typeof payload.key === 'string' ? payload.key.trim() : '';
      if (providedKey.length > 256 || !await sameKey(providedKey,key)) throw new BridgeError('Неверный или отсутствующий ключ HTTPS-моста. Это не пароль HEMIS.', 'BRIDGE_AUTH_REQUIRED',401);
      const target = targetFor(payload.target,env);
      const method = String(payload.method || 'GET').toUpperCase();
      const login = target.pathname === '/rest/v1/auth/login';
      if (method !== (login?'POST':'GET')) throw new BridgeError('Метод для маршрута не разрешён.', 'METHOD_NOT_ALLOWED',405);
      const upstreamHeaders = new Headers({'Accept':'application/json'});
      let body;
      if (login) {
        if (typeof payload.body?.login !== 'string' || !payload.body.login.trim() || payload.body.login.length>160 || typeof payload.body.password !== 'string' || !payload.body.password || payload.body.password.length>256) {
          throw new BridgeError('Проверьте логин и пароль HEMIS.', 'LOGIN_FIELDS_INVALID');
        }
        upstreamHeaders.set('Content-Type','application/json');
        body = JSON.stringify({login:payload.body.login.trim(),password:payload.body.password});
      } else {
        const token = typeof payload.token === 'string' ? payload.token.replace(/^Bearer\s+/i,'').trim() : '';
        if (!token || token.length>8192 || /[\r\n]/.test(token)) throw new BridgeError('Для данных HEMIS нужен корректный Bearer-токен.', 'TOKEN_REQUIRED',401);
        upstreamHeaders.set('Authorization',`Bearer ${token}`);
      }
      const controller = new AbortController();
      const timer = setTimeout(()=>controller.abort(),18000);
      try {
        const response = await fetch(target.href,{method,headers:upstreamHeaders,body,redirect:'manual',signal:controller.signal});
        if (response.status>=300&&response.status<400) throw new BridgeError('Портал перенаправляет запрос. Проверьте точный адрес REST API.', 'UPSTREAM_REDIRECT',502);
        const content = await smallText(response,MAX_RESPONSE);
        let data;
        try { data=JSON.parse(content); } catch {
          // Some HEMIS deployments negotiate XML even when JSON was requested.
          // Forward only the API response envelope for the browser's native XML parser.
          if (/^\s*(?:<\?xml[^>]*>\s*)?<response(?:\s|>)/i.test(content) && !/<!DOCTYPE|<!ENTITY/i.test(content) && /<\/response\s*>\s*$/.test(content)) {
            return json({ok:response.ok,status:response.status,format:'xml',data:content},origin);
          }
          throw new BridgeError(`Мост получил ответ HEMIS, но это страница вместо данных API (HTTP ${response.status}). Проверьте доступ к REST API вуза; повторная настройка моста не требуется.`, 'UPSTREAM_NOT_JSON',502);
        }
        return json({ok:response.ok,status:response.status,data},origin);
      } catch(error) {
        if(error instanceof BridgeError)throw error;
        throw new BridgeError(controller.signal.aborted?'HEMIS не ответил за 18 секунд.':'Сервер моста не смог подключиться к HEMIS. Возможны DNS, сеть или Geo-IP. Нужен сервер, которому доступен этот портал.',controller.signal.aborted?'UPSTREAM_TIMEOUT':'UPSTREAM_NETWORK',502);
      } finally { clearTimeout(timer); }
    } catch(error) {
      if(error instanceof BridgeError)return json({ok:false,status:error.status,code:error.code,error:error.message},origin,error.status);
      return json({ok:false,status:500,code:'BRIDGE_ERROR',error:'Внутренняя ошибка моста. Учётные данные не записывались в журнал.'},origin,500);
    }
  }
};
