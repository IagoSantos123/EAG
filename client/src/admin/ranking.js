// Relação dos itens mais vendidos no período, para divulgar: texto (WhatsApp) e imagens com a marca da lanchonete.
// Separada por catálogo (lanchonete e artigos religiosos), em ordem de quantidade vendida.
import { C, HEAD_H, drawHead, font, loadImage, newCanvas, roundRect, toBlob } from './cobranca.js';

const money = (value) => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const SECTIONS = [{ mode: 'snack', label: 'Lanchonete' }, { mode: 'religious', label: 'Artigos religiosos' }];
const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
export const periodLabel = (from, to) => (from === to ? dm(from) : `${dm(from)} a ${dm(to)}`);

// Seções com os produtos em ordem de quantidade (empate: maior valor), e o total de cada seção.
export function buildRanking(rows) {
  return SECTIONS.map(({ mode, label }) => {
    const items = rows.filter((row) => (row.mode || 'snack') === mode && row.quantity > 0)
      .sort((a, b) => b.quantity - a.quantity || b.total - a.total || a.name.localeCompare(b.name, 'pt-BR'));
    return { label, items, quantity: items.reduce((sum, i) => sum + i.quantity, 0), total: items.reduce((sum, i) => sum + i.total, 0) };
  }).filter((section) => section.items.length);
}

export function rankingText(sections, { period }) {
  const blocks = sections.map((section) => [
    `*${section.label}* · ${section.quantity} itens · ${money(section.total)}`,
    ...section.items.map((item, i) => `${i + 1}. ${item.name} — ${item.quantity} un. (${money(item.total)})`)
  ].join('\n'));
  return `🍔 *Lá em Graças Lanches · EAG Graças*\n*Itens mais vendidos* (${period})\n\n${blocks.join('\n\n')}`;
}

// ---------- Imagem ----------
// Duas colunas de "comanda" com o ranking; quando não cabe, continua numa nova parte do tamanho de uma tela.

const W = 1080; const MAX_H = 1920; const PAD = 28; const GAP = 20; const IN = 22;
const COL_W = (W - PAD * 2 - GAP) / 2;
const FOOT_H = 56; const SECTION_H = 70; const ROW_H = 58; const TOP = 18; const BOTTOM = 14;

function ellipsis(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

function drawSection(ctx, x, y, section, continued) {
  ctx.font = font(800, 22); ctx.fillStyle = C.ink;
  ctx.fillText(`${section.label}${continued ? ' (continuação)' : ''}`, x + IN, y + 30);
  ctx.font = font(500, 15); ctx.fillStyle = C.muted;
  ctx.fillText(`${section.quantity} itens vendidos · ${money(section.total)}`, x + IN, y + 54);
}

function drawRow(ctx, x, y, item, rank, max) {
  const inner = COL_W - IN * 2;
  const cx = x + IN + 17;
  ctx.fillStyle = rank <= 3 ? C.red : C.chip;
  ctx.beginPath(); ctx.arc(cx, y + 26, 17, 0, Math.PI * 2); ctx.fill();
  ctx.font = font(800, rank > 99 ? 12 : 15); ctx.fillStyle = rank <= 3 ? '#ffffff' : C.red; ctx.textAlign = 'center';
  ctx.fillText(String(rank), cx, y + 31); ctx.textAlign = 'left';
  const textX = x + IN + 46; const right = x + IN + inner; const nameW = right - textX - 96;
  ctx.font = font(600, 18); ctx.fillStyle = C.ink; ctx.fillText(ellipsis(ctx, item.name, nameW), textX, y + 24);
  ctx.fillStyle = '#e3f3fa'; roundRect(ctx, textX, y + 34, nameW, 7, 3.5); ctx.fill();
  ctx.fillStyle = C.blue; roundRect(ctx, textX, y + 34, Math.max(7, nameW * (item.quantity / max)), 7, 3.5); ctx.fill();
  ctx.textAlign = 'right';
  ctx.font = font(800, 19); ctx.fillStyle = C.ink; ctx.fillText(`${item.quantity} un.`, right, y + 24);
  ctx.font = font(500, 14); ctx.fillStyle = C.muted; ctx.fillText(money(item.total), right, y + 44);
  ctx.textAlign = 'left';
}

export async function rankingImages(sections, { period }) {
  try { await document.fonts.load(font(800, 20)); await document.fonts.load(font(500, 20)); } catch { /* segue com a fonte padrão */ }
  const logo = await loadImage('/brand/la-em-gracas-lanches.png');
  const colMax = MAX_H - HEAD_H - FOOT_H - TOP - BOTTOM;

  // Monta as colunas: cada uma recebe blocos (título de seção ou linha) até encher; duas colunas por parte.
  const columns = [];
  let col = null;
  const place = (block, height) => {
    if (!col || col.h + height > colMax) { col = { h: 0, blocks: [] }; columns.push(col); }
    block.y = col.h; col.blocks.push(block); col.h += height;
  };
  for (const section of sections) {
    const max = section.items[0].quantity;
    section.items.forEach((item, i) => {
      // O título vai junto com a primeira linha; numa coluna nova a seção é repetida como continuação.
      const needsTitle = i === 0 || !col || col.h + ROW_H > colMax;
      if (needsTitle) {
        if (col && col.h + SECTION_H + ROW_H > colMax) col = null;
        place({ type: 'section', section, continued: i > 0 }, SECTION_H);
      }
      place({ type: 'row', item, rank: i + 1, max }, ROW_H);
    });
  }
  const pages = [];
  for (let i = 0; i < columns.length; i += 2) pages.push(columns.slice(i, i + 2));

  const blobs = [];
  for (const [index, page] of pages.entries()) {
    const bodyH = Math.max(...page.map((c) => c.h)) + TOP + BOTTOM;
    const { canvas, ctx } = newCanvas(W, HEAD_H + bodyH + FOOT_H);
    drawHead(ctx, W, logo, 'Itens mais vendidos', pages.length > 1 ? `${index + 1} de ${pages.length}` : '', `EAG Graças · vendas de ${period}`);
    page.forEach((column, c) => {
      const x = PAD + c * (COL_W + GAP); const y = HEAD_H;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
      ctx.fillStyle = C.paper; roundRect(ctx, x, y, COL_W, column.h + TOP + BOTTOM, 18); ctx.fill(); ctx.restore();
      for (const block of column.blocks) {
        if (block.type === 'section') drawSection(ctx, x, y + TOP + block.y, block.section, block.continued);
        else drawRow(ctx, x, y + TOP + block.y, block.item, block.rank, block.max);
      }
    });
    ctx.textAlign = 'center'; ctx.font = font(500, 14); ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillText('Lá em Graças Lanches · obrigado a todos que compraram!', W / 2, HEAD_H + bodyH + 34); ctx.textAlign = 'left';
    blobs.push(await toBlob(canvas));
  }
  return blobs;
}
