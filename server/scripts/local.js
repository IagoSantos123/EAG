// Modo local do evento: sobe um PostgreSQL embutido nesta máquina e o sistema completo (API + telas),
// para os aparelhos da sala usarem pela rede Wi-Fi, sem depender da internet.
// Uso: npm run local (na raiz do projeto) ou iniciar-local.bat.
import { loadLocalEnv, persistedSecret, localDatabaseUrl, startLocalDatabase } from './banco-local.js';

loadLocalEnv();
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = persistedSecret('jwt.txt', 32);

let stopDatabase;
try {
  stopDatabase = await startLocalDatabase();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\nEncerrando o banco local...');
  await stopDatabase();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// No Windows, fechar a janela no X chega como SIGHUP.
process.on('SIGHUP', shutdown);

// Valores do modo local têm prioridade sobre um server/.env da nuvem (o dotenv não sobrescreve o que já existe).
process.env.DATABASE_URL = localDatabaseUrl();
process.env.DATABASE_URL_UNPOOLED = '';
process.env.SERVE_CLIENT = '1';
process.env.PORT ||= '3001';
// Sem internet não há PIX automático: o site usa a chave PIX fixa (defina MP_ACCESS_TOKEN no .env.local para ativar).
process.env.MP_ACCESS_TOKEN ||= '';

await import('../src/index.js');
