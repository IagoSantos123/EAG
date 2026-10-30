import React, { useState } from 'react';
import { CupSoda, IceCreamCone, Pizza, Sandwich, Soup, Utensils } from 'lucide-react';
import { imageUrl } from '../lib/api.js';

// Ícone neutro quando o produto ainda não tem foto.
function productIcon(product) {
  const text = `${product.category || ''} ${product.name}`.toLowerCase();
  if (/bebida|suco|água|agua|refri|guaran|pepsi/.test(text)) return CupSoda;
  if (/sobremesa|açaí|acai|dindim|torta/.test(text)) return IceCreamCone;
  if (/pizza/.test(text)) return Pizza;
  if (/cuscuz/.test(text)) return Soup;
  if (/pão|pao|misto|crepe|salgado|tapioca/.test(text)) return Sandwich;
  return Utensils;
}

// Preço inicial considerando as escolhas obrigatórias mais baratas.
export function startingPrice(product) {
  let extra = 0;
  let varies = false;
  for (const group of product.optionGroups) {
    const prices = group.options.map((option) => option.extra).sort((a, b) => a - b);
    if (new Set(prices).size > 1 || (group.max > group.min && prices.some((p) => p > 0))) varies = true;
    extra += prices.slice(0, group.min).reduce((sum, value) => sum + value, 0);
  }
  return { price: product.price + extra, varies };
}

export function ProductThumb({ product, size = 'md' }) {
  const [failed, setFailed] = useState(false);
  const Icon = productIcon(product);
  if (product.imageUrl && !failed) return <img className={`thumb thumb-${size}`} src={imageUrl(product.imageUrl)} alt="" loading="lazy" onError={() => setFailed(true)} />;
  return <span className={`thumb thumb-${size} thumb-empty`} aria-hidden="true"><Icon size={size === 'lg' ? 30 : 20} strokeWidth={1.6} /></span>;
}
