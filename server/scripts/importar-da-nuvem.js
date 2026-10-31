// Traz o cardápio da nuvem (eag-final.vercel.app) para o banco local do evento:
// categorias, produtos (com estoque, opções, notas e fotos enviadas), equipes e configurações.
// Não traz pedidos nem caixa. Rodar com internet, antes do evento: npm run importar.
// Pode rodar de novo: atualiza pelo nome, sem duplicar. Atenção: o estoque local passa a ser o da nuvem.
import readline from 'node:readline';
import pg from 'pg';
import { loadLocalEnv, localDatabaseUrl, startLocalDatabase } from './banco-local.js';

loadLocalEnv();
const cloud = (process.env.CLOUD_URL || 'https://eag-final.vercel.app').replace(/\/$/, '');
const cents = (value) => Math.round(Number(value || 0) * 100);

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (text) => { if (text.includes(question)) rl.output.write(text); };
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); }));
}

async function cloudJson(path, token, init = {}) {
  const response = await fetch(`${cloud}/api${path}`, {
    ...init, signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${data.error || response.status}`);
  return data;
}

console.log(`Importando o cardápio de ${cloud}\n`);
const email = process.env.CLOUD_EMAIL || await ask('E-mail do admin da nuvem: ');
const password = process.env.CLOUD_PASSWORD || await ask('Senha: ', { hidden: true });
const { token } = await cloudJson('/auth/login', null, { method: 'POST', body: JSON.stringify({ email, password }) });
const [categories, products, teams, settings] = await Promise.all(
  ['/admin/categories', '/admin/products', '/admin/teams', '/admin/settings'].map((path) => cloudJson(path, token))
);

// Usa o sistema local se estiver aberto; se não, liga o banco só para a importação.
const url = localDatabaseUrl();
let stopDatabase = null;
let db = new pg.Client({ connectionString: url });
try { await db.connect(); } catch {
  stopDatabase = await startLocalDatabase();
  db = new pg.Client({ connectionString: url });
  await db.connect();
}
const { rowCount: ready } = await db.query("SELECT 1 FROM information_schema.tables WHERE table_name='schema_migrations'");
if (!ready) {
  console.error('O banco local ainda não foi preparado. Abra o sistema local uma vez (iniciar-local.bat) e rode a importação de novo.');
  await db.end(); await stopDatabase?.(); process.exit(1);
}

// Fotos enviadas pelo painel da nuvem ficam no banco de lá (/api/images/ID): copia para o banco local.
const imageCache = new Map();
async function localImage(imageUrl) {
  const match = /^\/api\/images\/(\d+)$/.exec(imageUrl || '');
  if (!match) return imageUrl || '';
  if (imageCache.has(imageUrl)) return imageCache.get(imageUrl);
  try {
    const response = await fetch(`${cloud}${imageUrl}`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(String(response.status));
    const data = Buffer.from(await response.arrayBuffer());
    const { rows } = await db.query("INSERT INTO product_images(mime,data,created_by) VALUES($1,$2,'importação') RETURNING id",
      [response.headers.get('content-type') || 'image/jpeg', data]);
    imageCache.set(imageUrl, `/api/images/${rows[0].id}`);
  } catch (error) {
    console.warn(`  Foto ${imageUrl} não copiada (${error.message}).`);
    imageCache.set(imageUrl, '');
  }
  return imageCache.get(imageUrl);
}

const counts = { categorias: 0, produtosNovos: 0, produtosAtualizados: 0, equipes: 0 };
await db.query('BEGIN');
try {
  const categoryIds = new Map();
  for (const c of categories) {
    const { rows } = await db.query(`INSERT INTO categories(name,mode,sort_order,active) VALUES($1,$2,$3,$4)
      ON CONFLICT (name,mode) DO UPDATE SET sort_order=EXCLUDED.sort_order, active=EXCLUDED.active RETURNING id`,
    [c.name, c.mode, c.sort_order ?? 0, c.active !== false]);
    categoryIds.set(c.id, rows[0].id);
    counts.categorias++;
  }

  for (const p of products.filter((item) => !item.archived)) {
    const groups = (p.optionGroups || []).map((g) => ({
      name: g.name, min: g.min, max: g.max, required: g.min > 0,
      options: g.options.map((o) => ({ name: o.name, extraCents: cents(o.extra), available: o.available !== false }))
    }));
    const values = [p.name, p.description || '', p.mode, categoryIds.get(p.categoryId) ?? null, cents(p.price), p.available,
      await localImage(p.imageUrl), p.stock, p.prepMinutes, JSON.stringify(groups), p.allowNotes, p.customTextLabel || '',
      Boolean(p.customTextRequired), p.adminNotes || '', Boolean(p.needsReview), p.sortOrder ?? 0];
    const existing = await db.query('SELECT id FROM products WHERE mode=$1 AND LOWER(name)=LOWER($2) AND archived=FALSE ORDER BY id LIMIT 1', [p.mode, p.name]);
    if (existing.rowCount) {
      await db.query(`UPDATE products SET name=$1,description=$2,mode=$3,category_id=$4,price_cents=$5,available=$6,image_url=$7,stock=$8,
          prep_minutes=$9,option_groups=$10,allow_notes=$11,custom_text_label=$12,custom_text_required=$13,admin_notes=$14,needs_review=$15,
          sort_order=$16,updated_at=NOW() WHERE id=$17`, [...values, existing.rows[0].id]);
      counts.produtosAtualizados++;
    } else {
      await db.query(`INSERT INTO products(name,description,mode,category_id,price_cents,available,image_url,stock,prep_minutes,option_groups,
          allow_notes,custom_text_label,custom_text_required,admin_notes,needs_review,sort_order)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, values);
      counts.produtosNovos++;
    }
  }

  for (const t of teams) {
    await db.query(`INSERT INTO teams(name,description,active) VALUES($1,$2,$3)
      ON CONFLICT (name) DO UPDATE SET description=EXCLUDED.description, active=EXCLUDED.active`, [t.name, t.description || '', t.active !== false]);
    counts.equipes++;
  }
  // Equipes que só existem no local (as padrão) seguem a nuvem: ficam desativadas.
  await db.query('UPDATE teams SET active=FALSE WHERE NOT (name = ANY($1))', [teams.map((t) => t.name)]);

  const { delivery_fee: fee, ...service } = settings.service;
  const pix = { ...settings.pix, ...(settings.pix?.qr_image ? { qr_image: await localImage(settings.pix.qr_image) } : {}) };
  const stored = { pix, payment_deadline_minutes: settings.payment_deadline_minutes, payment_methods: settings.payment_methods,
    // A pausa do site vale só para a nuvem; no local, os pedidos seguem normalmente.
    service: { ...service, site_paused: false, delivery_fee_cents: cents(fee) }, kitchen: settings.kitchen, contact: settings.contact };
  for (const [key, value] of Object.entries(stored)) {
    if (value === undefined) continue;
    await db.query(`INSERT INTO settings(key,value,updated_at) VALUES($1,$2,NOW())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [key, JSON.stringify(value)]);
  }
  await db.query('COMMIT');
} catch (error) {
  await db.query('ROLLBACK');
  console.error('Importação cancelada, nada foi alterado:', error.message);
  await db.end(); await stopDatabase?.(); process.exit(1);
}
await db.end();
await stopDatabase?.();
console.log(`\nPronto: ${counts.categorias} categorias, ${counts.produtosNovos} produtos novos, ${counts.produtosAtualizados} atualizados, ${counts.equipes} equipes e as configurações.`);
console.log('Se o sistema local estiver aberto, recarregue as páginas para ver o cardápio novo.');
