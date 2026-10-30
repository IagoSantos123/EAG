// Administração: produtos, categorias, equipes, configurações e usuários.
import { Router } from 'express';
import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, readSettings } from '../db.js';
import { auth, ROLES } from '../lib/auth.js';
import { asyncRoute, fail, parse, toId, toCents, toMoney, withTransaction, HttpError } from '../lib/http.js';
import { audit, optionExtraCents } from '../lib/orders.js';
import { publish } from '../lib/events.js';

const router = Router();
const modeSchema = z.enum(['religious', 'snack']);

// ---------- Produtos ----------

const optionGroupSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome a cada grupo de opções.').max(60),
  min: z.number().int().min(0).max(20),
  max: z.number().int().min(1, 'O máximo de escolhas deve ser ao menos 1.').max(20),
  options: z.array(z.object({
    name: z.string().trim().min(1, 'Toda opção precisa de nome.').max(80),
    extra: z.number().min(0, 'Valor adicional não pode ser negativo.').max(1000),
    available: z.boolean().default(true)
  })).min(1, 'Cada grupo precisa de pelo menos uma opção.').max(40)
}).superRefine((group, ctx) => {
  if (group.min > group.max) ctx.addIssue({ code: 'custom', message: `Grupo "${group.name}": o mínimo não pode ser maior que o máximo.` });
  if (group.max > group.options.length) ctx.addIssue({ code: 'custom', message: `Grupo "${group.name}": o máximo é maior que o número de opções.` });
  const names = group.options.map((option) => option.name.toLowerCase());
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: `Grupo "${group.name}": há opções com o mesmo nome.` });
});

const productSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome do produto.').max(160),
  description: z.string().trim().max(2000).default(''),
  mode: modeSchema,
  categoryId: z.number().int().positive().nullable().default(null),
  price: z.number({ invalid_type_error: 'Informe o preço.' }).min(0, 'Preço inválido.').max(100000),
  available: z.boolean().default(true),
  imageUrl: z.string().trim().max(1000).refine((value) => !value || /^(https:\/\/|\/api\/images\/\d+$|\/brand\/|\/products\/)/.test(value), 'Use um endereço de imagem https:// ou envie um arquivo.').default(''),
  stock: z.number().int().min(0, 'Estoque não pode ser negativo.').max(1000000).nullable().default(null),
  prepMinutes: z.number().int().min(0).max(600).nullable().default(null),
  allowNotes: z.boolean().default(true),
  customTextLabel: z.string().trim().max(80).default(''),
  customTextRequired: z.boolean().default(false),
  adminNotes: z.string().trim().max(1000).default(''),
  needsReview: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  optionGroups: z.array(optionGroupSchema).max(10, 'Máximo de 10 grupos de opções.').default([])
}).superRefine((product, ctx) => {
  const names = product.optionGroups.map((group) => group.name.toLowerCase());
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Há grupos de opções com o mesmo nome.' });
});

const storedGroups = (groups) => groups.map((group) => ({
  name: group.name, min: group.min, max: group.max, required: group.min > 0,
  options: group.options.map((option) => ({ name: option.name, extraCents: toCents(option.extra), available: option.available }))
}));

function serializeProduct(p) {
  return {
    id: p.id, name: p.name, description: p.description || '', mode: p.mode, categoryId: p.category_id, category: p.category_name || '',
    price: toMoney(p.price_cents), available: p.available, archived: p.archived, imageUrl: p.image_url || '', stock: p.stock,
    prepMinutes: p.prep_minutes, allowNotes: p.allow_notes, customTextLabel: p.custom_text_label, customTextRequired: p.custom_text_required,
    adminNotes: p.admin_notes, needsReview: p.needs_review, sortOrder: p.sort_order, updatedAt: p.updated_at,
    optionGroups: (p.option_groups || []).map((group) => ({
      name: group.name, min: Number(group.min ?? (group.required ? 1 : 0)), max: Number(group.max ?? 1),
      options: (group.options || []).map((option) => ({ name: option.name, extra: toMoney(optionExtraCents(option)), available: option.available !== false }))
    }))
  };
}

async function checkCategory(db, categoryId, mode) {
  if (!categoryId) return;
  const { rowCount } = await db.query('SELECT 1 FROM categories WHERE id=$1 AND mode=$2', [categoryId, mode]);
  if (!rowCount) throw new HttpError(400, 'A categoria escolhida não pertence a este catálogo.');
}

router.get('/products', auth('catalog.manage'), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id
    ORDER BY p.mode, c.sort_order NULLS LAST, p.sort_order, p.name`);
  res.json(rows.map(serializeProduct));
}));

router.post('/products', auth('catalog.manage'), asyncRoute(async (req, res) => {
  const p = parse(productSchema, req.body, 'Dados do produto inválidos.');
  const id = await withTransaction(pool, async (db) => {
    await checkCategory(db, p.categoryId, p.mode);
    const duplicate = await db.query('SELECT 1 FROM products WHERE mode=$1 AND LOWER(name)=LOWER($2) AND archived=FALSE', [p.mode, p.name]);
    if (duplicate.rowCount) throw new HttpError(409, 'Já existe um produto com este nome neste catálogo.');
    const { rows } = await db.query(`INSERT INTO products(name,description,mode,category_id,price_cents,available,image_url,stock,prep_minutes,option_groups,
        allow_notes,custom_text_label,custom_text_required,admin_notes,needs_review,sort_order)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [p.name, p.description, p.mode, p.categoryId, toCents(p.price), p.available, p.imageUrl, p.stock, p.prepMinutes, JSON.stringify(storedGroups(p.optionGroups)),
      p.allowNotes, p.customTextLabel, p.customTextRequired && Boolean(p.customTextLabel), p.adminNotes, p.needsReview, p.sortOrder]);
    await audit(db, req.user, 'product.create', 'product', rows[0].id, { name: p.name, price: p.price });
    return rows[0].id;
  });
  publish('catalog', {});
  res.status(201).json({ id });
}));

router.put('/products/:id', auth('catalog.manage'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const p = parse(productSchema, req.body, 'Dados do produto inválidos.');
  await withTransaction(pool, async (db) => {
    const before = await db.query('SELECT name,price_cents,available,stock FROM products WHERE id=$1 FOR UPDATE', [id]);
    if (!before.rowCount) throw new HttpError(404, 'Produto não encontrado.');
    await checkCategory(db, p.categoryId, p.mode);
    const duplicate = await db.query('SELECT 1 FROM products WHERE mode=$1 AND LOWER(name)=LOWER($2) AND archived=FALSE AND id<>$3', [p.mode, p.name, id]);
    if (duplicate.rowCount) throw new HttpError(409, 'Já existe outro produto com este nome neste catálogo.');
    await db.query(`UPDATE products SET name=$1,description=$2,mode=$3,category_id=$4,price_cents=$5,available=$6,image_url=$7,stock=$8,prep_minutes=$9,
        option_groups=$10,allow_notes=$11,custom_text_label=$12,custom_text_required=$13,admin_notes=$14,needs_review=$15,sort_order=$16,updated_at=NOW()
      WHERE id=$17`,
    [p.name, p.description, p.mode, p.categoryId, toCents(p.price), p.available, p.imageUrl, p.stock, p.prepMinutes, JSON.stringify(storedGroups(p.optionGroups)),
      p.allowNotes, p.customTextLabel, p.customTextRequired && Boolean(p.customTextLabel), p.adminNotes, p.needsReview, p.sortOrder, id]);
    const old = before.rows[0];
    await audit(db, req.user, 'product.update', 'product', id, {
      name: p.name,
      ...(old.price_cents !== toCents(p.price) ? { priceFrom: toMoney(old.price_cents), priceTo: p.price } : {}),
      ...(old.available !== p.available ? { available: p.available } : {}),
      ...(old.stock !== p.stock ? { stockFrom: old.stock, stockTo: p.stock } : {})
    });
  });
  publish('catalog', {});
  res.json({ ok: true });
}));

router.patch('/products/:id', auth('catalog.manage'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const input = parse(z.object({ available: z.boolean().optional(), archived: z.boolean().optional() }).refine((v) => v.available !== undefined || v.archived !== undefined), req.body, 'Alteração inválida.');
  await withTransaction(pool, async (db) => {
    const found = await db.query('SELECT id,name,mode,archived FROM products WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new HttpError(404, 'Produto não encontrado.');
    if (input.archived === false) {
      const duplicate = await db.query('SELECT 1 FROM products WHERE mode=$1 AND LOWER(name)=LOWER($2) AND archived=FALSE AND id<>$3', [found.rows[0].mode, found.rows[0].name, id]);
      if (duplicate.rowCount) throw new HttpError(409, 'Já existe um produto ativo com este nome.');
    }
    // Arquivar sempre torna o produto indisponível.
    await db.query(`UPDATE products SET archived=COALESCE($2::boolean,archived),
      available=CASE WHEN $2::boolean IS TRUE THEN FALSE ELSE COALESCE($1::boolean,available) END, updated_at=NOW() WHERE id=$3`, [input.available ?? null, input.archived ?? null, id]);
    await audit(db, req.user, 'product.status', 'product', id, input);
  });
  publish('catalog', {});
  res.json({ ok: true });
}));

// Upload de imagem: o navegador já redimensiona; aqui valida tipo e tamanho.
router.post('/images', express.json({ limit: '3mb' }), auth('catalog.manage'), asyncRoute(async (req, res) => {
  const input = parse(z.object({ dataUrl: z.string().max(3_000_000) }), req.body, 'Imagem inválida.');
  const match = input.dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new HttpError(400, 'Envie uma imagem JPG, PNG ou WEBP.');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 1_500_000) throw new HttpError(400, 'Imagem muito grande (máximo 1,5 MB).');
  const { rows } = await pool.query('INSERT INTO product_images(mime,data,created_by) VALUES($1,$2,$3) RETURNING id', [match[1], buffer, req.user.name]);
  res.status(201).json({ url: `/api/images/${rows[0].id}` });
}));

// ---------- Categorias ----------

router.get('/categories', auth('catalog.manage'), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT c.id,c.name,c.mode,c.sort_order,c.active,
      (SELECT COUNT(*)::int FROM products p WHERE p.category_id=c.id AND p.archived=FALSE) AS products
    FROM categories c ORDER BY c.mode,c.sort_order,c.name`);
  res.json(rows);
}));
router.post('/categories', auth('catalog.manage'), asyncRoute(async (req, res) => {
  const input = parse(z.object({ name: z.string().trim().min(2, 'Nome de categoria muito curto.').max(100), mode: modeSchema, sortOrder: z.number().int().min(0).max(1000).default(0) }), req.body, 'Categoria inválida.');
  try {
    const { rows } = await pool.query('INSERT INTO categories(name,mode,sort_order) VALUES($1,$2,$3) RETURNING id', [input.name, input.mode, input.sortOrder]);
    await audit(pool, req.user, 'category.create', 'category', rows[0].id, input);
    publish('catalog', {});
    res.status(201).json(rows[0]);
  } catch (error) { if (error.code === '23505') return fail(res, 409, 'Categoria já cadastrada.'); throw error; }
}));
router.patch('/categories/:id', auth('catalog.manage'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const input = parse(z.object({ active: z.boolean().optional(), name: z.string().trim().min(2).max(100).optional(), sortOrder: z.number().int().min(0).max(1000).optional() }), req.body, 'Alteração inválida.');
  try {
    const result = await pool.query('UPDATE categories SET active=COALESCE($1,active), name=COALESCE($2,name), sort_order=COALESCE($3,sort_order) WHERE id=$4',
      [input.active ?? null, input.name ?? null, input.sortOrder ?? null, id]);
    if (!result.rowCount) return fail(res, 404, 'Categoria não encontrada.');
  } catch (error) { if (error.code === '23505') return fail(res, 409, 'Já existe uma categoria com este nome.'); throw error; }
  await audit(pool, req.user, 'category.update', 'category', id, input);
  publish('catalog', {});
  res.json({ ok: true });
}));

// ---------- Equipes ----------

router.get('/teams', auth('settings.manage'), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM teams ORDER BY name'); res.json(rows);
}));
router.post('/teams', auth('settings.manage'), asyncRoute(async (req, res) => {
  const input = parse(z.object({ name: z.string().trim().min(2, 'Nome de equipe muito curto.').max(100), description: z.string().max(300).default('') }), req.body, 'Nome de equipe inválido.');
  try {
    const result = await pool.query('INSERT INTO teams(name,description) VALUES($1,$2) RETURNING id', [input.name, input.description]);
    await audit(pool, req.user, 'team.create', 'team', result.rows[0].id, input);
    res.status(201).json(result.rows[0]);
  } catch (error) { if (error.code === '23505') return fail(res, 409, 'Essa equipe já existe.'); throw error; }
}));
router.patch('/teams/:id', auth('settings.manage'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const input = parse(z.object({ active: z.boolean() }), req.body, 'Status inválido.');
  const result = await pool.query('UPDATE teams SET active=$1 WHERE id=$2', [input.active, id]);
  if (!result.rowCount) return fail(res, 404, 'Equipe não encontrada.');
  await audit(pool, req.user, 'team.update', 'team', id, input);
  res.json({ ok: true });
}));

// ---------- Configurações ----------

const settingsSchemas = {
  pix: z.object({
    key: z.string().trim().max(250), type: z.string().trim().max(60), beneficiary: z.string().trim().max(120),
    city: z.string().trim().max(80), instructions: z.string().trim().max(1000)
  }),
  payment_deadline_minutes: z.number().int().min(5, 'Prazo mínimo: 5 minutos.').max(120, 'Prazo máximo: 120 minutos.'),
  payment_methods: z.object({ cash: z.boolean(), debit: z.boolean(), credit: z.boolean(), fiado_self: z.boolean().default(false) }),
  service: z.object({
    dine_in: z.boolean(), delivery: z.boolean(), pickup: z.boolean(),
    delivery_fee: z.number().min(0, 'Taxa de entrega inválida.').max(1000),
    tables_enabled: z.boolean(), table_count: z.number().int().min(0).max(500),
    delivery_instructions: z.string().trim().max(500), pickup_instructions: z.string().trim().max(500), dine_in_instructions: z.string().trim().max(500)
  }).refine((s) => s.dine_in || s.delivery || s.pickup, 'Mantenha pelo menos uma modalidade de atendimento ativa.'),
  kitchen: z.object({ require_pix_confirmation: z.boolean() }),
  contact: z.object({ phone: z.string().trim().max(40) })
};

function serializeSettings(settings) {
  const { delivery_fee_cents: fee, ...service } = settings.service;
  return {
    pix: settings.pix, payment_deadline_minutes: settings.payment_deadline_minutes, payment_methods: settings.payment_methods,
    service: { ...service, delivery_fee: toMoney(fee) }, kitchen: settings.kitchen, contact: settings.contact
  };
}

router.get('/settings', auth('settings.manage'), asyncRoute(async (_req, res) => {
  res.json(serializeSettings(await readSettings()));
}));

router.put('/settings', auth('settings.manage'), asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const updates = {};
  for (const [key, schema] of Object.entries(settingsSchemas)) {
    if (body[key] === undefined) continue;
    updates[key] = parse(schema, body[key], 'Configurações inválidas.');
  }
  if (!Object.keys(updates).length) throw new HttpError(400, 'Nada para salvar.');
  if (updates.service) {
    const { delivery_fee: fee, ...service } = updates.service;
    updates.service = { ...service, delivery_fee_cents: toCents(fee) };
  }
  await withTransaction(pool, async (db) => {
    for (const [key, value] of Object.entries(updates)) {
      await db.query('INSERT INTO settings(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()', [key, JSON.stringify(value)]);
    }
    await audit(db, req.user, 'settings.update', 'settings', Object.keys(updates).join(','), updates);
  });
  publish('settings', {});
  res.json(serializeSettings(await readSettings()));
}));

// ---------- Usuários ----------

const roleSchema = z.enum(Object.keys(ROLES));

router.get('/users', auth('users.manage'), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query('SELECT id,name,email,role,active,created_at FROM admins ORDER BY active DESC, name');
  res.json(rows);
}));

router.post('/users', auth('users.manage'), asyncRoute(async (req, res) => {
  const input = parse(z.object({
    name: z.string().trim().min(2, 'Informe o nome.').max(120),
    email: z.string().trim().email('E-mail inválido.').max(200),
    password: z.string().min(8, 'A senha deve ter pelo menos 8 caracteres.').max(200),
    role: roleSchema
  }), req.body);
  try {
    const hash = await bcrypt.hash(input.password, 12);
    const { rows } = await pool.query('INSERT INTO admins(name,email,password_hash,role) VALUES($1,LOWER($2),$3,$4) RETURNING id', [input.name, input.email, hash, input.role]);
    await audit(pool, req.user, 'user.create', 'user', rows[0].id, { name: input.name, email: input.email, role: input.role });
    res.status(201).json(rows[0]);
  } catch (error) { if (error.code === '23505') return fail(res, 409, 'Já existe um usuário com este e-mail.'); throw error; }
}));

router.patch('/users/:id', auth('users.manage'), asyncRoute(async (req, res) => {
  const id = toId(req.params.id);
  const input = parse(z.object({
    name: z.string().trim().min(2).max(120).optional(),
    role: roleSchema.optional(),
    active: z.boolean().optional(),
    password: z.string().min(8, 'A senha deve ter pelo menos 8 caracteres.').max(200).optional()
  }), req.body);
  await withTransaction(pool, async (db) => {
    const found = await db.query('SELECT id,role,active FROM admins WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new HttpError(404, 'Usuário não encontrado.');
    const target = found.rows[0];
    if (id === req.user.id && (input.active === false || (input.role && input.role !== 'admin'))) {
      throw new HttpError(400, 'Você não pode desativar nem rebaixar o próprio usuário.');
    }
    // Garante que sempre reste ao menos um administrador ativo.
    if (target.role === 'admin' && target.active && (input.active === false || (input.role && input.role !== 'admin'))) {
      await db.query("SELECT id FROM admins WHERE role='admin' AND active=TRUE FOR UPDATE");
      const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM admins WHERE role='admin' AND active=TRUE");
      if (rows[0].n <= 1) throw new HttpError(400, 'É preciso manter pelo menos um administrador ativo.');
    }
    const hash = input.password ? await bcrypt.hash(input.password, 12) : null;
    await db.query(`UPDATE admins SET name=COALESCE($1,name), role=COALESCE($2,role), active=COALESCE($3,active),
      password_hash=COALESCE($4,password_hash), updated_at=NOW() WHERE id=$5`, [input.name ?? null, input.role ?? null, input.active ?? null, hash, id]);
    await audit(db, req.user, 'user.update', 'user', id, { ...input, password: input.password ? 'alterada' : undefined });
  });
  res.json({ ok: true });
}));

router.get('/audit', auth('users.manage'), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query('SELECT id,actor_name,action,entity,entity_id,details,created_at FROM audit_log ORDER BY created_at DESC LIMIT 300');
  res.json(rows);
}));

export default router;
