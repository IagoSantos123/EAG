// Regras de negócio dos pedidos: preço, etapas de produção, pagamentos e histórico.
// Todas as funções que recebem `db` devem ser chamadas dentro de uma transação.
import { HttpError, toMoney } from './http.js';

export const PRODUCTION_FLOW = ['new', 'in_production', 'ready', 'awaiting_pickup', 'finalized'];
export const PRODUCTION_LABELS = {
  new: 'Novo pedido', in_production: 'Em produção', ready: 'Pronto', awaiting_pickup: 'Aguardando retirada', finalized: 'Finalizado'
};
export const PRODUCTION_TIMESTAMP = {
  in_production: 'production_started_at', ready: 'ready_at', awaiting_pickup: 'awaiting_pickup_at', finalized: 'finalized_at'
};
export const PAYMENT_METHODS = ['pix', 'cash', 'debit', 'credit'];
export const PAYMENT_METHOD_LABELS = { pix: 'PIX', cash: 'Dinheiro', debit: 'Cartão de débito', credit: 'Cartão de crédito', fiado: 'Fiado' };
export const SERVICE_TYPES = ['dine_in', 'delivery', 'pickup'];
export const SERVICE_LABELS = { dine_in: 'Consumo no salão', delivery: 'Delivery', pickup: 'Retirada no balcão' };

// Quem pode fazer cada passo de produção (avançar para a etapa indicada).
const FORWARD_ROLES = {
  in_production: ['admin', 'kitchen'],
  ready: ['admin', 'kitchen'],
  awaiting_pickup: ['admin', 'kitchen', 'operator'],
  finalized: ['admin', 'kitchen', 'operator']
};
// Correções (voltar uma etapa) exigem justificativa. Reabrir um pedido finalizado só o administrador.
const BACKWARD_ROLES = { default: ['admin', 'kitchen'], finalized: ['admin'] };

// ---------- Preço ----------

export const optionExtraCents = (option) => {
  if (Number.isInteger(option.extraCents)) return option.extraCents;
  return Math.round(Number(option.extra || 0) * 100);
};

// Recalcula o item com base no cadastro atual (nunca confia em preço vindo do navegador).
export function priceItem(product, item) {
  const groups = Array.isArray(product.option_groups) ? product.option_groups : [];
  const chosenAll = item.selectedOptions || [];
  if (chosenAll.some((choice) => !groups.some((group) => group.name === choice.group))) {
    throw new HttpError(400, `Opção inválida em ${product.name}.`);
  }
  let optionsTotal = 0;
  const selected = [];
  for (const group of groups) {
    const chosen = chosenAll.filter((choice) => choice.group === group.name);
    const names = chosen.map((choice) => choice.option);
    if (new Set(names).size !== names.length) throw new HttpError(400, `Opção repetida em ${product.name} (${group.name}).`);
    const min = Number(group.min ?? (group.required ? 1 : 0));
    const max = Number(group.max ?? 1);
    if (chosen.length < min || chosen.length > max) {
      throw new HttpError(400, `Selecione as opções corretamente em ${product.name} (${group.name}).`);
    }
    for (const choice of chosen) {
      const option = (group.options || []).find((candidate) => candidate.name === choice.option && candidate.available !== false);
      if (!option) throw new HttpError(400, `A opção "${choice.option}" de ${product.name} não está disponível.`);
      const extraCents = optionExtraCents(option);
      optionsTotal += extraCents;
      selected.push({ group: group.name, option: option.name, extraCents });
    }
  }
  const customText = (item.customText || '').trim();
  if (product.custom_text_label && product.custom_text_required && !customText) {
    throw new HttpError(400, `Preencha "${product.custom_text_label}" em ${product.name}.`);
  }
  const unitCents = Number(product.price_cents) + optionsTotal;
  return {
    productId: Number(product.id),
    name: product.name,
    categoryId: product.category_id ? Number(product.category_id) : null,
    category: product.category_name || '',
    baseCents: Number(product.price_cents),
    unitCents,
    quantity: item.quantity,
    totalCents: unitCents * item.quantity,
    options: selected,
    note: product.allow_notes === false ? '' : (item.note || '').trim(),
    customText: product.custom_text_label ? customText : '',
    customTextLabel: product.custom_text_label || '',
    prepMinutes: product.prep_minutes ?? null
  };
}

// ---------- Histórico ----------

export async function addHistory(db, { orderId, kind = 'order', status, fromStatus = null, note = '', actor }) {
  await db.query(
    'INSERT INTO order_history(order_id,kind,status,from_status,note,actor,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [orderId, kind, status, fromStatus, note, actor?.name || 'Sistema', actor?.id || null]
  );
}

export async function audit(db, actor, action, entity, entityId, details = {}) {
  await db.query('INSERT INTO audit_log(actor_id,actor_name,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',
    [actor?.id || null, actor?.name || 'Sistema', action, entity, entityId == null ? null : String(entityId), JSON.stringify(details)]);
}

// ---------- Pagamento ----------

// Recalcula paid_cents/refunded_cents/payment_status a partir dos registros de pagamento.
// É a única forma de alterar o status financeiro do pedido.
export async function recomputePayment(db, orderId) {
  const { rows } = await db.query(`SELECT
      COALESCE(SUM(amount_cents) FILTER (WHERE kind='payment' AND status='confirmed'),0) AS paid,
      COALESCE(SUM(amount_cents) FILTER (WHERE kind='refund' AND status='confirmed'),0) AS refunded
    FROM payments WHERE order_id=$1`, [orderId]);
  const order = (await db.query('SELECT total_cents,payment_claimed_at FROM orders WHERE id=$1', [orderId])).rows[0];
  const paid = Number(rows[0].paid);
  const refunded = Number(rows[0].refunded);
  const net = paid - refunded;
  let status;
  if (refunded > 0 && net <= 0) status = 'refunded';
  else if (net >= order.total_cents && order.total_cents > 0) status = 'confirmed';
  else if (net > 0) status = 'partial';
  else if (order.payment_claimed_at) status = 'pending_review';
  else status = 'awaiting_payment';
  await db.query(`UPDATE orders SET paid_cents=$1, refunded_cents=$2, payment_status=$3,
      paid_at=CASE WHEN $3='confirmed' THEN COALESCE(paid_at,NOW()) ELSE NULL END, updated_at=NOW() WHERE id=$4`,
    [paid, refunded, status, orderId]);
  return { paid, refunded, net, status };
}

export async function getOpenSession(db, { lock = false } = {}) {
  const { rows } = await db.query(`SELECT * FROM cash_sessions WHERE status='open' ${lock ? 'FOR SHARE' : ''}`);
  return rows[0] || null;
}

export async function requireOpenSession(db) {
  const session = await getOpenSession(db, { lock: true });
  if (!session) throw new HttpError(409, 'Nenhum caixa aberto. Abra o caixa no Financeiro antes de registrar valores.', 'NO_CASH_SESSION');
  return session;
}

// ---------- Estoque ----------

// Devolve ao estoque os itens de um pedido cancelado/expirado (apenas uma vez).
export async function restock(db, order) {
  if (order.restocked) return;
  for (const item of order.items || []) {
    if (!item.productId) continue;
    await db.query('UPDATE products SET stock=stock+$1, updated_at=NOW() WHERE id=$2 AND stock IS NOT NULL', [item.quantity, item.productId]);
  }
  await db.query('UPDATE orders SET restocked=TRUE WHERE id=$1', [order.id]);
}

// ---------- Produção ----------

export function checkTransition(order, target, role, { reason, acknowledgeUnpaid, settings }) {
  if (order.status !== 'active') {
    throw new HttpError(409, order.status === 'cancelled' ? 'Pedido cancelado não pode ser movimentado.' : 'Pedido expirado: o pagamento precisa ser regularizado no Financeiro.');
  }
  const from = PRODUCTION_FLOW.indexOf(order.production_status);
  const to = PRODUCTION_FLOW.indexOf(target);
  if (to < 0) throw new HttpError(400, 'Etapa inválida.');
  if (to === from + 1) {
    if (!FORWARD_ROLES[target].includes(role)) throw new HttpError(403, 'Seu perfil não pode mover o pedido para esta etapa.');
    if (target === 'in_production' && order.payment_method === 'pix' && !order.on_credit && settings.kitchen?.require_pix_confirmation !== false && order.payment_status !== 'confirmed') {
      throw new HttpError(409, 'Aguardando a confirmação do PIX pelo financeiro antes de iniciar a produção.', 'PAYMENT_REQUIRED');
    }
    if (target === 'finalized' && order.payment_status !== 'confirmed' && !order.on_credit && !acknowledgeUnpaid) {
      throw new HttpError(409, 'Este pedido ainda não tem pagamento confirmado. Confirme para finalizar mesmo assim.', 'UNPAID');
    }
    return 'forward';
  }
  if (to === from - 1) {
    const roles = order.production_status === 'finalized' ? BACKWARD_ROLES.finalized : BACKWARD_ROLES.default;
    if (!roles.includes(role)) throw new HttpError(403, 'Seu perfil não pode desfazer esta etapa.');
    if (!reason || reason.trim().length < 3) throw new HttpError(400, 'Informe o motivo da correção.');
    return 'backward';
  }
  throw new HttpError(409, 'Movimentação inválida: o pedido só pode avançar ou voltar uma etapa por vez.');
}

// ---------- Serialização ----------

export function balanceCents(order) {
  return Math.max(0, Number(order.total_cents) - (Number(order.paid_cents || 0) - Number(order.refunded_cents || 0)));
}

export function serializeItems(items) {
  return (items || []).map((item) => ({
    productId: item.productId,
    name: item.name,
    quantity: item.quantity,
    unitPrice: toMoney(item.unitCents),
    total: toMoney(item.totalCents ?? item.unitCents * item.quantity),
    options: (item.options || []).map((option) => ({ group: option.group, option: option.option, extra: toMoney(option.extraCents) })),
    note: item.note || '',
    customText: item.customText || '',
    customTextLabel: item.customTextLabel || ''
  }));
}

// Visão interna completa do pedido (painel, cozinha, financeiro).
export function serializeOrder(row) {
  return {
    id: Number(row.id),
    orderNumber: row.order_number,
    ticket: row.ticket_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    buyerName: row.buyer_name,
    buyerPhone: row.buyer_phone,
    teamName: row.team_name,
    mode: row.mode,
    serviceType: row.service_type,
    tableNumber: row.table_number,
    deliveryAddress: row.delivery_address,
    deliveryReference: row.delivery_reference,
    deliveryNote: row.delivery_note,
    items: serializeItems(row.items),
    subtotal: toMoney(row.subtotal_cents),
    deliveryFee: toMoney(row.delivery_fee_cents),
    total: toMoney(row.total_cents),
    paid: toMoney(Number(row.paid_cents || 0) - Number(row.refunded_cents || 0)),
    balance: toMoney(balanceCents(row)),
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    onCredit: Boolean(row.on_credit),
    creditAt: row.credit_at,
    creditBy: row.credit_by_name,
    creditNote: row.credit_note,
    source: row.source,
    paymentClaimedAt: row.payment_claimed_at,
    cashChangeFor: row.cash_change_for_cents == null ? null : toMoney(row.cash_change_for_cents),
    status: row.status,
    productionStatus: row.production_status,
    productionStartedAt: row.production_started_at,
    readyAt: row.ready_at,
    awaitingPickupAt: row.awaiting_pickup_at,
    finalizedAt: row.finalized_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    expiresAt: row.expires_at,
    decisionNote: row.decision_note
  };
}
