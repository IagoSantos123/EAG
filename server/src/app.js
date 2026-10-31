import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, initializeDatabase } from './db.js';
import { asyncRoute, fail, parse, HttpError } from './lib/http.js';
import { auth, signToken, permissionsFor, ROLES } from './lib/auth.js';
import publicRoutes from './routes/public.js';
import orderRoutes from './routes/orders.js';
import financeRoutes from './routes/finance.js';
import adminRoutes from './routes/admin.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET deve ter ao menos 32 caracteres.');

// Modo local (evento sem internet): o próprio servidor entrega as telas, pela rede da sala, em http.
const serveClient = process.env.SERVE_CLIENT === '1';

const app = express();
// Atrás do proxy da Vercel (ou outro), o IP real vem do cabeçalho X-Forwarded-For.
if (process.env.VERCEL) app.set('trust proxy', 1);
else if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.disable('x-powered-by');

// Banco preparado uma única vez por instância (estrutura, migrações e dados iniciais).
// Se falhar (ex.: banco indisponível), tenta de novo na próxima requisição.
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) readyPromise = initializeDatabase().catch((error) => { readyPromise = null; throw error; });
  return readyPromise;
}
export const ready = ensureReady();
ready.catch((error) => console.error('Falha ao preparar o banco:', error.message));
app.use((req, res, next) => { ensureReady().then(() => next(), next); });
// Em http na rede local, a política padrão forçaria https nos recursos da página; no modo local ela fica desligada.
app.use(serveClient ? helmet({ contentSecurityPolicy: false, hsts: false, crossOriginOpenerPolicy: false }) : helmet());
const origins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({ origin: origins }));
// O upload de imagens tem limite próprio (definido na rota); o restante da API aceita até 1 MB.
const jsonParser = express.json({ limit: '1mb' });
app.use((req, res, next) => (req.path === '/api/admin/images' ? next() : jsonParser(req, res, next)));

app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas de acesso. Aguarde 15 minutos.' } }));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const input = parse(z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200) }), req.body, 'Informe e-mail e senha válidos.');
  const result = await pool.query('SELECT id,name,email,password_hash,role FROM admins WHERE email=LOWER($1) AND active=TRUE', [input.email]);
  if (!result.rowCount || !(await bcrypt.compare(input.password, result.rows[0].password_hash))) return fail(res, 401, 'Credenciais incorretas.');
  const user = result.rows[0];
  res.json({ token: signToken(user), user: { id: user.id, name: user.name, role: user.role, roleLabel: ROLES[user.role], permissions: permissionsFor(user.role) } });
}));

app.get('/api/me', auth(), (req, res) => {
  res.json({ ...req.user, roleLabel: ROLES[req.user.role], permissions: permissionsFor(req.user.role) });
});

app.use('/api', publicRoutes);
app.use('/api/admin', orderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/finance', financeRoutes);

app.use('/api', (_req, res) => fail(res, 404, 'Rota não encontrada.'));

if (serveClient) {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  // index.html sem cache (atualizações aparecem ao recarregar); os arquivos com hash no nome podem ficar em cache.
  app.use(express.static(dist, { index: false, setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
  app.get('*', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(dist, 'index.html')); });
}

app.use((error, _req, res, _next) => {
  if (error instanceof HttpError) return fail(res, error.status, error.message, error.code);
  if (error.type === 'entity.too.large') return fail(res, 413, 'Conteúdo muito grande.');
  if (error.type === 'entity.parse.failed') return fail(res, 400, 'Requisição inválida.');
  // Gatilhos de integridade do banco (caixa fechado, registros imutáveis).
  if (error.code === 'P0001') return fail(res, 409, error.message);
  if (error.code === '23514' || error.code === '23503') return fail(res, 409, 'Operação recusada para preservar a integridade dos dados.');
  console.error(error);
  res.status(500).json({ error: 'Erro interno. Tente novamente.' });
});

export default app;
