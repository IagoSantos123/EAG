// Rotas públicas: catálogo, criação e acompanhamento de pedidos pelo comprador.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool, readSettings } from '../db.js';
import { asyncRoute, fail, parse, toMoney, withTransaction, HttpError } from '../lib/http.js';
import { PRODUCTION_FLOW, PRODUCTION_TIMESTAMP, SERVICE_LABELS, addHistory, optionExtraCents, serializeItems, balanceCents } from '../lib/orders.js';
import { publicOrderSchema, validateOrder, insertOrder, availableServices, enabledPaymentMethods } from '../lib/create-order.js';
import { expireDueOrders } from '../lib/expiry.js';
import { TIMEZONE } from '../lib/time.js';
import { publish, openStream } from '../lib/events.js';
import { mercadoPagoEnabled, ensurePixCharge, pixCharge, syncPixPayment, validWebhookSignature } from '../lib/mercadopago.js';

const router = Router();
const modeSchema = z.enum(['religious', 'snack']);
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitos pedidos em sequência. Aguarde alguns minutos e tente novamente.' } });
const claimLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas. Procure a equipe financeira.' } });
// A tela do pedido confere o PIX a cada poucos segundos enquanto mostra o QR Code.
const pixLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 150, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas consultas seguidas. Aguarde alguns minutos.' } });

// Opções de atendimento e pagamento disponíveis conforme a configuração administrativa.
export function publicOptions(settings) {
  const service = settings.service || {};
  const methods = settings.payment_methods || {};
  return {
    paymentMethods: enabledPaymentMethods(settings),
    sitePaused: Boolean(service.site_paused),
    pixAutomatic: mercadoPagoEnabled(),
    selfCredit: Boolean(methods.fiado_self),
    serviceTypes: availableServices('snack', settings),
    religiousServiceTypes: availableServices('religious', settings),
    realtime: !process.env.VERCEL,
    deliveryFee: toMoney(service.delivery_fee_cents || 0),
    tablesEnabled: Boolean(service.tables_enabled),
    tableCount: Number(service.table_count || 0),
    instructions: {
      delivery: service.delivery_instructions || '',
      pickup: service.pickup_instructions || '',
      dine_in: service.dine_in_instructions || ''
    },
    contactPhone: settings.contact?.phone || '',
    pix: {
      key: settings.pix?.key || '', type: settings.pix?.type || '', beneficiary: settings.pix?.beneficiary || '',
      city: settings.pix?.city || '', instructions: settings.pix?.instructions || '', qrImage: settings.pix?.qr_image || ''
    },
    deadlineMinutes: Number(settings.payment_deadline_minutes || 15)
  };
}


router.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
}));

router.get('/public-config', asyncRoute(async (_req, res) => {
  res.json(publicOptions(await readSettings()));
}));

// Mantida para compatibilidade com a versão anterior.
router.get('/payment-info', asyncRoute(async (_req, res) => {
  const options = publicOptions(await readSettings());
  res.json({ ...options.pix, deadlineMinutes: options.deadlineMinutes });
}));

// Painel de senhas da TV: pedidos da lanchonete de hoje ainda não entregues, só com a senha e o primeiro nome.
// (Artigos religiosos são entregues na hora, no balcão, e não passam pela cozinha.)
router.get('/painel', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT ticket_number, buyer_name, mode, production_status,
      COALESCE(ready_at, awaiting_pickup_at, created_at) AS since
    FROM orders WHERE mode='snack' AND status='active' AND production_status<>'finalized' AND ticket_number IS NOT NULL
      AND (created_at AT TIME ZONE $1)::date = (NOW() AT TIME ZONE $1)::date
    ORDER BY ticket_number`, [TIMEZONE]);
  const settings = await readSettings();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    orders: rows.map((row) => ({
      ticket: row.ticket_number, firstName: (row.buyer_name || '').trim().split(/\s+/)[0] || '', mode: row.mode,
      status: ['ready', 'awaiting_pickup'].includes(row.production_status) ? 'pronto' : 'preparo', since: row.since
    })),
    pixQr: settings.pix?.qr_image || '',
    realtime: !process.env.VERCEL
  });
}));

router.get('/painel/events', (req, res) => openStream(req, res, (event) => event.type === 'order'));

router.get('/catalog', asyncRoute(async (req, res) => {
  const mode = modeSchema.safeParse(req.query.mode);
  if (!mode.success) return fail(res, 400, 'Modalidade inválida.');
  // Só entra no catálogo o que está ativo, não arquivado e com estoque (quando controlado).
  const { rows } = await pool.query(`SELECT p.id,p.name,p.description,p.mode,p.price_cents,p.stock,p.prep_minutes,p.image_url,
      p.option_groups,p.allow_notes,p.custom_text_label,p.custom_text_required,p.category_id,c.name AS category
    FROM products p LEFT JOIN categories c ON c.id=p.category_id
    WHERE p.mode=$1 AND p.available=TRUE AND p.archived=FALSE AND (p.stock IS NULL OR p.stock>0)
      AND (c.id IS NULL OR c.active=TRUE)
    ORDER BY c.sort_order NULLS LAST, c.name, p.sort_order, p.name`, [mode.data]);
  const products = rows.map((p) => ({
    id: p.id, name: p.name, description: p.description || '', mode: p.mode, price: toMoney(p.price_cents),
    stock: p.stock, prepMinutes: p.prep_minutes, imageUrl: p.image_url || '', categoryId: p.category_id, category: p.category || '',
    allowNotes: p.allow_notes, customTextLabel: p.custom_text_label, customTextRequired: p.custom_text_required,
    optionGroups: (p.option_groups || []).map((group) => ({
      name: group.name, min: Number(group.min ?? (group.required ? 1 : 0)), max: Number(group.max ?? 1),
      options: (group.options || []).filter((option) => option.available !== false).map((option) => ({ name: option.name, extra: toMoney(optionExtraCents(option)) }))
    }))
  }));
  const used = new Set(products.map((p) => p.categoryId).filter(Boolean));
  const categories = await pool.query('SELECT id,name FROM categories WHERE mode=$1 AND active=TRUE ORDER BY sort_order,name', [mode.data]);
  res.json({ products, categories: categories.rows.filter((c) => used.has(c.id)) });
}));

router.get('/teams', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query('SELECT id,name FROM teams WHERE active=TRUE ORDER BY name');
  res.json(rows);
}));

router.get('/images/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return fail(res, 404, 'Imagem não encontrada.');
  const { rows } = await pool.query('SELECT mime,data FROM product_images WHERE id=$1', [id]);
  if (!rows.length) return fail(res, 404, 'Imagem não encontrada.');
  res.setHeader('Content-Type', rows[0].mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.send(rows[0].data);
}));

function orderResponse(row) {
  return { orderNumber: row.order_number, token: row.public_token, ticket: row.ticket_number, expiresAt: row.expires_at,
    total: toMoney(row.total_cents), paymentMethod: row.payment_method };
}

// Durante o evento os pedidos são só presenciais (o site mostra o aviso). Esta rota vem antes da criação
// de pedidos e recusa também quem ainda estiver com a página antiga aberta. Para reabrir, remova-a.
router.post('/orders', (_req, res) => fail(res, 409, 'Os pedidos pelo site estão encerrados. Faça seu pedido presencialmente no balcão.', 'SITE_CLOSED'));

router.post('/orders', orderLimiter, asyncRoute(async (req, res) => {
  const input = parse(publicOrderSchema, req.body, 'Confira os dados do pedido.');
  if (input.clientRequestId) {
    // Reenvio do mesmo pedido (ex.: falha de rede): devolve o pedido já criado.
    const existing = await pool.query('SELECT * FROM orders WHERE client_request_id=$1', [input.clientRequestId]);
    if (existing.rowCount) return res.status(200).json(orderResponse(existing.rows[0]));
  }
  const settings = await readSettings();
  const options = publicOptions(settings);
  if (options.sitePaused) throw new HttpError(409, 'Os pedidos pelo site estão pausados. Faça seu pedido no balcão.', 'SITE_PAUSED');
  const fiado = input.paymentMethod === 'fiado';
  if (fiado ? !(options.selfCredit && input.serviceType === 'dine_in') : !options.paymentMethods.includes(input.paymentMethod)) {
    throw new HttpError(400, 'Forma de pagamento indisponível.');
  }
  const { deliveryFeeCents, tableNumber } = validateOrder(input, settings);
  try {
    const row = await withTransaction(pool, (db) => insertOrder(db, input, settings, { paymentMethod: input.paymentMethod, onCredit: fiado, deliveryFeeCents, tableNumber }));
    publish('order', { orderId: row.id, created: true, mode: row.mode });
    // Já deixa o QR Code pronto; se o Mercado Pago falhar agora, a tela do pedido tenta de novo.
    if (row.payment_method === 'pix' && !row.on_credit && mercadoPagoEnabled()) {
      await ensurePixCharge(row.id).catch((error) => console.error(`PIX do pedido ${row.order_number}:`, error.message));
    }
    res.status(201).json(orderResponse(row));
  } catch (error) {
    // Dois envios simultâneos com o mesmo identificador: devolve o que foi gravado.
    if (error.code === '23505' && input.clientRequestId) {
      const existing = await pool.query('SELECT * FROM orders WHERE client_request_id=$1', [input.clientRequestId]);
      if (existing.rowCount) return res.status(200).json(orderResponse(existing.rows[0]));
    }
    throw error;
  }
}));

// Consulta de pedido: exige o número do pedido (ou a senha do dia) E o telefone usado na compra.
const lookupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas consultas seguidas. Aguarde alguns minutos.' } });
router.post('/orders/lookup', lookupLimiter, asyncRoute(async (req, res) => {
  const input = parse(z.object({ code: z.string().trim().min(1).max(40), phone: z.string().trim().max(30) }), req.body, 'Informe o número do pedido e o telefone.');
  const phone = input.phone.replace(/\D/g, '');
  if (phone.length < 10) throw new HttpError(400, 'Informe o telefone com DDD usado no pedido.');
  const code = input.code.toUpperCase().replace(/^#/, '').replace(/\s/g, '');
  const ticket = /^\d{1,4}$/.test(code) ? Number(code) : null;
  const { rows } = await pool.query(`SELECT public_token, buyer_phone FROM orders
    WHERE ${ticket ? `ticket_number=$1 AND created_at > NOW() - INTERVAL '2 days'` : 'UPPER(order_number)=$1'}
    ORDER BY created_at DESC LIMIT 20`, [ticket ?? code]);
  // Compara os dígitos do telefone (últimos 10 dígitos, para aceitar com ou sem +55).
  const match = rows.find((row) => row.buyer_phone.replace(/\D/g, '').slice(-10) === phone.slice(-10));
  if (!match) throw new HttpError(404, 'Não encontramos um pedido com esses dados. Confira o número e o telefone.');
  res.json({ token: match.public_token });
}));

async function findByToken(token) {
  if (!TOKEN_RE.test(token)) return null;
  const { rows } = await pool.query('SELECT * FROM orders WHERE public_token=$1', [token]);
  return rows[0] || null;
}

function publicTimeline(order) {
  const current = PRODUCTION_FLOW.indexOf(order.production_status);
  return PRODUCTION_FLOW.map((step, index) => ({
    step,
    at: step === 'new' ? order.created_at : order[PRODUCTION_TIMESTAMP[step]] || null,
    done: index < current || (step === 'finalized' && current === index),
    current: index === current
  }));
}

router.get('/orders/:token', asyncRoute(async (req, res) => {
  let order = await findByToken(req.params.token);
  if (!order) return fail(res, 404, 'Pedido não encontrado.');
  if (order.status === 'active' && order.expires_at && new Date(order.expires_at) <= new Date()) {
    await expireDueOrders(pool, { orderId: order.id });
    order = await findByToken(req.params.token);
  }
  const settings = await readSettings();
  const options = publicOptions(settings);
  const history = await pool.query(`SELECT kind,status,note,created_at FROM order_history WHERE order_id=$1 AND kind IN ('payment','order')
    ORDER BY created_at`, [order.id]);
  res.json({
    orderNumber: order.order_number,
    ticket: order.ticket_number,
    createdAt: order.created_at,
    buyerName: order.buyer_name,
    teamName: order.team_name,
    mode: order.mode,
    serviceType: order.service_type,
    serviceLabel: SERVICE_LABELS[order.service_type],
    tableNumber: order.table_number,
    deliveryAddress: order.delivery_address,
    deliveryReference: order.delivery_reference,
    deliveryNote: order.delivery_note,
    items: serializeItems(order.items),
    subtotal: toMoney(order.subtotal_cents),
    deliveryFee: toMoney(order.delivery_fee_cents),
    total: toMoney(order.total_cents),
    paid: toMoney(order.paid_cents - order.refunded_cents),
    balance: toMoney(balanceCents(order)),
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status,
    onCredit: order.on_credit,
    cashChangeFor: order.cash_change_for_cents == null ? null : toMoney(order.cash_change_for_cents),
    status: order.status,
    cancelReason: order.cancel_reason,
    productionStatus: order.production_status,
    timeline: publicTimeline(order),
    paymentEvents: history.rows.filter((h) => h.kind === 'payment').map((h) => ({ status: h.status, at: h.created_at })),
    expiresAt: order.expires_at,
    instructions: options.instructions[order.service_type] || '',
    contactPhone: options.contactPhone,
    pixAutomatic: order.payment_method === 'pix' && (Boolean(order.mp_payment_id) || mercadoPagoEnabled()),
    pixCharge: pixCharge(order),
    pix: order.payment_method === 'pix' && !order.mp_payment_id && !mercadoPagoEnabled() ? options.pix : null
  });
}));

router.get('/orders/:token/events', asyncRoute(async (req, res) => {
  const order = await findByToken(req.params.token);
  if (!order) return fail(res, 404, 'Pedido não encontrado.');
  openStream(req, res, (event) => event.orderId === Number(order.id));
}));

router.post('/orders/:token/claim-payment', claimLimiter, asyncRoute(async (req, res) => {
  const order = await findByToken(req.params.token);
  if (!order) return fail(res, 404, 'Pedido não encontrado.');
  const updated = await withTransaction(pool, async (db) => {
    const result = await db.query(`UPDATE orders SET payment_status='pending_review', payment_claimed_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND status='active' AND payment_method='pix' AND payment_status='awaiting_payment' AND mp_payment_id IS NULL AND (expires_at IS NULL OR expires_at>NOW())
      RETURNING id`, [order.id]);
    if (!result.rowCount) return false;
    await addHistory(db, { orderId: order.id, kind: 'payment', status: 'claimed', note: 'Comprador informou que fez o PIX', actor: { name: 'Comprador' } });
    return true;
  });
  if (!updated) return fail(res, 409, 'Pedido expirado ou já enviado para conferência. Se pagou após o prazo, procure a equipe financeira.');
  publish('order', { orderId: Number(order.id) });
  res.json({ ok: true, message: 'Solicitação registrada. A equipe financeira ainda precisa conferir o recebimento.' });
}));

// PIX automático: gera (ou devolve) o QR Code do Mercado Pago para o pedido.
router.post('/orders/:token/pix', pixLimiter, asyncRoute(async (req, res) => {
  const order = await findByToken(req.params.token);
  if (!order) return fail(res, 404, 'Pedido não encontrado.');
  res.json(await ensurePixCharge(order.id));
}));

// Confere no Mercado Pago se o PIX já caiu (complementa o webhook, que pode atrasar ou não chegar).
router.post('/orders/:token/pix/check', pixLimiter, asyncRoute(async (req, res) => {
  const order = await findByToken(req.params.token);
  if (!order) return fail(res, 404, 'Pedido não encontrado.');
  if (order.mp_payment_id && ['awaiting_payment', 'partial'].includes(order.payment_status)) await syncPixPayment(order.mp_payment_id);
  const { rows } = await pool.query('SELECT payment_status FROM orders WHERE id=$1', [order.id]);
  res.json({ paymentStatus: rows[0].payment_status });
}));

// Notificações do Mercado Pago. O conteúdo é só um aviso: o pagamento é sempre consultado na API deles.
router.post('/mercadopago/webhook', asyncRoute(async (req, res) => {
  const type = req.query.type || req.query.topic || req.body?.type;
  const id = String(req.query['data.id'] || req.body?.data?.id || req.query.id || '');
  if (type !== 'payment' || !/^\d{1,30}$/.test(id)) return res.sendStatus(200);
  if (!mercadoPagoEnabled()) return res.sendStatus(200);
  if (!validWebhookSignature(req, id)) return fail(res, 401, 'Assinatura inválida.');
  await syncPixPayment(id);
  res.sendStatus(200);
}));

export default router;
