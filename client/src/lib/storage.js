// Armazenamento local tolerante a falhas (modo privado, bloqueio de cookies etc.).

export function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

export function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sem armazenamento: segue sem persistir */ }
}

export function readSession(key) {
  try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
}

export function writeSession(key, value) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch { /* ignora */ }
}

// Pedidos recentes deste aparelho (apenas o token de acompanhamento e dados de exibição).
const RECENT_KEY = 'eag-recent-orders';
export function recentOrders() {
  const list = readJson(RECENT_KEY, []);
  return Array.isArray(list) ? list.filter((item) => item && typeof item.token === 'string') : [];
}
export function rememberOrder(order) {
  const list = recentOrders().filter((item) => item.token !== order.token);
  writeJson(RECENT_KEY, [{ ...order, savedAt: new Date().toISOString() }, ...list].slice(0, 8));
}
