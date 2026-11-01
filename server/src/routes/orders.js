// Gestão interna de pedidos: listagem, detalhes, Kanban da cozinha, cancelamento e tempo real.
import { Router } from 'express';
import { z } from 'zod';
import { pool, readSettings } from '../db.js';
import { auth, can } from '../lib/auth.js';
import { markCredit, registerPayments, paymentLinesSchema } from '../lib/payments.js';
import { staffOrderSchema, validateOrder, insertOrder } from '../lib/create-order.js';
import { expireDueOrders } from '../lib/expiry.js';
import { cancelPixCharges } from '../lib/mercadopago.js';
import { asyncRoute, fail, parse, toCents, toId, toMoney, withTransaction, HttpError } from '../lib/http.js';
import { readPeriod, periodSql, TIMEZONE } from '../lib/time.js';
import {
  PRODUCTION_FLOW, PRODUCTION_LABELS, PRODUCTION_TIMESTAMP, SERVICE_TYPES, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, SERVICE_LABELS,
  checkTransition, addHistory, serializeOrder, recomputePayment, requireOpenSession, restock
} from '../lib/orders.js';
import { publish, openStream } from '../lib/events.js';

const router = Router();

router.get('/events', auth('orders.view'), (req, res) => {
  // Eventos indicam apenas "pedido X mudou"; os dados são recarregados pelas rotas protegidas.
  openStream(req, res);
});

router.get('/summary', auth('orders.view'), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT
      COUNT(*) FILTER (WHERE (created_at AT TIME ZONE $1)::date=(NOW() AT TIME ZONE $1)::date) AS today,
      COUNT(*) FILTER (WHERE status='active' AND payment_status='awaiting_payment') AS awaiting_payment,
      COUNT(*) FILTER (WHERE status IN ('active','expired') AND payment_status='pending_review') AS pending_review,
      COUNT(*) FILTER (WHERE status='active' AND production_status='new') AS new_orders,
      COUNT(*) FILTER (WHERE status='active' AND production_status='in_production') AS in_production,
      COUNT(*) FILTER (WHERE status='active' AND production_status IN ('ready','awaiting_pickup')) AS ready
    FROM orders`, [TIMEZONE]);
  res.json(rows[0]);
}));

const listSchema = z.object({
  status: z.enum(['active', 'cancelled', 'expired']).optional(),
  production: z.enum(PRODUCTION_FLOW).optional(),
  payment: z.enum(['awaiting_payment', 'pending_review', 'partial', 'confirmed', 'refunded']).optional(),
  mode: z.enum(['religious', 'snack']).optional(),
  service: z.enum(SERVICE_TYPES).optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  q: z.string().trim().max(80).optional()
});

router.get('/orders', auth('orders.view'), asyncRoute(async (req, res) => {
  await expireDueOrders(pool);
  const period = readPeriod(req.query);
  const filters = parse(listSchema, Object.fromEntries(Object.entries(req.query).filter(([, value]) => value !== '')), 'Filtro inválido.');
  const params = [period.from, period.to, TIMEZONE];
  const where = [periodSql('created_at', 1)];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (filters.status) add('status=?', filters.status);
  if (filters.production) add('production_status=?', filters.production);
  if (filters.payment) add('payment_status=?', filters.payment);
  if (filters.mode) add('mode=?', filters.mode);
  if (filters.service) add('service_type=?', filters.service);
  if (filters.method) add('payment_method=?', filters.method);
  if (filters.q) {
    params.push(`%${filters.q.toLowerCase()}%`);
    const i = params.length;
    where.push(`(LOWER(order_number) LIKE $${i} OR LOWER(buyer_name) LIKE $${i} OR LOWER(team_name) LIKE $${i} OR buyer_phone LIKE $${i} OR ticket_number::text = $${i + 1})`);
    params.push(filters.q.replace(/^#/, ''));
  }
  const { rows } = await pool.query(`SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, params);
  res.json(rows.map(serializeOrder));
}));

router.get('/orders/:id', auth('orders.view'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const result = await pool.query('SELECT * FROM orders WHERE id=$1', [id]);
  if (!result.rowCount) return fail(res, 404, 'Pedido não encontrado.');
  const history = await pool.query('SELECT kind,status,from_status,note,actor,created_at FROM order_history WHERE order_id=$1 ORDER BY created_at, id', [id]);
  const payments = await pool.query(`SELECT id,kind,method,amount_cents,tendered_cents,change_cents,status,note,created_by_name,created_at,
      voided_at,voided_by_name,void_reason,session_id FROM payments WHERE order_id=$1 ORDER BY created_at, id`, [id]);
  res.json({
    ...serializeOrder(result.rows[0]),
    history: history.rows,
    payments: payments.rows.map((p) => ({ ...p, amount: toMoney(p.amount_cents), tendered: p.tendered_cents == null ? null : toMoney(p.tendered_cents),
      change: p.change_cents == null ? null : toMoney(p.change_cents) }))
  });
}));

// ---------- Cozinha / Produção ----------

router.get('/kitchen', auth('kitchen.view'), asyncRoute(async (req, res) => {
  await expireDueOrders(pool);
  const period = readPeriod(req.query);
  const mode = req.query.mode === 'religious' ? 'religious' : 'snack';
  const { rows } = await pool.query(`SELECT * FROM orders WHERE mode=$4 AND status='active' AND ${periodSql('created_at', 1)}
    ORDER BY created_at ASC LIMIT 600`, [period.from, period.to, TIMEZONE, mode]);
  // Pedidos em aberto de dias anteriores ao período selecionado (para não serem esquecidos).
  const stale = await pool.query(`SELECT COUNT(*)::int AS count FROM orders WHERE mode=$3 AND status='active' AND production_status<>'finalized'
    AND created_at < ($1::date)::timestamp AT TIME ZONE $2`, [period.from, TIMEZONE, mode]);
  const settings = await readSettings();
  res.json({
    orders: rows.map(serializeOrder),
    staleOpen: stale.rows[0].count,
    requirePixConfirmation: settings.kitchen?.require_pix_confirmation !== false,
    serverTime: new Date().toISOString()
  });
}));

const moveSchema = z.object({
  to: z.enum(PRODUCTION_FLOW),
  from: z.enum(PRODUCTION_FLOW),
  reason: z.string().trim().max(300).optional(),
  acknowledgeUnpaid: z.boolean().optional(),
  credit: z.boolean().optional()
});

router.post('/orders/:id/production', auth('kitchen.move'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const input = parse(moveSchema, req.body, 'Movimentação inválida.');
  const settings = await readSettings();
  await withTransaction(pool, async (db) => {
    const found = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new HttpError(404, 'Pedido não encontrado.');
    const order = found.rows[0];
    // Controle de concorrência: se outra pessoa já moveu o pedido, não sobrescreve.
    if (order.production_status !== input.from) {
      throw new HttpError(409, `Este pedido já foi movido para "${PRODUCTION_LABELS[order.production_status]}" por outra pessoa. A tela foi atualizada.`, 'STALE');
    }
    // Finalizar lançando o saldo em aberto como fiado.
    if (input.credit && input.to === 'finalized' && order.payment_status !== 'confirmed' && !order.on_credit) {
      if (!can(req.user.role, 'credits.manage')) throw new HttpError(403, 'Seu perfil não pode lançar fiado.');
      await markCredit(db, { orderId: id, actor: req.user });
      order.on_credit = true;
    }
    const direction = checkTransition(order, input.to, req.user.role, { reason: input.reason, acknowledgeUnpaid: input.acknowledgeUnpaid, settings });
    const sets = ['production_status=$1', 'updated_at=NOW()'];
    if (direction === 'forward') {
      // Etapas puladas também ganham horário (a linha do tempo do pedido fica completa).
      const steps = PRODUCTION_FLOW.slice(PRODUCTION_FLOW.indexOf(order.production_status) + 1, PRODUCTION_FLOW.indexOf(input.to) + 1);
      for (const step of steps) if (PRODUCTION_TIMESTAMP[step]) sets.push(`${PRODUCTION_TIMESTAMP[step]}=${step === input.to ? 'NOW()' : `COALESCE(${PRODUCTION_TIMESTAMP[step]},NOW())`}`);
    }
    // Ao desfazer, limpa o horário da etapa que foi revertida.
    if (direction === 'backward' && PRODUCTION_TIMESTAMP[order.production_status]) sets.push(`${PRODUCTION_TIMESTAMP[order.production_status]}=NULL`);
    await db.query(`UPDATE orders SET ${sets.join(',')} WHERE id=$2`, [input.to, id]);
    let note = direction === 'backward' ? `Correção: ${input.reason}` : `${PRODUCTION_LABELS[order.production_status]} → ${PRODUCTION_LABELS[input.to]}`;
    if (input.to === 'finalized' && order.payment_status !== 'confirmed') note += order.on_credit ? ' (fiado)' : ' (finalizado sem pagamento confirmado)';
    await addHistory(db, { orderId: id, kind: 'production', status: input.to, fromStatus: order.production_status, note, actor: req.user });
  });
  publish('order', { orderId: id });
  res.json({ ok: true });
}));

// ---------- Cancelamento ----------

const cancelSchema = z.object({
  reason: z.string().trim().min(3, 'Informe o motivo do cancelamento.').max(300),
  refund: z.boolean().default(false),
  idempotencyKey: z.string().uuid().optional()
});

router.post('/orders/:id/cancel', auth('orders.cancel'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const input = parse(cancelSchema, req.body);
  const cancelled = await withTransaction(pool, async (db) => {
    const found = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new HttpError(404, 'Pedido não encontrado.');
    const order = found.rows[0];
    if (order.status === 'cancelled') throw new HttpError(409, 'Pedido já cancelado.');
    const net = order.paid_cents - order.refunded_cents;
    if (net > 0) {
      // Pedido com valor recebido: só cancela registrando o estorno de cada recebimento.
      if (!['admin', 'finance'].includes(req.user.role)) throw new HttpError(403, 'Pedido com pagamento registrado: o cancelamento com estorno é feito pelo financeiro.');
      if (!input.refund) throw new HttpError(409, `Este pedido tem ${toMoney(net).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} recebidos. Confirme o estorno para cancelar.`, 'REFUND_REQUIRED');
      const session = await requireOpenSession(db);
      const payments = await db.query(`SELECT method, SUM(CASE WHEN kind='payment' THEN amount_cents ELSE -amount_cents END)::int AS net
        FROM payments WHERE order_id=$1 AND status='confirmed' GROUP BY method HAVING SUM(CASE WHEN kind='payment' THEN amount_cents ELSE -amount_cents END) > 0`, [id]);
      for (const payment of payments.rows) {
        await db.query(`INSERT INTO payments(order_id,session_id,kind,method,amount_cents,note,created_by,created_by_name)
          VALUES($1,$2,'refund',$3,$4,$5,$6,$7)`, [id, session.id, payment.method, payment.net, `Estorno por cancelamento: ${input.reason}`, req.user.id, req.user.name]);
        await addHistory(db, { orderId: id, kind: 'payment', status: 'refunded', note: `Estorno ${PAYMENT_METHOD_LABELS[payment.method]} ${toMoney(payment.net).toFixed(2)}`, actor: req.user });
      }
      await recomputePayment(db, id);
    }
    await db.query(`UPDATE orders SET status='cancelled', cancelled_at=NOW(), cancel_reason=$1, updated_at=NOW() WHERE id=$2`, [input.reason, id]);
    await restock(db, order);
    await addHistory(db, { orderId: id, kind: 'order', status: 'cancelled', fromStatus: order.status, note: input.reason, actor: req.user });
    return order;
  });
  // PIX ainda não pago: a cobrança no Mercado Pago deixa de valer. PIX já recebido é devolvido pelo painel do Mercado Pago.
  if (cancelled.paid_cents - cancelled.refunded_cents <= 0) await cancelPixCharges([cancelled.mp_payment_id]);
  publish('order', { orderId: id });
  publish('payment', { orderId: id });
  res.json({ ok: true });
}));

// Situação do caixa para quem vende no balcão (sem expor valores).
router.get('/cash-status', auth('orders.view'), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query("SELECT opened_at, opened_by_name FROM cash_sessions WHERE status='open'");
  res.json({ open: rows.length > 0, openedAt: rows[0]?.opened_at || null, openedBy: rows[0]?.opened_by_name || null });
}));

// ---------- Dados do cliente ----------

router.patch('/orders/:id/customer', auth('orders.edit'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const input = parse(z.object({
    buyerName: z.string().trim().min(2, 'Informe o nome.').max(120),
    buyerPhone: z.string().trim().max(30).refine((v) => !v || (v.replace(/\D/g, '').length >= 10 && v.replace(/\D/g, '').length <= 13), 'Telefone inválido: informe com DDD.'),
    teamId: z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().int().positive().nullable())
  }), req.body);
  await withTransaction(pool, async (db) => {
    const found = await db.query('SELECT buyer_name,buyer_phone,team_name,on_credit FROM orders WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new HttpError(404, 'Pedido não encontrado.');
    if (found.rows[0].on_credit && input.buyerPhone.replace(/\D/g, '').length < 10) throw new HttpError(400, 'Pedido no fiado precisa manter um telefone válido.');
    let teamName = 'Sem equipe';
    if (input.teamId) {
      const team = await db.query('SELECT name FROM teams WHERE id=$1', [input.teamId]);
      if (!team.rowCount) throw new HttpError(400, 'Equipe não encontrada.');
      teamName = team.rows[0].name;
    }
    await db.query('UPDATE orders SET buyer_name=$1, buyer_phone=$2, team_id=$3, team_name=$4, updated_at=NOW() WHERE id=$5', [input.buyerName, input.buyerPhone, input.teamId, teamName, id]);
    const old = found.rows[0];
    await addHistory(db, { orderId: id, kind: 'order', status: 'customer_updated', note: `Cliente: ${old.buyer_name} / ${old.buyer_phone || 'sem telefone'} / ${old.team_name} → ${input.buyerName} / ${input.buyerPhone || 'sem telefone'} / ${teamName}`, actor: req.user });
  });
  publish('order', { orderId: id });
  res.json({ ok: true });
}));

// ---------- Venda no balcão ----------

const posSchema = staffOrderSchema.extend({
  payment: z.discriminatedUnion('type', [
    z.object({ type: z.literal('pay'), lines: paymentLinesSchema, idempotencyKey: z.string().uuid() }),
    z.object({ type: z.literal('credit'), note: z.string().trim().max(300).default('') }),
    z.object({ type: z.literal('later'), method: z.enum(PAYMENT_METHODS) })
  ], { errorMap: () => ({ message: 'Escolha como o cliente vai pagar.' }) })
});

router.post('/pos/orders', auth('pos.sell'), asyncRoute(async (req, res) => {
  const input = parse(posSchema, req.body, 'Confira os dados da venda.');
  if (input.clientRequestId) {
    const existing = await pool.query('SELECT * FROM orders WHERE client_request_id=$1', [input.clientRequestId]);
    if (existing.rowCount) return res.json({ id: existing.rows[0].id, ticket: existing.rows[0].ticket_number, orderNumber: existing.rows[0].order_number, token: existing.rows[0].public_token, duplicate: true });
  }
  if (input.payment.type === 'credit') {
    if (!can(req.user.role, 'credits.manage')) throw new HttpError(403, 'Seu perfil não pode lançar fiado.');
    if (input.buyerPhone.replace(/\D/g, '').length < 10) throw new HttpError(400, 'Para vender no fiado, informe o telefone do cliente.');
  }
  const settings = await readSettings();
  const payment = input.payment;
  const hasCreditLine = payment.type === 'pay' && payment.lines.some((line) => line.method === 'fiado');
  if (hasCreditLine && input.buyerPhone.replace(/\D/g, '').length < 10) throw new HttpError(400, 'Para deixar parte no fiado, informe o telefone do cliente.');
  const method = payment.type === 'pay' ? (payment.lines.find((line) => line.method !== 'fiado') || payment.lines[0]).method
    : payment.type === 'credit' ? 'fiado' : payment.method;
  // Comanda mista: lanchonete e artigos viram dois pedidos com a mesma senha (a lanchonete vai para a cozinha;
  // os artigos ficam no catálogo deles, para o financeiro não misturar). A taxa de entrega fica com o primeiro.
  const parts = ['snack', 'religious'].map((mode) => ({ mode, items: input.items.filter((item) => (item.mode || input.mode) === mode) }))
    .filter((part) => part.items.length);
  const result = await withTransaction(pool, async (db) => {
    const orders = [];
    for (const [index, part] of parts.entries()) {
      const partInput = { ...input, mode: part.mode, items: part.items,
        serviceType: part.mode === 'religious' && input.serviceType === 'dine_in' ? 'pickup' : input.serviceType };
      const { deliveryFeeCents, tableNumber } = validateOrder(partInput, settings, { staff: true });
      orders.push(await insertOrder(db, { ...partInput, clientRequestId: index ? null : input.clientRequestId }, settings, {
        paymentMethod: method, onCredit: payment.type === 'credit', actor: req.user, deliveryFeeCents: index ? 0 : deliveryFeeCents, tableNumber,
        ticket: index ? orders[0].ticket_number : undefined }));
    }
    if (orders.length > 1) {
      for (const [order, other] of [[orders[0], orders[1]], [orders[1], orders[0]]]) {
        await addHistory(db, { orderId: order.id, kind: 'order', status: 'linked', note: `Mesma comanda do pedido ${other.order_number} (${other.mode === 'snack' ? 'lanchonete' : 'artigos religiosos'})`, actor: req.user });
      }
    }
    let change = 0;
    if (payment.type === 'pay') {
      // Valida o caixa e a soma antes de confirmar a venda: se algo falhar, nada é gravado.
      const split = splitPaymentLines(payment.lines, orders.map((order) => order.total_cents));
      for (const [index, order] of orders.entries()) {
        const paid = await registerPayments(db, { orderId: order.id, lines: split[index], idempotencyKey: index ? `${payment.idempotencyKey}-${index}` : payment.idempotencyKey,
          actor: req.user, settings, note: 'Venda no balcão' });
        change += paid.change || 0;
      }
    }
    return { orders, change };
  });
  const [main, linked] = result.orders;
  for (const order of result.orders) {
    publish('order', { orderId: order.id, created: true, mode: order.mode });
    if (payment.type === 'pay') publish('payment', { orderId: order.id });
  }
  res.status(201).json({ id: main.id, ticket: main.ticket_number, orderNumber: main.order_number, token: main.public_token,
    total: toMoney(result.orders.reduce((sum, order) => sum + order.total_cents, 0)), change: toMoney(result.change),
    linked: linked ? { id: linked.id, orderNumber: linked.order_number, total: toMoney(linked.total_cents) } : null });
}));

// Reparte as formas de pagamento da comanda entre os pedidos (na ordem), sem mudar o total de cada forma.
// O troco do dinheiro fica com o último pedaço em dinheiro.
function splitPaymentLines(lines, totals) {
  const sum = lines.reduce((total, line) => total + toCents(line.amount), 0);
  const expected = totals.reduce((total, value) => total + value, 0);
  if (sum !== expected) throw new HttpError(400, `A soma das formas de pagamento (${toMoney(sum).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}) deve ser igual ao total (${toMoney(expected).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}).`);
  if (totals.length === 1) return [lines];
  const queue = lines.map((line) => ({ ...line, left: toCents(line.amount) }));
  const split = totals.map((total) => {
    const pieces = [];
    let need = total;
    for (const line of queue) {
      if (!need) break;
      const take = Math.min(line.left, need);
      if (!take) continue;
      line.left -= take; need -= take;
      pieces.push({ method: line.method, amount: toMoney(take), tendered: null, source: line });
    }
    return pieces;
  });
  for (const line of queue.filter((item) => item.method === 'cash' && item.tendered != null)) {
    const last = split.flat().filter((piece) => piece.source === line).at(-1);
    if (last) last.tendered = toMoney(toCents(last.amount) + toCents(line.tendered) - toCents(line.amount));
  }
  return split.map((pieces) => pieces.map(({ source, ...piece }) => piece));
}

// ---------- Relatório CSV ----------

router.get('/report.csv', auth('finance.view'), asyncRoute(async (req, res) => {
  const period = readPeriod(req.query);
  const { rows } = await pool.query(`SELECT * FROM orders WHERE ${periodSql('created_at', 1)} ORDER BY created_at`, [period.from, period.to, TIMEZONE]);
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const statusLabel = { active: 'Ativo', cancelled: 'Cancelado', expired: 'Expirado' };
  const paymentLabel = { awaiting_payment: 'Aguardando pagamento', pending_review: 'Em conferência', partial: 'Parcial', confirmed: 'Pago', refunded: 'Estornado' };
  const formatMoney = (cents) => (Number(cents) / 100).toFixed(2).replace('.', ',');
  const lines = [
    ['Pedido', 'Senha', 'Data', 'Comprador', 'Telefone', 'Equipe', 'Catálogo', 'Atendimento', 'Forma de pagamento', 'Subtotal', 'Entrega', 'Total', 'Recebido', 'Situação do pagamento', 'Etapa', 'Situação'],
    ...rows.map((r) => [r.order_number, r.ticket_number, new Date(r.created_at).toLocaleString('pt-BR', { timeZone: TIMEZONE }), r.buyer_name, r.buyer_phone, r.team_name,
      r.mode === 'snack' ? 'Lanchonete' : 'Artigos religiosos', SERVICE_LABELS[r.service_type], PAYMENT_METHOD_LABELS[r.payment_method],
      formatMoney(r.subtotal_cents), formatMoney(r.delivery_fee_cents), formatMoney(r.total_cents), formatMoney(r.paid_cents - r.refunded_cents),
      paymentLabel[r.payment_status], PRODUCTION_LABELS[r.production_status], statusLabel[r.status]])
  ].map((row) => row.map(escape).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="pedidos-${period.from}-a-${period.to}.csv"`);
  res.send(`﻿${lines.join('\n')}`);
}));

export default router;
