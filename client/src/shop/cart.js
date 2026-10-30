// Sacolas separadas por catálogo (lanchonete e artigos religiosos não se misturam).
import { useCallback, useEffect, useState } from 'react';
import { readJson, writeJson } from '../lib/storage.js';

const KEY = 'eag-carts-v2';
const empty = { snack: [], religious: [] };

const sameLine = (a, b) => a.productId === b.productId && a.note === b.note && a.customText === b.customText
  && JSON.stringify(a.selectedOptions) === JSON.stringify(b.selectedOptions);

export function useCarts() {
  const [carts, setCarts] = useState(() => {
    const saved = readJson(KEY, empty);
    return { snack: Array.isArray(saved?.snack) ? saved.snack : [], religious: Array.isArray(saved?.religious) ? saved.religious : [] };
  });
  useEffect(() => { writeJson(KEY, carts); }, [carts]);

  const add = useCallback((mode, line) => setCarts((current) => {
    const list = current[mode];
    const existing = list.find((item) => sameLine(item, line));
    const next = existing
      ? list.map((item) => (item === existing ? { ...item, quantity: Math.min(30, item.quantity + line.quantity) } : item))
      : [...list, { ...line, key: `${line.productId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }];
    return { ...current, [mode]: next };
  }), []);
  const setQuantity = useCallback((mode, key, quantity) => setCarts((current) => ({
    ...current, [mode]: current[mode].map((item) => (item.key === key ? { ...item, quantity: Math.max(1, Math.min(30, quantity)) } : item))
  })), []);
  const remove = useCallback((mode, key) => setCarts((current) => ({ ...current, [mode]: current[mode].filter((item) => item.key !== key) })), []);
  const clear = useCallback((mode) => setCarts((current) => ({ ...current, [mode]: [] })), []);

  // Atualiza preços/nome com o catálogo atual e remove o que deixou de existir.
  const sync = useCallback((mode, products) => setCarts((current) => {
    const byId = new Map(products.map((product) => [String(product.id), product]));
    let changed = false;
    const next = current[mode].flatMap((item) => {
      const product = byId.get(String(item.productId));
      if (!product) { changed = true; return []; }
      const unitPrice = product.price + item.selectedOptions.reduce((sum, choice) => {
        const group = product.optionGroups.find((g) => g.name === choice.group);
        const option = group?.options.find((o) => o.name === choice.option);
        return sum + (option?.extra || 0);
      }, 0);
      const valid = item.selectedOptions.every((choice) => product.optionGroups.find((g) => g.name === choice.group)?.options.some((o) => o.name === choice.option));
      if (!valid) { changed = true; return []; }
      if (unitPrice !== item.unitPrice || product.name !== item.name) { changed = true; return [{ ...item, unitPrice, name: product.name }]; }
      return [item];
    });
    return changed ? { ...current, [mode]: next } : current;
  }), []);

  const count = (mode) => carts[mode].reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = (mode) => Math.round(carts[mode].reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) * 100) / 100;
  return { carts, add, setQuantity, remove, clear, sync, count, subtotal };
}
