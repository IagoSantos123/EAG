// Comanda de cobrança do fiado, para divulgar nos grupos das equipes: o valor em aberto e os itens de cada dia.
// Sai como texto (WhatsApp) e como imagem desenhada no canvas, com as cores e a marca da lanchonete.
import { personKey } from './nomes.js';

const TIMEZONE = 'America/Fortaleza';
const money = (value) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dayKey = (date) => new Date(date).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
const dayLabel = (date) => new Date(date).toLocaleDateString('pt-BR', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit' });
const itemLabel = (item) => `${item.name}${item.options?.length ? ` (${item.options.map((o) => o.option).join(', ')})` : ''}`;
// "1x açaí, 1x batata e 2x água"
export const joinItems = (items) => {
  const parts = items.map((item) => `${item.quantity}x ${item.label}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} e ${parts.at(-1)}` : parts[0] || '';
};

// Uma pessoa: comandas fiadas agrupadas por dia, juntando o mesmo item do mesmo dia ("2x açaí").
export function buildCharge(orders) {
  const sorted = [...orders].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const days = new Map();
  for (const order of sorted) {
    const key = dayKey(order.createdAt);
    const day = days.get(key) || { label: dayLabel(order.createdAt), items: new Map() };
    for (const item of order.items) {
      const label = itemLabel(item);
      const entry = day.items.get(label) || { label, quantity: 0 };
      entry.quantity += item.quantity;
      day.items.set(label, entry);
    }
    days.set(key, day);
  }
  // O nome mais completo entre as grafias (depois de juntar, todas ficam iguais).
  const name = sorted.map((o) => o.buyerName.trim()).sort((a, b) => b.length - a.length)[0];
  const teams = [...new Set(sorted.map((o) => o.teamName))];
  const balance = sorted.reduce((sum, o) => sum + o.balance, 0);
  const total = sorted.reduce((sum, o) => sum + o.total, 0);
  return { name, team: teams.join(' / '), balance, paid: Math.max(0, total - balance), count: sorted.length,
    days: [...days.values()].map((day) => ({ label: day.label, items: [...day.items.values()] })) };
}

// Pessoas de uma lista de comandas (agrupadas pelo nome), em ordem alfabética.
export function chargesByPerson(orders) {
  const groups = new Map();
  for (const order of orders) {
    const key = personKey(order.buyerName);
    groups.set(key, [...(groups.get(key) || []), order]);
  }
  return [...groups.values()].map(buildCharge).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

function personText(charge) {
  return [
    `*${charge.name}*${charge.team ? ` (${charge.team})` : ''}`,
    `O valor fiado ficou *${money(charge.balance)}*, com os seguintes itens:`,
    ...charge.days.map((day) => `(${day.label}): ${joinItems(day.items)}`),
    ...(charge.paid > 0 ? [`Já pago: ${money(charge.paid)}`] : [])
  ].join('\n');
}

const pixLine = (pix) => (pix?.key ? `\nPague pelo PIX: ${pix.key}${pix.beneficiary ? ` (${pix.beneficiary})` : ''}` : '');

export function chargeText(charges, { title, pix } = {}) {
  const head = ['🍔 *Lá em Graças Lanches · EAG Graças*', title ? `*${title}*` : '*Comanda de fiado*'].join('\n');
  const total = charges.length > 1 ? `\n\n*Total da equipe: ${money(charges.reduce((sum, c) => sum + c.balance, 0))}*` : '';
  return `${head}\n\n${charges.map(personText).join('\n\n')}${total}${pixLine(pix)}`;
}

// ---------- Imagem ----------

const C = { blue: '#029ad6', blueDark: '#0279ab', yellow: '#ffe27a', red: '#d6202b', ink: '#1d1d1f', muted: '#71757c', line: '#d9d9de', paper: '#fffdf7', chip: '#fdeeef' };
const W = 640; const PAD = 24; const CARD = W - PAD * 2; const IN = 26;
const font = (weight, size) => `${weight} ${size}px Inter, Arial, sans-serif`;

function wrap(ctx, text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function dashed(ctx, y) {
  ctx.save(); ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.setLineDash([8, 7]);
  ctx.beginPath(); ctx.moveTo(PAD + IN, y); ctx.lineTo(PAD + CARD - IN, y); ctx.stroke(); ctx.restore();
}

// Desenha a comanda de uma pessoa a partir de y; com draw=false só mede a altura.
function personCard(ctx, charge, y, draw) {
  const x = PAD + IN; const inner = CARD - IN * 2;
  const ops = [];
  let h = 26;
  ctx.font = font(800, 26);
  const nameLines = wrap(ctx, charge.name, inner);
  const nameAt = h;
  nameLines.forEach((text, i) => ops.push(() => { ctx.font = font(800, 26); ctx.fillStyle = C.ink; ctx.fillText(text, x, y + nameAt + 26 + i * 32); }));
  h += 26 + (nameLines.length - 1) * 32 + 10;
  if (charge.team) { const at = h; ops.push(() => { ctx.font = font(500, 16); ctx.fillStyle = C.muted; ctx.fillText(`Equipe ${charge.team}`, x, y + at + 16); }); h += 26; }
  const sep1 = h + 8; ops.push(() => dashed(ctx, y + sep1)); h += 26;
  for (const day of charge.days) {
    const at = h;
    ops.push(() => {
      ctx.font = font(700, 15); const w = ctx.measureText(day.label).width + 20;
      ctx.fillStyle = C.chip; roundRect(ctx, x, y + at, w, 26, 13); ctx.fill();
      ctx.fillStyle = C.red; ctx.fillText(day.label, x + 10, y + at + 18);
    });
    h += 36;
    ctx.font = font(500, 18);
    for (const item of day.items) {
      const lines = wrap(ctx, `${item.quantity}x ${item.label}`, inner - 22);
      lines.forEach((text, i) => {
        const ly = h + i * 25;
        ops.push(() => {
          ctx.font = font(500, 18); ctx.fillStyle = C.ink;
          if (i === 0) { ctx.fillStyle = C.blue; ctx.beginPath(); ctx.arc(x + 6, y + ly + 12, 4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = C.ink; }
          ctx.fillText(text, x + 22, y + ly + 18);
        });
      });
      h += lines.length * 25 + 4;
    }
    h += 10;
  }
  const sep2 = h; ops.push(() => dashed(ctx, y + sep2)); h += 18;
  if (charge.paid > 0) { const at = h; ops.push(() => { ctx.font = font(500, 15); ctx.fillStyle = C.muted; ctx.fillText(`Já pago: ${money(charge.paid)}`, x, y + at + 15); }); h += 26; }
  const at = h;
  ops.push(() => {
    ctx.font = font(700, 15); ctx.fillStyle = C.muted; ctx.fillText('VALOR EM ABERTO', x, y + at + 30);
    ctx.font = font(800, 34); ctx.fillStyle = C.red; ctx.textAlign = 'right'; ctx.fillText(money(charge.balance), x + inner, y + at + 34); ctx.textAlign = 'left';
  });
  h += 58;
  if (draw) {
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
    ctx.fillStyle = C.paper; roundRect(ctx, PAD, y, CARD, h, 18); ctx.fill(); ctx.restore();
    // Picotes laterais de comanda, na altura da primeira linha tracejada.
    ctx.fillStyle = C.blue;
    for (const cx of [PAD, PAD + CARD]) { ctx.beginPath(); ctx.arc(cx, y + sep1, 11, 0, Math.PI * 2); ctx.fill(); }
    ops.forEach((op) => op());
  }
  return h;
}

const loadImage = (src) => new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = src; });

// Imagem (PNG) com a marca no topo, uma comanda por pessoa e, se for equipe, o total da equipe.
export async function chargeImage(charges, { title, pix } = {}) {
  try { await document.fonts.load(font(800, 20)); await document.fonts.load(font(500, 20)); } catch { /* segue com a fonte padrão */ }
  const logo = await loadImage('/brand/la-em-gracas-lanches.png');
  const measure = document.createElement('canvas').getContext('2d');
  const heights = charges.map((charge) => personCard(measure, charge, 0, false));
  const headH = 210; const gap = 22;
  const team = charges.length > 1;
  const footH = (team ? 70 : 0) + (pix?.key ? 74 : 0) + 56;
  const height = headH + heights.reduce((sum, h) => sum + h + gap, 0) + footH;
  // Equipes grandes geram imagens altas: reduz a resolução para caber no limite do navegador.
  const scale = height * 2 > 30000 ? 1 : 2;
  const canvas = document.createElement('canvas');
  canvas.width = W * scale; canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, C.blue); bg.addColorStop(1, C.blueDark);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, height);
  if (logo) { const lh = 104; const lw = (logo.width / logo.height) * lh; ctx.drawImage(logo, (W - lw) / 2, 22, lw, lh); }
  ctx.textAlign = 'center';
  ctx.font = font(800, 26); ctx.fillStyle = C.yellow; ctx.fillText((title || 'Comanda de fiado').toUpperCase(), W / 2, 162);
  ctx.font = font(500, 15); ctx.fillStyle = '#ffffff'; ctx.fillText('EAG Graças · valores anotados no fiado', W / 2, 188);
  ctx.textAlign = 'left';
  let y = headH;
  charges.forEach((charge, i) => { personCard(ctx, charge, y, true); y += heights[i] + gap; });
  if (team) {
    ctx.fillStyle = C.yellow; roundRect(ctx, PAD, y, CARD, 56, 16); ctx.fill();
    ctx.font = font(700, 18); ctx.fillStyle = C.ink; ctx.fillText(`Total da equipe · ${charges.length} ${charges.length === 1 ? 'pessoa' : 'pessoas'}`, PAD + IN, y + 35);
    ctx.font = font(800, 24); ctx.textAlign = 'right'; ctx.fillText(money(charges.reduce((sum, c) => sum + c.balance, 0)), PAD + CARD - IN, y + 37); ctx.textAlign = 'left';
    y += 70;
  }
  ctx.textAlign = 'center';
  if (pix?.key) {
    ctx.font = font(500, 16); ctx.fillStyle = '#ffffff'; ctx.fillText('Pague pelo PIX', W / 2, y + 22);
    ctx.font = font(800, 22); ctx.fillStyle = C.yellow; ctx.fillText(pix.key, W / 2, y + 50);
    y += 74;
  }
  ctx.font = font(500, 14); ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillText('Lá em Graças Lanches · obrigado pela colaboração!', W / 2, y + 26);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
