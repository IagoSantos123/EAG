// Roteamento simples por hash (funciona em qualquer hospedagem estática, sem configuração).
import { useEffect, useState } from 'react';

function parse(hash) {
  const value = hash.replace(/^#/, '');
  // Formato legado: #pedido/TOKEN
  const legacy = value.match(/^\/?pedido\/([A-Za-z0-9_-]+)$/);
  if (legacy) return { name: 'tracking', params: { token: legacy[1] } };
  const parts = value.replace(/^\//, '').split('/').filter(Boolean);
  const [first, second] = parts;
  if (!first) return { name: 'home', params: {} };
  if (first === 'lanchonete') return { name: 'catalog', params: { mode: 'snack' } };
  if (first === 'artigos') return { name: 'catalog', params: { mode: 'religious' } };
  if (first === 'sacola' && ['snack', 'religious'].includes(second)) return { name: 'cart', params: { mode: second } };
  if (first === 'finalizar' && ['snack', 'religious'].includes(second)) return { name: 'checkout', params: { mode: second } };
  if (first === 'meus-pedidos') return { name: 'myOrders', params: {} };
  if (first === 'consultar') return { name: 'lookup', params: {} };
  if (first === 'admin') return { name: 'admin', params: { tab: second || '' } };
  if (first === 'painel') return { name: 'painel', params: {} };
  return { name: 'home', params: {} };
}

export function useRoute() {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => { setRoute(parse(window.location.hash)); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const go = (path) => { window.location.hash = path; };
export const paths = {
  home: '#/',
  catalog: (mode) => (mode === 'snack' ? '#/lanchonete' : '#/artigos'),
  cart: (mode) => `#/sacola/${mode}`,
  checkout: (mode) => `#/finalizar/${mode}`,
  tracking: (token) => `#pedido/${token}`,
  myOrders: '#/meus-pedidos',
  lookup: '#/consultar',
  admin: (tab = '') => `#/admin${tab ? `/${tab}` : ''}`,
  painel: '#/painel'
};
