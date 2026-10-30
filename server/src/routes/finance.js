// Financeiro: indicadores, conferência de PIX, registro de recebimentos e caixa.
//
// Definições usadas em todo o módulo:
// - Venda registrada: pedido ativo (não cancelado nem expirado), pelo valor total.
// - Recebimento confirmado: registro na tabela payments (kind='payment', status='confirmed').
//   O "Já paguei" do comprador NÃO é recebimento; apenas coloca o pedido em conferência.
// - Valor recebido (líquido): recebimentos confirmados menos estornos confirmados.
import { Router } from 'express';
import { z } from 'zod';
import { pool, readSettings } from '../db.js';
import { auth } from '../lib/auth.js';
import { asyncRoute, fail, parse, toId, toCents, toMoney, withTransaction, HttpError } from '../lib/http.js';
import { readPeriod, periodSql, TIMEZONE } from '../lib/time.js';
import {
  PAYMENT_METHODS, PAYMENT_METHOD_LABELS, SERVICE_TYPES,
  addHistory, recomputePayment, requireOpenSession, serializeOrder, audit
} from '../lib/orders.js';
import { paymentLinesSchema, registerPayments, markCredit } from '../lib/payments.js';
import { publish } from '../lib/events.js';

const router = Router();
const money = (value) => toMoney(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const emptyMethods = () => Object.fromEntries(PAYMENT_METHODS.map((method) => [method, { received: 0, refunded: 0, net: 0, count: 0, orders: 0 }]));

// ---------- Indicadores ----------

const summaryFilters = z.object({
  service: z.enum(SERVICE_TYPES).optional(),
  mode: z.enum(['religious', 'snack']).optional(),
  method: z.enum(PAYMENT_METHODS).optional()
});

router.get('/summary', auth('finance.view'), asyncRoute(async (req, res) => {
  const period = readPeriod(req.query);
  const filters = parse(summaryFilters, Object.fromEntries(Object.entries(req.query).filter(([key, value]) => value !== '' && key in summaryFilters.shape)), 'Filtro inválido.');

  // Pedidos criados no período.
  const orderParams = [period.from, period.to, TIMEZONE];
  const orderWhere = [periodSql('o.created_at', 1)];
  if (filters.service) { orderParams.push(filters.service); orderWhere.push(`o.service_type=$${orderParams.length}`); }
  if (filters.mode) { orderParams.push(filters.mode); orderWhere.push(`o.mode=$${orderParams.length}`); }
  if (filters.method) { orderParams.push(filters.method); orderWhere.push(`o.payment_method=$${orderParams.length}`); }
  const orderSql = orderWhere.join(' AND ');

  const counts = (await pool.query(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='active')::int AS valid,
      COUNT(*) FILTER (WHERE status='active' AND payment_status='confirmed')::int AS paid,
      COUNT(*) FILTER (WHERE status='active' AND payment_status IN ('awaiting_payment','pending_review','partial'))::int AS pending,
      COUNT(*) FILTER (WHERE status='active' AND payment_status='pending_review')::int AS pix_review,
      COUNT(*) FILTER (WHERE status='active' AND on_credit AND payment_status<>'confirmed')::int AS on_credit,
      COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
      COUNT(*) FILTER (WHERE status='expired')::int AS expired,
      COALESCE(SUM(total_cents) FILTER (WHERE status='active'),0)::int AS sales_cents,
      COALESCE(SUM(GREATEST(total_cents-(paid_cents-refunded_cents),0)) FILTER (WHERE status='active'),0)::int AS pending_cents
    FROM orders o WHERE ${orderSql}`, orderParams)).rows[0];

  const byService = (await pool.query(`SELECT service_type, COUNT(*)::int AS orders, COALESCE(SUM(total_cents),0)::int AS sales_cents
    FROM orders o WHERE ${orderSql} AND status='active' GROUP BY service_type ORDER BY service_type`, orderParams)).rows;

  const byProduct = (await pool.query(`SELECT item->>'name' AS name,
      CASE WHEN COALESCE(item->>'category','') ~ '^[0-9]*$' THEN 'Sem categoria' ELSE item->>'category' END AS category,
      SUM((item->>'quantity')::int)::int AS quantity,
      SUM(COALESCE((item->>'totalCents')::int, (item->>'unitCents')::int * (item->>'quantity')::int))::int AS total_cents
    FROM orders o, jsonb_array_elements(o.items) AS item
    WHERE ${orderSql} AND status='active' GROUP BY 1,2 ORDER BY total_cents DESC, name LIMIT 60`, orderParams)).rows;

  // Recebimentos registrados no período (data do registro do recebimento).
  const payParams = [period.from, period.to, TIMEZONE];
  const payWhere = [periodSql('p.created_at', 1), "p.status='confirmed'"];
  if (filters.service) { payParams.push(filters.service); payWhere.push(`o.service_type=$${payParams.length}`); }
  if (filters.mode) { payParams.push(filters.mode); payWhere.push(`o.mode=$${payParams.length}`); }
  if (filters.method) { payParams.push(filters.method); payWhere.push(`p.method=$${payParams.length}`); }
  const payRows = (await pool.query(`SELECT p.method, p.kind, COUNT(*)::int AS count, COUNT(DISTINCT p.order_id)::int AS orders,
      SUM(p.amount_cents)::int AS cents
    FROM payments p JOIN orders o ON o.id=p.order_id WHERE ${payWhere.join(' AND ')} GROUP BY p.method, p.kind`, payParams)).rows;
  const methods = emptyMethods();
  for (const row of payRows) {
    const target = methods[row.method];
    if (row.kind === 'payment') { target.received += row.cents; target.count += row.count; target.orders += row.orders; }
    else target.refunded += row.cents;
  }
  let received = 0; let refunded = 0;
  for (const target of Object.values(methods)) {
    target.net = target.received - target.refunded;
    received += target.received; refunded += target.refunded;
  }
  const byServiceReceived = (await pool.query(`SELECT o.service_type,
      SUM(CASE WHEN p.kind='payment' THEN p.amount_cents ELSE -p.amount_cents END)::int AS net_cents
    FROM payments p JOIN orders o ON o.id=p.order_id WHERE ${payWhere.join(' AND ')} GROUP BY o.service_type`, payParams)).rows;

  // Fiado em aberto (todos os períodos): valor que ainda precisa ser cobrado.
  const credits = (await pool.query(`SELECT COUNT(*)::int AS count,
      COALESCE(SUM(GREATEST(total_cents-(paid_cents-refunded_cents),0)),0)::int AS cents
    FROM orders WHERE on_credit=TRUE AND status='active' AND payment_status<>'confirmed'`)).rows[0];

  const centsToMoney = (object) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, key.endsWith('cents') || ['received', 'refunded', 'net'].includes(key) ? toMoney(value) : value]));
  res.json({
    period,
    orders: { ...counts, sales: toMoney(counts.sales_cents), pendingAmount: toMoney(counts.pending_cents) },
    received: { gross: toMoney(received), refunded: toMoney(refunded), net: toMoney(received - refunded) },
    credits: { count: credits.count, total: toMoney(credits.cents) },
    methods: Object.fromEntries(Object.entries(methods).map(([key, value]) => [key, centsToMoney(value)])),
    byService: SERVICE_TYPES.map((type) => {
      const sales = byService.find((row) => row.service_type === type);
      const net = byServiceReceived.find((row) => row.service_type === type);
      return { serviceType: type, orders: sales?.orders || 0, sales: toMoney(sales?.sales_cents || 0), received: toMoney(net?.net_cents || 0) };
    }),
    byProduct: byProduct.map((row) => ({ name: row.name, category: row.category, quantity: row.quantity, total: toMoney(row.total_cents) }))
  });
}));

// ---------- Fila de conferência e recebimento ----------

router.get('/queue', auth('finance.view'), asyncRoute(async (_req, res) => {
  const review = await pool.query(`SELECT * FROM orders WHERE payment_status='pending_review' AND status IN ('active','expired')
    ORDER BY payment_claimed_at ASC NULLS LAST LIMIT 200`);
  const unpaid = await pool.query(`SELECT * FROM orders WHERE status='active' AND payment_status IN ('awaiting_payment','partial')
    AND created_at > NOW() - INTERVAL '3 days' ORDER BY created_at ASC LIMIT 300`);
  res.json({ review: review.rows.map(serializeOrder), unpaid: unpaid.rows.map(serializeOrder) });
}));

router.get('/payments', auth('finance.view'), asyncRoute(async (req, res) => {
  const period = readPeriod(req.query);
  const { rows } = await pool.query(`SELECT p.*, o.order_number, o.ticket_number, o.buyer_name, o.service_type, o.mode
    FROM payments p JOIN orders o ON o.id=p.order_id WHERE ${periodSql('p.created_at', 1)} ORDER BY p.created_at DESC LIMIT 1000`,
  [period.from, period.to, TIMEZONE]);
  res.json(rows.map(serializePayment));
}));

function serializePayment(p) {
  return {
    id: p.id, orderId: p.order_id, orderNumber: p.order_number, ticket: p.ticket_number, buyerName: p.buyer_name, serviceType: p.service_type,
    mode: p.mode, sessionId: p.session_id, kind: p.kind, method: p.method, amount: toMoney(p.amount_cents),
    tendered: p.tendered_cents == null ? null : toMoney(p.tendered_cents), change: p.change_cents == null ? null : toMoney(p.change_cents),
    status: p.status, note: p.note, createdBy: p.created_by_name, createdAt: p.created_at,
    voidedAt: p.voided_at, voidedBy: p.voided_by_name, voidReason: p.void_reason
  };
}

const paymentSchema = z.object({
  idempotencyKey: z.string().uuid(),
  note: z.string().trim().max(300).default(''),
  lines: paymentLinesSchema
});

// Registra o recebimento do valor em aberto, em uma ou mais formas (pagamento misto). Também é a "baixa" do fiado.
router.post('/orders/:id/payments', auth('payments.register'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const input = parse(paymentSchema, req.body, 'Confira os valores do recebimento.');
  const settings = await readSettings();
  const result = await withTransaction(pool, (db) => registerPayments(db, { orderId: id, lines: input.lines, note: input.note, idempotencyKey: input.idempotencyKey, actor: req.user, settings }));
  publish('payment', { orderId: id });
  publish('order', { orderId: id });
  if (result.duplicate) return res.json({ ok: true, duplicate: true });
  res.status(201).json({ ok: true, paymentStatus: result.payment.status, change: toMoney(result.change) });
}));

// ---------- Fiado ----------

router.post('/orders/:id/credit', auth('credits.manage'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const input = parse(z.object({ note: z.string().trim().max(300).default('') }), req.body || {});
  await withTransaction(pool, (db) => markCredit(db, { orderId: id, actor: req.user, note: input.note }));
  publish('order', { orderId: id });
  res.json({ ok: true });
}));

router.get('/credits', auth('credits.view'), asyncRoute(async (req, res) => {
  const settled = req.query.status === 'settled';
  const { rows } = await pool.query(settled
    ? `SELECT * FROM orders WHERE on_credit=TRUE AND payment_status='confirmed' ORDER BY paid_at DESC NULLS LAST LIMIT 300`
    : `SELECT * FROM orders WHERE on_credit=TRUE AND status='active' AND payment_status<>'confirmed' ORDER BY credit_at ASC LIMIT 1000`);
  const orders = rows.map(serializeOrder);
  const open = settled ? null : {
    count: orders.length,
    total: orders.reduce((sum, o) => sum + o.balance, 0),
    customers: new Set(orders.map((o) => o.buyerPhone.replace(/\D/g, '') || o.buyerName.toLowerCase())).size
  };
  res.json({ orders, summary: open });
}));

router.post('/orders/:id/reject-claim', auth('finance.payments'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const input = parse(z.object({ reason: z.string().trim().min(3, 'Informe o motivo.').max(300) }), req.body);
  await withTransaction(pool, async (db) => {
    const found = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new HttpError(404, 'Pedido não encontrado.');
    if (found.rows[0].payment_status !== 'pending_review') throw new HttpError(409, 'Não há solicitação de conferência pendente neste pedido.');
    await db.query('UPDATE orders SET payment_claimed_at=NULL, decision_note=$1, updated_at=NOW() WHERE id=$2', [input.reason, id]);
    await recomputePayment(db, id);
    await addHistory(db, { orderId: id, kind: 'payment', status: 'claim_rejected', note: `PIX não localizado: ${input.reason}`, actor: req.user });
  });
  publish('order', { orderId: id });
  res.json({ ok: true });
}));

router.post('/payments/:id/void', auth('finance.payments'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const input = parse(z.object({ reason: z.string().trim().min(5, 'Explique o motivo da anulação (mínimo 5 caracteres).').max(300) }), req.body);
  const orderId = await withTransaction(pool, async (db) => {
    const found = await db.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new HttpError(404, 'Recebimento não encontrado.');
    const payment = found.rows[0];
    if (payment.status !== 'confirmed') throw new HttpError(409, 'Este lançamento já foi anulado.');
    if (payment.kind !== 'payment') throw new HttpError(409, 'Estornos não podem ser anulados.');
    const order = (await db.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [payment.order_id])).rows[0];
    if (order.status === 'cancelled') throw new HttpError(409, 'Pedido cancelado: o recebimento já foi tratado no estorno.');
    // O gatilho do banco recusa a alteração se o lançamento pertencer a um caixa fechado.
    await db.query(`UPDATE payments SET status='voided', voided_at=NOW(), voided_by_name=$1, void_reason=$2 WHERE id=$3`, [req.user.name, input.reason, id]);
    await recomputePayment(db, payment.order_id);
    await addHistory(db, { orderId: payment.order_id, kind: 'payment', status: 'voided',
      note: `Lançamento anulado (${PAYMENT_METHOD_LABELS[payment.method]} ${money(payment.amount_cents)}): ${input.reason}`, actor: req.user });
    return payment.order_id;
  });
  publish('payment', { orderId });
  publish('order', { orderId });
  res.json({ ok: true });
}));

// ---------- Caixa ----------

export async function computeSessionSummary(db, session) {
  const payments = (await db.query(`SELECT p.*, o.order_number, o.ticket_number, o.buyer_name, o.service_type, o.mode
    FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.session_id=$1 ORDER BY p.created_at, p.id`, [session.id])).rows;
  const movements = (await db.query('SELECT * FROM cash_movements WHERE session_id=$1 ORDER BY created_at, id', [session.id])).rows;
  const methods = emptyMethods();
  const ordersByMethod = Object.fromEntries(PAYMENT_METHODS.map((method) => [method, new Set()]));
  const byService = Object.fromEntries(SERVICE_TYPES.map((type) => [type, 0]));
  const paidOrders = new Set();
  let voidedCount = 0; let voidedCents = 0;
  for (const p of payments) {
    if (p.status !== 'confirmed') { voidedCount += 1; voidedCents += p.amount_cents; continue; }
    const target = methods[p.method];
    if (p.kind === 'payment') {
      target.received += p.amount_cents; target.count += 1; ordersByMethod[p.method].add(p.order_id); paidOrders.add(p.order_id);
      byService[p.service_type] += p.amount_cents;
    } else {
      target.refunded += p.amount_cents;
      byService[p.service_type] -= p.amount_cents;
    }
  }
  for (const method of PAYMENT_METHODS) {
    methods[method].net = methods[method].received - methods[method].refunded;
    methods[method].orders = ordersByMethod[method].size;
  }
  const withdrawals = movements.filter((m) => m.type === 'withdrawal').reduce((total, m) => total + m.amount_cents, 0);
  const supplies = movements.filter((m) => m.type === 'supply').reduce((total, m) => total + m.amount_cents, 0);
  const received = PAYMENT_METHODS.reduce((total, method) => total + methods[method].received, 0);
  const refunded = PAYMENT_METHODS.reduce((total, method) => total + methods[method].refunded, 0);
  const expectedCash = session.opening_cash_cents + methods.cash.net - withdrawals + supplies;

  // Pedidos criados enquanto o caixa esteve aberto.
  const end = session.closed_at || new Date();
  const orders = (await db.query(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='active')::int AS valid,
      COUNT(*) FILTER (WHERE status='active' AND payment_status='confirmed')::int AS paid,
      COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
      COUNT(*) FILTER (WHERE status='active' AND payment_status<>'confirmed')::int AS pending,
      COALESCE(SUM(GREATEST(total_cents-(paid_cents-refunded_cents),0)) FILTER (WHERE status='active' AND payment_status<>'confirmed'),0)::int AS pending_cents,
      COALESCE(SUM(total_cents) FILTER (WHERE status='active'),0)::int AS sales_cents
    FROM orders WHERE created_at >= $1 AND created_at <= $2`, [session.opened_at, end])).rows[0];
  const pixPending = (await db.query(`SELECT id, order_number, ticket_number, buyer_name, total_cents, payment_claimed_at FROM orders
    WHERE payment_status='pending_review' AND status IN ('active','expired') ORDER BY payment_claimed_at`)).rows;

  return {
    openingCash: session.opening_cash_cents,
    methods,
    received, refunded, net: received - refunded,
    withdrawals, supplies, expectedCash,
    byService,
    paidOrders: paidOrders.size,
    voided: { count: voidedCount, cents: voidedCents },
    orders,
    pixPending: pixPending.map((o) => ({ id: o.id, orderNumber: o.order_number, ticket: o.ticket_number, buyerName: o.buyer_name, totalCents: o.total_cents, claimedAt: o.payment_claimed_at })),
    payments: payments.map(serializePayment),
    movements: movements.map((m) => ({ id: m.id, type: m.type, amount: toMoney(m.amount_cents), reason: m.reason, createdBy: m.created_by_name, createdAt: m.created_at }))
  };
}

function serializeSession(session) {
  return {
    id: session.id, status: session.status, openedAt: session.opened_at, openedBy: session.opened_by_name,
    openingCash: toMoney(session.opening_cash_cents), openingNote: session.opening_note,
    closedAt: session.closed_at, closedBy: session.closed_by_name, closingNote: session.closing_note,
    countedCash: session.counted_cash_cents == null ? null : toMoney(session.counted_cash_cents),
    countedPix: session.counted_pix_cents == null ? null : toMoney(session.counted_pix_cents),
    countedDebit: session.counted_debit_cents == null ? null : toMoney(session.counted_debit_cents),
    countedCredit: session.counted_credit_cents == null ? null : toMoney(session.counted_credit_cents)
  };
}

router.get('/cash', auth('finance.view'), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM cash_sessions WHERE status='open'");
  if (!rows.length) return res.json({ session: null, summary: null });
  res.json({ session: serializeSession(rows[0]), summary: await computeSessionSummary(pool, rows[0]) });
}));

router.post('/cash/open', auth('finance.cash'), asyncRoute(async (req, res) => {
  const input = parse(z.object({ openingCash: z.number().min(0, 'Valor inicial inválido.').max(100000), note: z.string().trim().max(300).default('') }), req.body);
  try {
    const { rows } = await pool.query(`INSERT INTO cash_sessions(opened_by,opened_by_name,opening_cash_cents,opening_note) VALUES($1,$2,$3,$4) RETURNING *`,
      [req.user.id, req.user.name, toCents(input.openingCash), input.note]);
    await audit(pool, req.user, 'cash.open', 'cash_session', rows[0].id, { openingCash: input.openingCash });
    publish('cash', {});
    res.status(201).json({ session: serializeSession(rows[0]) });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'Já existe um caixa aberto.');
    throw error;
  }
}));

router.post('/cash/movements', auth('finance.cash'), asyncRoute(async (req, res) => {
  const input = parse(z.object({
    type: z.enum(['withdrawal', 'supply']),
    amount: z.number().positive('Informe um valor maior que zero.').max(100000),
    reason: z.string().trim().min(3, 'Informe o motivo.').max(300)
  }), req.body);
  await withTransaction(pool, async (db) => {
    const session = await requireOpenSession(db);
    if (input.type === 'withdrawal') {
      const summary = await computeSessionSummary(db, session);
      if (toCents(input.amount) > summary.expectedCash) throw new HttpError(400, `A sangria (${money(toCents(input.amount))}) é maior que o dinheiro esperado no caixa (${money(summary.expectedCash)}).`);
    }
    await db.query('INSERT INTO cash_movements(session_id,type,amount_cents,reason,created_by,created_by_name) VALUES($1,$2,$3,$4,$5,$6)',
      [session.id, input.type, toCents(input.amount), input.reason, req.user.id, req.user.name]);
  });
  publish('cash', {});
  res.status(201).json({ ok: true });
}));

const optionalMoney = z.number().min(0).max(1000000).nullable().default(null);
router.post('/cash/close', auth('finance.cash'), asyncRoute(async (req, res) => {
  const input = parse(z.object({
    sessionId: z.number().int().positive(),
    countedCash: z.number({ invalid_type_error: 'Informe o valor contado em dinheiro.', required_error: 'Informe o valor contado em dinheiro.' }).min(0).max(1000000),
    countedPix: optionalMoney, countedDebit: optionalMoney, countedCredit: optionalMoney,
    note: z.string().trim().max(1000).default(''),
    confirm: z.literal(true, { errorMap: () => ({ message: 'Confirme o fechamento.' }) })
  }), req.body, 'Confira os valores do fechamento.');
  const closed = await withTransaction(pool, async (db) => {
    const found = await db.query('SELECT * FROM cash_sessions WHERE id=$1 FOR UPDATE', [input.sessionId]);
    if (!found.rowCount) throw new HttpError(404, 'Caixa não encontrado.');
    const session = found.rows[0];
    if (session.status !== 'open') throw new HttpError(409, 'Este caixa já foi fechado.');
    const closedAt = new Date();
    const summary = await computeSessionSummary(db, { ...session, closed_at: closedAt });
    const counted = {
      cash: toCents(input.countedCash),
      pix: input.countedPix == null ? null : toCents(input.countedPix),
      debit: input.countedDebit == null ? null : toCents(input.countedDebit),
      credit: input.countedCredit == null ? null : toCents(input.countedCredit)
    };
    const differences = {
      cash: counted.cash - summary.expectedCash,
      pix: counted.pix == null ? null : counted.pix - summary.methods.pix.net,
      debit: counted.debit == null ? null : counted.debit - summary.methods.debit.net,
      credit: counted.credit == null ? null : counted.credit - summary.methods.credit.net
    };
    // O resumo salvo é a fotografia do fechamento; a lista de lançamentos continua nas tabelas (protegidas).
    const { payments, movements, ...snapshot } = summary;
    const stored = { ...snapshot, counted, differences, paymentCount: payments.length, movementCount: movements.length };
    const { rows } = await db.query(`UPDATE cash_sessions SET status='closed', closed_at=$1, closed_by=$2, closed_by_name=$3, closing_note=$4,
        counted_cash_cents=$5, counted_pix_cents=$6, counted_debit_cents=$7, counted_credit_cents=$8, summary=$9 WHERE id=$10 RETURNING *`,
    [closedAt, req.user.id, req.user.name, input.note, counted.cash, counted.pix, counted.debit, counted.credit, JSON.stringify(stored), session.id]);
    await audit(db, req.user, 'cash.close', 'cash_session', session.id, { counted, differences });
    return rows[0];
  });
  publish('cash', {});
  res.json({ session: serializeSession(closed), summary: closed.summary });
}));

router.get('/cash/sessions', auth('finance.view'), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT s.*, (SELECT COALESCE(SUM(amount_cents),0)::int FROM cash_adjustments a WHERE a.session_id=s.id) AS adjustments_cents
    FROM cash_sessions s ORDER BY s.opened_at DESC LIMIT 200`);
  res.json(rows.map((s) => ({ ...serializeSession(s), summary: s.summary, adjustments: toMoney(s.adjustments_cents) })));
}));

router.get('/cash/sessions/:id', auth('finance.view'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const found = await pool.query('SELECT * FROM cash_sessions WHERE id=$1', [id]);
  if (!found.rowCount) return fail(res, 404, 'Caixa não encontrado.');
  const session = found.rows[0];
  const live = await computeSessionSummary(pool, session);
  const adjustments = await pool.query('SELECT * FROM cash_adjustments WHERE session_id=$1 ORDER BY created_at', [id]);
  res.json({
    session: serializeSession(session),
    // Caixa fechado: valores oficiais vêm da fotografia salva no fechamento.
    summary: session.status === 'closed' ? { ...session.summary, payments: live.payments, movements: live.movements } : live,
    adjustments: adjustments.rows.map((a) => ({ id: a.id, method: a.method, amount: toMoney(a.amount_cents), reason: a.reason, createdBy: a.created_by_name, createdAt: a.created_at }))
  });
}));

router.post('/cash/sessions/:id/adjustments', auth('finance.adjust'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const input = parse(z.object({
    method: z.enum(PAYMENT_METHODS).nullable().default(null),
    amount: z.number().refine((value) => value !== 0, 'O ajuste não pode ser zero.').refine((value) => Math.abs(value) <= 100000, 'Valor muito alto.'),
    reason: z.string().trim().min(10, 'Justifique o ajuste com pelo menos 10 caracteres.').max(500)
  }), req.body);
  await withTransaction(pool, async (db) => {
    const found = await db.query('SELECT status FROM cash_sessions WHERE id=$1', [id]);
    if (!found.rowCount) throw new HttpError(404, 'Caixa não encontrado.');
    if (found.rows[0].status !== 'closed') throw new HttpError(409, 'Ajustes são usados apenas em caixas fechados. Com o caixa aberto, registre a operação normalmente.');
    await db.query('INSERT INTO cash_adjustments(session_id,method,amount_cents,reason,created_by,created_by_name) VALUES($1,$2,$3,$4,$5,$6)',
      [id, input.method, toCents(input.amount), input.reason, req.user.id, req.user.name]);
    await audit(db, req.user, 'cash.adjustment', 'cash_session', id, input);
  });
  publish('cash', {});
  res.status(201).json({ ok: true });
}));

router.get('/cash/sessions/:id/export.csv', auth('finance.view'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const found = await pool.query('SELECT * FROM cash_sessions WHERE id=$1', [id]);
  if (!found.rowCount) return fail(res, 404, 'Caixa não encontrado.');
  const summary = await computeSessionSummary(pool, found.rows[0]);
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const fmt = (value) => Number(value).toFixed(2).replace('.', ',');
  const date = (value) => new Date(value).toLocaleString('pt-BR', { timeZone: TIMEZONE });
  const lines = [
    ['Data', 'Tipo', 'Forma', 'Pedido', 'Senha', 'Comprador', 'Valor', 'Troco', 'Situação', 'Responsável', 'Observação'],
    ...summary.payments.map((p) => [date(p.createdAt), p.kind === 'payment' ? 'Recebimento' : 'Estorno', PAYMENT_METHOD_LABELS[p.method], p.orderNumber, p.ticket,
      p.buyerName, fmt(p.amount), p.change == null ? '' : fmt(p.change), p.status === 'confirmed' ? 'Confirmado' : `Anulado: ${p.voidReason}`, p.createdBy, p.note]),
    ...summary.movements.map((m) => [date(m.createdAt), m.type === 'withdrawal' ? 'Sangria' : 'Suprimento', 'Dinheiro', '', '', '', fmt(m.amount), '', 'Confirmado', m.createdBy, m.reason])
  ].map((row) => row.map(escape).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="caixa-${id}.csv"`);
  res.send(`﻿${lines.join('\n')}`);
}));

export default router;
