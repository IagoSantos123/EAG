// Registro de recebimentos e fiado. Funções para uso dentro de transação.
import { z } from 'zod';
import { HttpError, toCents, toMoney } from './http.js';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, addHistory, recomputePayment, requireOpenSession, balanceCents } from './orders.js';
import { can } from './auth.js';

const money = (cents) => toMoney(cents).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// 'fiado' pode ser uma das linhas: a parte anotada para pagar depois (não é recebimento).
export const paymentLinesSchema = z.array(z.object({
  method: z.enum([...PAYMENT_METHODS, 'fiado']),
  amount: z.number().positive('Informe valores maiores que zero.').max(100000),
  tendered: z.number().min(0).max(100000).nullable().optional()
})).min(1, 'Informe ao menos uma forma de pagamento.').max(4, 'Use no máximo 4 formas de pagamento.');

export function enabledForRegister(settings) {
  return { pix: true, cash: Boolean(settings.payment_methods?.cash), debit: Boolean(settings.payment_methods?.debit), credit: Boolean(settings.payment_methods?.credit) };
}

// Registra o valor em aberto em uma ou mais formas. A soma precisa fechar exatamente o saldo.
export async function registerPayments(db, { orderId, lines, note = '', idempotencyKey, actor, settings }) {
  const creditLines = lines.filter((line) => line.method === 'fiado');
  const realLines = lines.filter((line) => line.method !== 'fiado');
  if (creditLines.length > 1) throw new HttpError(400, 'Use o fiado uma única vez.');
  if (creditLines.length && !can(actor.role, 'credits.manage')) throw new HttpError(403, 'Seu perfil não pode lançar fiado.');
  if (realLines.length) {
    const duplicate = await db.query('SELECT 1 FROM payments WHERE idempotency_key=$1', [`${idempotencyKey}:0`]);
    if (duplicate.rowCount) return { duplicate: true };
  }
  // Só exige caixa aberto quando há dinheiro entrando (fiado puro não movimenta o caixa).
  const session = realLines.length ? await requireOpenSession(db) : null;
  const found = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
  if (!found.rowCount) throw new HttpError(404, 'Pedido não encontrado.');
  const order = found.rows[0];
  if (order.status === 'cancelled') throw new HttpError(409, 'Pedido cancelado não recebe pagamentos.');
  const balance = balanceCents(order);
  if (balance <= 0) throw new HttpError(409, 'Este pedido já está totalmente pago.');
  const enabled = enabledForRegister(settings);
  const parsed = realLines.map((line) => ({ ...line, cents: toCents(line.amount), tenderedCents: line.tendered == null ? null : toCents(line.tendered) }));
  const creditCents = creditLines.length ? toCents(creditLines[0].amount) : 0;
  if (new Set(parsed.map((line) => line.method)).size !== parsed.length) throw new HttpError(400, 'Use cada forma de pagamento uma única vez.');
  for (const line of parsed) {
    if (!enabled[line.method]) throw new HttpError(400, `${PAYMENT_METHOD_LABELS[line.method]} está desabilitado nas configurações.`);
    if (line.cents <= 0) throw new HttpError(400, 'Informe valores maiores que zero.');
    if (line.method === 'cash' && line.tenderedCents != null && line.tenderedCents < line.cents) throw new HttpError(400, 'O valor entregue em dinheiro é menor que o valor a receber.');
  }
  if (creditLines.length && creditCents <= 0) throw new HttpError(400, 'Informe o valor do fiado.');
  const sum = parsed.reduce((total, line) => total + line.cents, 0) + creditCents;
  if (sum !== balance) throw new HttpError(400, `A soma dos valores (${money(sum)}) deve ser igual ao valor em aberto (${money(balance)}).`);
  for (const [index, line] of parsed.entries()) {
    const tendered = line.method === 'cash' ? line.tenderedCents : null;
    await db.query(`INSERT INTO payments(order_id,session_id,kind,method,amount_cents,tendered_cents,change_cents,note,idempotency_key,created_by,created_by_name)
      VALUES($1,$2,'payment',$3,$4,$5,$6,$7,$8,$9,$10)`,
    [orderId, session.id, line.method, line.cents, tendered, tendered == null ? null : tendered - line.cents, note, `${idempotencyKey}:${index}`, actor.id, actor.name]);
  }
  if (parsed.length) {
    const description = parsed.map((line) => `${PAYMENT_METHOD_LABELS[line.method]} ${money(line.cents)}`).join(' + ');
    await addHistory(db, { orderId, kind: 'payment', status: 'confirmed', note: `${order.on_credit ? 'Baixa de fiado' : 'Recebimento registrado'}: ${description}${creditCents ? ` (fica no fiado: ${money(creditCents)})` : ''}`, actor });
  }
  await reactivateExpired(db, order, actor);
  const payment = await recomputePayment(db, orderId);
  // A parte restante vai para o fiado (exige nome e telefone do cliente).
  if (creditCents) await markCredit(db, { orderId, actor, note: parsed.length ? 'Pagamento dividido: parte paga, restante no fiado' : '' });
  const change = parsed.reduce((total, line) => total + (line.method === 'cash' && line.tenderedCents != null ? line.tenderedCents - line.cents : 0), 0);
  return { payment, change, credit: creditCents };
}

// Pagamento confirmado depois do prazo: o pedido expirado volta a valer e os itens saem de novo do estoque.
export async function reactivateExpired(db, order, actor) {
  if (order.status !== 'expired') return;
  await db.query("UPDATE orders SET status='active', updated_at=NOW() WHERE id=$1", [order.id]);
  await addHistory(db, { orderId: order.id, kind: 'order', status: 'reactivated', fromStatus: 'expired', note: 'Pedido reativado após confirmação do pagamento', actor });
  if (order.restocked) {
    for (const item of order.items || []) {
      await db.query('UPDATE products SET stock=GREATEST(stock-$1,0), updated_at=NOW() WHERE id=$2 AND stock IS NOT NULL', [item.quantity, item.productId]);
    }
    await db.query('UPDATE orders SET restocked=FALSE WHERE id=$1', [order.id]);
  }
}

// Lança o saldo em aberto como fiado (a receber), identificando quem autorizou.
export async function markCredit(db, { orderId, actor, note = '' }) {
  const found = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
  if (!found.rowCount) throw new HttpError(404, 'Pedido não encontrado.');
  const order = found.rows[0];
  if (order.status !== 'active') throw new HttpError(409, 'Somente pedidos ativos podem ir para o fiado.');
  if (balanceCents(order) <= 0) throw new HttpError(409, 'Este pedido já está pago.');
  if (order.on_credit) return order;
  if (!order.buyer_name || order.buyer_phone.replace(/\D/g, '').length < 10) {
    throw new HttpError(400, 'Para lançar no fiado, o pedido precisa ter nome e telefone do cliente. Edite os dados do cliente primeiro.', 'CREDIT_NEEDS_CONTACT');
  }
  await db.query('UPDATE orders SET on_credit=TRUE, credit_at=NOW(), credit_by_name=$1, credit_note=$2, updated_at=NOW() WHERE id=$3', [actor.name, note, orderId]);
  await addHistory(db, { orderId, kind: 'payment', status: 'credit', note: `Lançado como fiado: ${money(balanceCents(order))}${note ? ` — ${note}` : ''}`, actor });
  return order;
}
