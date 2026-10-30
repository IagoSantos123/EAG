// Cliente da API, formatação e atualização em tempo real.

export const API = (import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001/api' : '/api')).replace(/\/$/, '');
const API_ORIGIN = API.startsWith('http') ? API.replace(/\/api$/, '') : '';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function request(path, { method = 'GET', body, token, signal, timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  signal?.addEventListener('abort', () => controller.abort());
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('Sem conexão com o servidor. Verifique a internet e tente novamente.', 0, 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || 'Não foi possível concluir. Tente novamente.', response.status, data.code);
  return data;
}

export async function download(path, token, filename) {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new ApiError('Não foi possível exportar.', response.status);
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// Imagens enviadas pelo painel ficam na API (/api/images/ID); arquivos da marca ficam no próprio site.
export function imageUrl(url) {
  if (!url) return '';
  if (url.startsWith('/api/')) return `${API_ORIGIN}${url}`;
  return url;
}

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
  (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)));

// ---------- Formatação ----------

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = (value) => currency.format(Number(value || 0));
export const moneyCents = (cents) => currency.format(Number(cents || 0) / 100);
export const time = (value) => (value ? new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—');
export const dateTime = (value) => (value ? new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const fullDateTime = (value) => (value ? new Date(value).toLocaleString('pt-BR') : '—');

export function elapsed(from, now = Date.now()) {
  if (!from) return '';
  const minutes = Math.max(0, Math.floor((now - new Date(from).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}`;
}

// Data local AAAA-MM-DD (para filtros de período).
export function localDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Converte "12,50" ou "12.50" em número; retorna NaN se inválido.
export function parseMoney(text) {
  if (typeof text === 'number') return text;
  const normalized = String(text || '').trim().replace(/\s|R\$/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (!normalized) return NaN;
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : NaN;
}

// ---------- Tempo real (Server-Sent Events via fetch, para enviar o token no cabeçalho) ----------

export function subscribe(path, { token, onChange, onStatus }) {
  let stopped = false;
  let controller;
  let retry = 1000;

  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const response = await fetch(`${API}${path}`, { signal: controller.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} });
      // Servidor sem conexão persistente (ex.: Vercel): para de tentar; as telas usam atualização periódica.
      if (response.headers.get('x-realtime') === 'off') { stopped = true; onStatus?.(false); return; }
      if (!response.ok || !response.body) throw new Error('stream');
      onStatus?.(true);
      retry = 1000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (event === 'change' && data) {
            try { onChange(JSON.parse(data)); } catch { /* evento malformado é ignorado */ }
          }
        }
      }
    } catch { /* conexão caiu: tenta de novo abaixo */ }
    if (stopped) return;
    onStatus?.(false);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30000);
  };
  connect();
  return () => { stopped = true; controller?.abort(); };
}
