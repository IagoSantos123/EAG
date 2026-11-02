// Modo de teste: copia o banco do evento (.dados-local) para .dados-teste e roda o sistema nessa cópia,
// na porta 3002, sem tocar nos dados reais. Cada vez que liga, recomeça de uma cópia nova.
// Uso: npm run local-teste (na raiz) ou iniciar-teste.bat. Login: o mesmo do sistema local.
import { cpSync, existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const real = path.join(root, '.dados-local');
const copy = path.join(root, '.dados-teste');

// Copiar com o banco do evento ligado pode gerar uma cópia inconsistente: pede para fechar antes.
const busy = await new Promise((resolve) => {
  const socket = net.connect(5442, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
if (busy) {
  console.error('O sistema do evento está aberto. Feche a janela dele (Ctrl+C) e rode o modo de teste de novo.');
  process.exit(1);
}
if (!existsSync(path.join(real, 'postgres', 'PG_VERSION'))) {
  console.error('Ainda não existe banco do evento para copiar. Rode o iniciar-local.bat uma vez antes.');
  process.exit(1);
}

console.log('Copiando o banco do evento para o modo de teste...');
rmSync(copy, { recursive: true, force: true });
cpSync(real, copy, { recursive: true });
rmSync(path.join(copy, 'postgres', 'postmaster.pid'), { force: true });

process.env.LOCAL_DATA_DIR = copy;
process.env.LOCAL_PG_PORT = '5443';
process.env.PORT = '3002';
console.log('\n  MODO DE TESTE: o que fizer aqui não vai para o banco do evento.\n');
await import('./local.js');
