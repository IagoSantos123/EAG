// Criação de pedidos, compartilhada entre o site (comprador) e a venda no balcão (equipe).
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { HttpError, toCents, toMoney } from './http.js';
import { localDate, TIMEZONE } from './time.js';
import { PAYMENT_METHODS, SERVICE_TYPES, priceItem, addHistory } from './orders.js';
import { mercadoPagoEnabled } from './mercadopago.js';

const optionalId = z.preprocess((value) => (value === '' || value == null ? null : Number(value)), z.number().int().positive().nullable());
const phoneDigits = (value) => value.replace(/\D/g, '');
const validPhone = (value) => { const d = phoneDigits(value); return d.length >= 10 && d.length <= 13; };

const baseFields = {
  clientRequestId: z.string().uuid().optional(),
  buyerName: z.string().trim().min(2, 'Informe o nome do cliente.').max(120, 'Nome muito longo.'),
  teamId: optionalId.default(null),
  mode: z.enum(['religious', 'snack']),
  serviceType: z.enum(SERVICE_TYPES, { errorMap: () => ({ message: 'Escolha a modalidade de atendimento.' }) }),
  tableNumber: z.string().trim().max(10, 'Número de mesa inválido.').default(''),
  deliveryAddress: z.string().trim().max(300, 'Endereço muito longo.').default(''),
  deliveryReference: z.string().trim().max(200, 'Referência muito longa.').default(''),
  deliveryNote: z.string().trim().max(300, 'Observação de entrega muito longa.').default(''),
  cashChangeFor: z.number().min(0).max(10000).nullable().default(null),
  items: z.array(z.object({
    productId: z.coerce.number().int().positive(),
    // Catálogo do item (balcão): uma comanda pode ter lanchonete e artigos juntos.
    mode: z.enum(['religious', 'snack']).optional(),
    // Preço da unidade ajustado na comanda (promoção, valor especial). Só vale em vendas da equipe.
    priceOverride: z.number().min(0, 'Preço inválido.').max(10000, 'Preço inválido.').nullable().optional(),
    quantity: z.number().int().min(1).max(30, 'Quantidade máxima por item: 30.'),
    selectedOptions: z.array(z.object({ group: z.string().max(80), option: z.string().max(80) })).max(40).default([]),
    note: z.string().max(300, 'Observação muito longa (máximo 300 caracteres).').default(''),
    customText: z.string().max(120, 'Personalização muito longa.').default('')
  })).min(1, 'A sacola está vazia.').max(40, 'Pedido com itens demais.')
};

// Site: telefone obrigatório (para entregar e avisar o comprador).
export const publicOrderSchema = z.object({
  ...baseFields,
  buyerName: z.string().trim().min(3, 'Informe seu nome completo.').max(120, 'Nome muito longo.'),
  buyerPhone: z.string().trim().max(30).refine(validPhone, 'Informe um telefone válido com DDD.'),
  paymentMethod: z.enum([...PAYMENT_METHODS, 'fiado'], { errorMap: () => ({ message: 'Escolha a forma de pagamento.' }) })
});

// Balcão: telefone opcional, exceto para fiado e delivery (validado em validateOrder).
export const staffOrderSchema = z.object({
  ...baseFields,
  buyerPhone: z.string().trim().max(30).default('').refine((value) => !value || validPhone(value), 'Telefone inválido: informe com DDD.')
});

export function availableServices(mode, settings) {
  const service = settings.service || {};
  return SERVICE_TYPES.filter((type) => service[type] && !(mode === 'religious' && type === 'dine_in'));
}

export function enabledPaymentMethods(settings) {
  const methods = settings.payment_methods || {};
  return [...(settings.pix?.key || mercadoPagoEnabled() ? ['pix'] : []), ...(methods.cash ? ['cash'] : []), ...(methods.debit ? ['debit'] : []), ...(methods.credit ? ['credit'] : [])];
}

// Regras de atendimento comuns. `staff` relaxa apenas o que a equipe precisa (ex.: modalidade desativada no site).
export function validateOrder(input, settings, { staff = false } = {}) {
  const services = staff ? SERVICE_TYPES.filter((type) => !(input.mode === 'religious' && type === 'dine_in')) : availableServices(input.mode, settings);
  if (!services.includes(input.serviceType)) throw new HttpError(400, 'Modalidade de atendimento indisponível.');
  let deliveryFeeCents = 0;
  if (input.serviceType === 'delivery') {
    if (input.deliveryAddress.length < 5) throw new HttpError(400, 'Informe o endereço de entrega.');
    if (!input.buyerPhone) throw new HttpError(400, 'Para delivery, informe o telefone do cliente.');
    deliveryFeeCents = Math.max(0, Number(settings.service?.delivery_fee_cents || 0));
  }
  let tableNumber = '';
  if (input.serviceType === 'dine_in') {
    tableNumber = input.tableNumber || '';
    if (settings.service?.tables_enabled) {
      if (!tableNumber && !staff) throw new HttpError(400, 'Informe o número da mesa.');
      const count = Number(settings.service?.table_count || 0);
      if (tableNumber && count > 0) {
        const table = Number(tableNumber);
        if (!Number.isInteger(table) || table < 1 || table > count) throw new HttpError(400, `Mesa inválida. Escolha de 1 a ${count}.`);
      }
    }
  }
  return { deliveryFeeCents, tableNumber };
}

// Insere o pedido (preço sempre recalculado pelo cadastro). Deve rodar dentro de transação.
export async function insertOrder(db, input, settings, { paymentMethod, onCredit = false, actor, deliveryFeeCents, tableNumber, ticket: fixedTicket }) {
  let teamName = 'Sem equipe';
  if (input.teamId) {
    const team = await db.query('SELECT name FROM teams WHERE id=$1 AND active=TRUE', [input.teamId]);
    if (!team.rowCount) throw new HttpError(400, 'Equipe indisponível.');
    teamName = team.rows[0].name;
  }
  const snapshot = [];
  let subtotal = 0;
  for (const item of input.items) {
    const found = await db.query(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id
      WHERE p.id=$1 AND p.mode=$2 AND p.available=TRUE AND p.archived=FALSE FOR UPDATE OF p`, [item.productId, input.mode]);
    if (!found.rowCount) throw new HttpError(400, 'Um dos itens não está mais disponível. Atualize a sacola.');
    const product = found.rows[0];
    if (product.stock !== null && product.stock < item.quantity) throw new HttpError(409, `${product.name}: estoque insuficiente (restam ${product.stock}).`);
    const priced = priceItem(product, item);
    if (actor && item.priceOverride != null && toCents(item.priceOverride) !== priced.unitCents) {
      priced.priceAdjustedFromCents = priced.unitCents;
      priced.unitCents = toCents(item.priceOverride);
      priced.totalCents = priced.unitCents * priced.quantity;
    }
    subtotal += priced.totalCents;
    snapshot.push(priced);
    if (product.stock !== null) await db.query('UPDATE products SET stock=stock-$1,updated_at=NOW() WHERE id=$2', [item.quantity, product.id]);
  }
  const total = subtotal + deliveryFeeCents;
  let cashChangeFor = null;
  if (paymentMethod === 'cash' && input.cashChangeFor) {
    cashChangeFor = toCents(input.cashChangeFor);
    if (cashChangeFor < total) throw new HttpError(400, `O valor para troco deve ser maior ou igual ao total (${toMoney(total).toFixed(2).replace('.', ',')}).`);
  }
  // Senha curta do dia, sequencial, para chamar o cliente no balcão.
  await db.query('SELECT pg_advisory_xact_lock(727002)');
  // Comanda mista: a parte dos artigos usa a mesma senha da parte da lanchonete.
  const ticket = fixedTicket ? { rows: [{ next: fixedTicket }] } : await db.query(`SELECT COALESCE(MAX(ticket_number),0)+1 AS next FROM orders
    WHERE (created_at AT TIME ZONE $1)::date = (NOW() AT TIME ZONE $1)::date`, [TIMEZONE]);
  const orderNumber = `AG-${localDate().slice(2).replaceAll('-', '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const publicToken = randomBytes(24).toString('base64url');
  const deadline = Math.min(120, Math.max(5, Number(settings.payment_deadline_minutes || 15)));
  const delivery = input.serviceType === 'delivery';
  const { rows } = await db.query(`INSERT INTO orders(order_number,public_token,buyer_name,buyer_phone,team_id,team_name,mode,items,
      subtotal_cents,total_cents,delivery_fee_cents,expires_at,status,payment_status,production_status,service_type,payment_method,
      delivery_address,delivery_reference,delivery_note,table_number,cash_change_for_cents,ticket_number,client_request_id,
      on_credit,credit_at,credit_by_name,source)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $12='pix' AND $22='site' THEN NOW()+($13 * INTERVAL '1 minute') END,'active','awaiting_payment','new',
      $14,$12,$15,$16,$17,$18,$19,$20,$21,$23,CASE WHEN $23 THEN NOW() END,CASE WHEN $23 THEN $24 END,$22) RETURNING *`,
  [orderNumber, publicToken, input.buyerName, input.buyerPhone || '', input.teamId, teamName, input.mode, JSON.stringify(snapshot),
    subtotal, total, deliveryFeeCents, paymentMethod, deadline, input.serviceType,
    delivery ? input.deliveryAddress : '', delivery ? input.deliveryReference : '', delivery ? input.deliveryNote : '',
    tableNumber, cashChangeFor, ticket.rows[0].next, input.clientRequestId || null, actor ? 'balcao' : 'site', onCredit, actor?.name || 'Comprador']);
  let order = rows[0];
  await addHistory(db, { orderId: order.id, kind: 'order', status: 'created', note: actor ? 'Venda registrada no balcão' : 'Pedido criado pelo site', actor: actor || { name: 'Comprador' } });
  const adjusted = snapshot.filter((item) => item.priceAdjustedFromCents != null);
  if (adjusted.length) {
    const money = (cents) => toMoney(cents).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    await addHistory(db, { orderId: order.id, kind: 'order', status: 'price_adjusted', actor,
      note: `Preço ajustado na comanda: ${adjusted.map((item) => `${item.name} ${money(item.priceAdjustedFromCents)} → ${money(item.unitCents)}`).join('; ')}` });
  }
  // Lanchonete só com itens do balcão (salgado, café, bebida...): não passa pela cozinha, já nasce pronto para entregar.
  if (input.mode === 'snack' && snapshot.every((item) => item.kitchen === false)) {
    order = (await db.query("UPDATE orders SET production_status='ready', ready_at=NOW() WHERE id=$1 RETURNING *", [order.id])).rows[0];
    await addHistory(db, { orderId: order.id, kind: 'production', status: 'ready', fromStatus: 'new', note: 'Pronto no balcão (sem itens de cozinha)', actor: actor || { name: 'Sistema' } });
  }
  if (onCredit) await addHistory(db, { orderId: order.id, kind: 'payment', status: 'credit', note: 'Lançado como fiado', actor: actor || { name: 'Comprador' } });
  return order;
}
