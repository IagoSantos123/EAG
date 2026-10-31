// Servidor local/tradicional (na Vercel, o app é usado por api/index.js).
import os from 'node:os';
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

// Endereços desta máquina na rede local: são os que os outros aparelhos abrem no navegador.
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => `http://${net.address}:${port}`);
}

app.listen(port, '0.0.0.0', () => {
  console.log(`API EAG disponível na porta ${port}`);
  if (process.env.SERVE_CLIENT === '1') {
    const lan = lanAddresses();
    console.log('\n  Sistema EAG rodando. NÃO feche esta janela durante o evento.\n');
    console.log(`  Neste notebook:    http://localhost:${port}`);
    if (lan.length) lan.forEach((url) => console.log(`  Nos outros aparelhos (mesma rede Wi-Fi): ${url}`));
    else console.log('  Sem rede: conecte este notebook ao Wi-Fi (ex.: roteador do celular) e reinicie para ver o endereço.');
    console.log(`  Painel da TV:      http://localhost:${port}/#/painel\n`);
  }
});
