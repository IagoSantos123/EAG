// PIX do site pelo Mercado Pago: gera a cobrança (QR Code e copia e cola) e confirma o recebimento sozinho.
// Sem MP_ACCESS_TOKEN o site continua com a chave PIX fixa e a conferência manual pelo financeiro.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool } from '../db.js';
import { HttpError, toCents, toMoney, withTransaction } from './http.js';
import { addHistory, getOpenSession, recomputePayment } from './orders.js';
import { reactivateExpired } from './payments.js';
import { publish } from './events.js';

const API = 'https://api.mercadopago.com';
const ACTOR = { name: 'Mercado Pago' };
// O Mercado Pago exige ao menos 30 minutos de validade para o PIX; o prazo do pedido continua valendo
// porque a cobrança é cancelada quando o pedido expira.
const MIN_PIX_MINUTES = 30;

export const mercadoPagoEnabled = () => Boolean(process.env.MP_ACCESS_TOKEN);

function publicBaseUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return '';
}

async function mp(path, { method = 'GET', body, idempotencyKey } = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new HttpError(502, 'Não foi possível falar com o Mercado Pago. Tente novamente em instantes.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`Mercado Pago ${method} ${path} → ${response.status}:`, data.message || data.error || '');
    throw new HttpError(502, 'O Mercado Pago recusou a operação. Tente novamente ou pague no caixa.');
  }
  return data;
}

export function pixCharge(order) {
  if (!order.mp_payment_id) return null;
  return { qrCode: order.mp_qr_code, qrCodeBase64: order.mp_qr_base64 };
}

// Gera (uma única vez por pedido) a cobrança PIX no Mercado Pago e guarda o QR Code no pedido.
export async function ensurePixCharge(orderId) {
  if (!mercadoPagoEnabled()) throw new HttpError(409, 'PIX automático não está configurado.');
  const order = (await pool.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
  if (!order) throw new HttpError(404, 'Pedido não encontrado.');
  if (order.mp_payment_id) return pixCharge(order);
  if (order.payment_method !== 'pix' || order.on_credit || order.status !== 'active' || order.payment_status !== 'awaiting_payment') {
    throw new HttpError(409, 'Este pedido não aguarda pagamento por PIX.');
  }
  const minimum = Date.now() + MIN_PIX_MINUTES * 60_000;
  const expiration = new Date(Math.max(new Date(order.expires_at).getTime(), minimum));
  const base = publicBaseUrl();
  const payment = await mp('/v1/payments', {
    method: 'POST',
    // Mesma chave para o mesmo pedido: dois cliques simultâneos não geram duas cobranças.
    idempotencyKey: `eag-pedido-${order.id}`,
    body: {
      transaction_amount: toMoney(order.total_cents - (order.paid_cents - order.refunded_cents)),
      description: `Pedido ${order.order_number} — Lá em Graças Lanches`,
      payment_method_id: 'pix',
      external_reference: String(order.id),
      date_of_expiration: expiration.toISOString(),
      ...(base ? { notification_url: `${base}/api/mercadopago/webhook` } : {}),
      payer: { email: process.env.MP_PAYER_EMAIL || 'comprador@eaggracas.com.br', first_name: order.buyer_name.split(' ')[0] }
    }
  }).catch(async (error) => {
    // Pedido simultâneo com a mesma chave (o Mercado Pago responde "locked"): vale a cobrança que a outra requisição gravou.
    const saved = (await pool.query('SELECT * FROM orders WHERE id=$1', [order.id])).rows[0];
    if (saved?.mp_payment_id) return null;
    throw error;
  });
  if (!payment) return pixCharge((await pool.query('SELECT * FROM orders WHERE id=$1', [order.id])).rows[0]);
  const data = payment.point_of_interaction?.transaction_data || {};
  if (!data.qr_code) throw new HttpError(502, 'O Mercado Pago não devolveu o QR Code. Tente novamente.');
  const { rows } = await pool.query(`UPDATE orders SET mp_payment_id=$1, mp_qr_code=$2, mp_qr_base64=$3, updated_at=NOW()
    WHERE id=$4 AND mp_payment_id IS NULL RETURNING *`, [String(payment.id), data.qr_code, data.qr_code_base64 || '', order.id]);
  // Outra requisição gravou antes (mesma cobrança, pela chave de idempotência): devolve o que está no banco.
  if (!rows.length) return pixCharge((await pool.query('SELECT * FROM orders WHERE id=$1', [order.id])).rows[0]);
  return pixCharge(rows[0]);
}

// Consulta a cobrança no Mercado Pago e, se aprovada, lança o recebimento. Idempotente.
export async function syncPixPayment(paymentId) {
  const payment = await mp(`/v1/payments/${encodeURIComponent(paymentId)}`);
  if (payment.status !== 'approved' || payment.payment_method_id !== 'pix') return { applied: false, status: payment.status };
  const orderId = Number(payment.external_reference);
  if (!Number.isSafeInteger(orderId) || orderId <= 0) return { applied: false, status: payment.status };
  const applied = await withTransaction(pool, async (db) => {
    const found = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    const order = found.rows[0];
    if (!order || order.mp_payment_id !== String(payment.id)) return false;
    const session = await getOpenSession(db, { lock: true });
    const cents = toCents(payment.transaction_amount);
    const inserted = await db.query(`INSERT INTO payments(order_id,session_id,kind,method,amount_cents,note,idempotency_key,created_by_name)
      VALUES($1,$2,'payment','pix',$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [orderId, session?.id || null, cents, `Mercado Pago #${payment.id}`, `mp:${payment.id}`, ACTOR.name]);
    if (!inserted.rowCount) return false;
    const amount = toMoney(cents).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const note = order.status === 'cancelled'
      ? `PIX de ${amount} recebido pelo Mercado Pago em pedido cancelado: devolva o valor pelo painel do Mercado Pago`
      : `PIX de ${amount} confirmado automaticamente pelo Mercado Pago${session ? '' : ' (sem caixa aberto)'}`;
    await addHistory(db, { orderId, kind: 'payment', status: 'confirmed', note, actor: ACTOR });
    await reactivateExpired(db, order, ACTOR);
    await recomputePayment(db, orderId);
    return true;
  });
  if (applied) publish('order', { orderId });
  return { applied, status: payment.status };
}

// Cancela no Mercado Pago a cobrança de pedidos que expiraram ou foram cancelados (melhor esforço).
export async function cancelPixCharges(paymentIds) {
  if (!mercadoPagoEnabled()) return;
  for (const id of paymentIds.filter(Boolean)) {
    try { await mp(`/v1/payments/${encodeURIComponent(id)}`, { method: 'PUT', body: { status: 'cancelled' } }); }
    catch (error) { console.error(`Falha ao cancelar a cobrança ${id} no Mercado Pago:`, error.message); }
  }
}

// Valida a assinatura do webhook (x-signature) com a chave secreta do painel do Mercado Pago.
export function validWebhookSignature(req, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;
  const parts = Object.fromEntries(String(req.get('x-signature') || '').split(',').map((part) => part.trim().split('=')));
  if (!parts.ts || !parts.v1) return false;
  const id = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${id};request-id:${req.get('x-request-id') || ''};ts:${parts.ts};`;
  const expected = Buffer.from(createHmac('sha256', secret).update(manifest).digest('hex'));
  const received = Buffer.from(parts.v1);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
