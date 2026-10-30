// Expiração de pedidos PIX não pagos dentro do prazo.
import { withTransaction } from './http.js';
import { addHistory, restock } from './orders.js';
import { publish } from './events.js';

// Só expira pedidos PIX sem pagamento, sem solicitação de conferência e que ainda não entraram em produção.
const DUE = `status='active' AND payment_method='pix' AND payment_status='awaiting_payment' AND paid_cents=0
  AND production_status='new' AND expires_at IS NOT NULL AND expires_at<=NOW()`;

export async function expireDueOrders(pool, { orderId } = {}) {
  const expired = await withTransaction(pool, async (db) => {
    const params = [];
    let filter = '';
    if (orderId) { params.push(orderId); filter = 'AND id=$1'; }
    const { rows } = await db.query(`SELECT id,items,restocked FROM orders WHERE ${DUE} ${filter} ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`, params);
    for (const order of rows) {
      await db.query("UPDATE orders SET status='expired', updated_at=NOW() WHERE id=$1", [order.id]);
      await restock(db, order);
      await addHistory(db, { orderId: order.id, kind: 'order', status: 'expired', note: 'Prazo do PIX encerrado sem pagamento.' });
    }
    return rows.map((row) => row.id);
  });
  for (const id of expired) publish('order', { orderId: id });
  return expired.length;
}
