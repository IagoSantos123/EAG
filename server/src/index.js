// Servidor local/tradicional (na Vercel, o app é usado por api/index.js).
import app, { ready } from './app.js';
import { pool } from './db.js';
import { expireDueOrders } from './lib/expiry.js';

const port = Number(process.env.PORT || 3001);
await ready;
const expirySweep = setInterval(async () => {
  try { await expireDueOrders(pool); }
  catch (error) { console.error('Falha ao atualizar pedidos expirados:', error.message); }
}, 30_000);
expirySweep.unref();
app.listen(port, () => console.log(`API EAG disponível na porta ${port}`));
