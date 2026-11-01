// PostgreSQL embutido do modo local, compartilhado por local.js (sistema) e importar-da-nuvem.js.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

export const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// LOCAL_DATA_DIR permite apontar para uma cópia (ex.: testar um lançamento sem tocar no banco do evento).
const dataDir = path.resolve(process.env.LOCAL_DATA_DIR || path.resolve(serverDir, '../.dados-local'));
const dbDir = path.join(dataDir, 'postgres');

// Configuração do modo local: server/.env.local (veja server/.env.local.example).
export function loadLocalEnv() {
  const envFile = path.join(serverDir, '.env.local');
  if (existsSync(envFile)) dotenv.config({ path: envFile });
  else console.warn('Aviso: server/.env.local não existe. Copie server/.env.local.example e preencha o administrador.');
  mkdirSync(dataDir, { recursive: true });
}

// Segredos gerados uma vez e guardados junto dos dados (os logins continuam válidos ao reiniciar).
export function persistedSecret(file, bytes) {
  const target = path.join(dataDir, file);
  if (existsSync(target)) return readFileSync(target, 'utf8').trim();
  const value = randomBytes(bytes).toString('hex');
  writeFileSync(target, value);
  return value;
}

export function localDatabaseUrl() {
  const port = Number(process.env.LOCAL_PG_PORT || 5442);
  return `postgresql://postgres:${persistedSecret('senha-banco.txt', 16)}@localhost:${port}/eag`;
}

// Banco já no ar (ex.: a janela anterior foi fechada no X e o Postgres continuou rodando): reaproveita.
async function alreadyRunning() {
  const client = new pg.Client({ connectionString: localDatabaseUrl().replace(/\/eag$/, '/postgres'), connectionTimeoutMillis: 2000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}

// Conecta ao banco local: usa o sistema se estiver aberto; se não, liga o Postgres só durante o script.
export async function connectLocalDatabase() {
  const url = localDatabaseUrl();
  let stop = null;
  let db = new pg.Client({ connectionString: url });
  try { await db.connect(); } catch {
    stop = await startLocalDatabase();
    db = new pg.Client({ connectionString: url });
    await db.connect();
  }
  return { db, close: async () => { await db.end().catch(() => {}); await stop?.(); } };
}

// Inicia o Postgres (criando o cluster e o banco "eag" na primeira vez). Devolve uma função para parar.
export async function startLocalDatabase() {
  const port = Number(process.env.LOCAL_PG_PORT || 5442);
  if (existsSync(path.join(dbDir, 'PG_VERSION')) && await alreadyRunning()) {
    console.log('Banco local já estava ligado: reaproveitando.');
    return async () => {};
  }
  const cluster = new EmbeddedPostgres({
    databaseDir: dbDir, user: 'postgres', password: persistedSecret('senha-banco.txt', 16), port, persistent: true,
    // No Windows o padrão seria WIN1252, que recusa caracteres como "→" e emojis: força UTF-8.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {}, onError: (message) => console.error('[banco]', String(message).trim())
  });
  if (!existsSync(path.join(dbDir, 'PG_VERSION'))) {
    console.log('Preparando o banco local pela primeira vez...');
    await cluster.initialise();
  }
  try {
    await cluster.start();
  } catch (error) {
    throw new Error(`Não foi possível iniciar o banco local na porta ${port}. Feche outra janela do sistema que esteja aberta e tente de novo. (${error?.message || error})`);
  }
  try { await cluster.createDatabase('eag'); } catch { /* o banco já existe */ }
  return () => cluster.stop().catch(() => {});
}
