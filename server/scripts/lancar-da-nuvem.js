// Lança no banco local pedidos feitos em outro lugar: os da nuvem (eag-final.vercel.app) ou os anotados no papel.
// Cada pedido entra com a data/hora original, finalizado, com os pagamentos e o fiado como estavam.
//
//   npm run lancar-nuvem                         lê da nuvem (pede o login) os pedidos de 30/10 e 31/10
//   npm run lancar-nuvem -- --de 2026-10-30 --ate 2026-10-31
//   npm run lancar-nuvem -- --arquivo pedidos.json   lê de um arquivo (ex.: vendas do papel)
//   ... --sim                                    não pergunta antes de gravar
//
// Regras: o código AG-... é a chave (rodar de novo não duplica); pedidos da nuvem não baixam estoque
// (o cardápio local já veio da nuvem com essas vendas descontadas); pedidos com "baixarEstoque" baixam.
// Pagamentos com data anterior à abertura do caixa aberto ficam fora dele (não mexem na conferência da gaveta);
// os do dia do caixa aberto entram nele.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import { loadLocalEnv, connectLocalDatabase } from './banco-local.js';

loadLocalEnv();
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] ?? true) : null; };
const cloud = (process.env.CLOUD_URL || 'https://eag-final.vercel.app').replace(/\/$/, '');
const TZ = process.env.APP_TIMEZONE || 'America/Fortaleza';
const cents = (value) => Math.round(Number(value || 0) * 100);
const money = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const localDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
const ACTOR = 'Lançamento da nuvem';

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (text) => { if (text.includes(question)) rl.output.write(text); };
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); }));
}

async function cloudJson(path, token, init = {}) {
  const response = await fetch(`${cloud}/api${path}`, {
    ...init, signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${data.error || response.status}`);
  return data;
}

// Formato comum dos pedidos a lançar (o mesmo aceito em --arquivo).
function normalize(o) {
  return {
    orderNumber: o.orderNumber, createdAt: o.createdAt, ticket: o.ticket, buyerName: o.buyerName, buyerPhone: o.buyerPhone || '',
    teamName: o.teamName || 'Sem equipe', mode: o.mode, serviceType: o.serviceType || 'pickup', status: o.status, source: o.source || 'balcao',
    onCredit: Boolean(o.onCredit), paymentMethod: o.paymentMethod,
    items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unitPrice, note: i.note || '',
      options: (i.options || []).map((x) => ({ group: x.group, option: x.option, extra: x.extra || 0 })) })),
    payments: (o.payments || []).filter((p) => p.status === undefined || p.status === 'confirmed')
      .map((p) => ({ kind: p.kind || 'payment', method: p.method, amount: p.amount, createdAt: p.createdAt || p.created_at || o.createdAt })),
    baixarEstoque: Boolean(o.baixarEstoque), nota: o.nota || ''
  };
}

async function fromCloud() {
  const de = flag('de') || '2026-10-30';
  const ate = flag('ate') || '2026-10-31';
  console.log(`Lendo os pedidos de ${de} a ${ate} em ${cloud}\n`);
  let token = null;
  for (let attempt = 1; attempt <= 3 && !token; attempt++) {
    const email = process.env.CLOUD_EMAIL || await ask('E-mail do admin da nuvem: ');
    const password = process.env.CLOUD_PASSWORD || await ask('Senha (não aparece ao digitar): ', { hidden: true });
    try { ({ token } = await cloudJson('/auth/login', null, { method: 'POST', body: JSON.stringify({ email, password }) })); }
    catch (error) { console.error(`\nNão foi possível entrar: ${error.message.replace(/^\/auth\/login: /, '')}\n`); if (process.env.CLOUD_PASSWORD) process.exit(1); }
  }
  if (!token) process.exit(1);
  const list = await cloudJson(`/admin/orders?from=${de}&to=${ate}`, token);
  const detailed = [];
  for (const o of list) detailed.push(await cloudJson(`/admin/orders/${o.id}`, token));
  return detailed.map(normalize);
}

const file = flag('arquivo');
const source = typeof file === 'string' ? JSON.parse(readFileSync(file, 'utf8')).map(normalize) : await fromCloud();
const orders = source.filter((o) => o.status === 'active').sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
const skipped = source.length - orders.length;

const { db, close } = await connectLocalDatabase();
try {
  const session = (await db.query("SELECT id, opened_at FROM cash_sessions WHERE status='open'")).rows[0] || null;
  const sessionDay = session ? localDay(session.opened_at) : null;
  const existing = new Set((await db.query('SELECT order_number FROM orders WHERE order_number = ANY($1)', [orders.map((o) => o.orderNumber)])).rows.map((r) => r.order_number));
  const fresh = orders.filter((o) => !existing.has(o.orderNumber));

  // Resumo antes de gravar.
  const sum = { pedidos: 0, total: 0, fiado: 0, noCaixa: 0, foraCaixa: 0, metodos: {} };
  const missing = new Set();
  for (const o of fresh) {
    const total = o.items.reduce((s, i) => s + cents(i.unitPrice) * i.quantity, 0);
    sum.pedidos++; sum.total += total;
    if (o.onCredit) sum.fiado += total - o.payments.reduce((s, p) => s + cents(p.amount), 0);
    for (const p of o.payments) {
      sum.metodos[p.method] = (sum.metodos[p.method] || 0) + cents(p.amount);
      if (session && localDay(p.createdAt) >= sessionDay) sum.noCaixa += cents(p.amount); else sum.foraCaixa += cents(p.amount);
    }
    for (const i of o.items) {
      const found = await db.query('SELECT 1 FROM products WHERE mode=$1 AND LOWER(name)=LOWER($2) LIMIT 1', [o.mode, i.name]);
      if (!found.rowCount) missing.add(i.name);
    }
  }
  const labels = { cash: 'Dinheiro', pix: 'PIX', debit: 'Débito', credit: 'Crédito' };
  console.log(`\nA lançar: ${sum.pedidos} pedidos, ${money(sum.total)}` + (existing.size ? ` (${existing.size} já estavam no local e ficam como estão)` : '') + (skipped ? ` · ${skipped} cancelados/expirados ignorados` : ''));
  console.log(`Recebidos: ${Object.entries(sum.metodos).map(([k, v]) => `${labels[k] || k} ${money(v)}`).join(' · ') || 'nenhum'} · Fiado em aberto: ${money(sum.fiado)}`);
  console.log(`No caixa aberto${sessionDay ? ` (desde ${sessionDay})` : ''}: ${money(sum.noCaixa)} · Fora do caixa (dias anteriores): ${money(sum.foraCaixa)}`);
  if (missing.size) console.log(`Itens sem produto igual no local (entram só com o nome): ${[...missing].join(', ')}`);
  if (!fresh.length) { console.log('\nNada novo para lançar.'); process.exitCode = 0; }
  else if (!args.includes('--sim') && !/^s/i.test(await ask('\nConfirmar o lançamento? (s/n) '))) console.log('Cancelado, nada foi gravado.');
  else {
    await db.query('BEGIN');
    try {
      for (const o of fresh) {
        const snapshot = [];
        for (const i of o.items) {
          const p = (await db.query(`SELECT p.id, p.stock, p.category_id, p.prep_minutes, c.name AS category FROM products p LEFT JOIN categories c ON c.id=p.category_id
            WHERE p.mode=$1 AND LOWER(p.name)=LOWER($2) ORDER BY p.archived, p.id LIMIT 1`, [o.mode, i.name])).rows[0];
          const options = i.options.map((x) => ({ group: x.group, option: x.option, extraCents: cents(x.extra) }));
          const unitCents = cents(i.unitPrice);
          snapshot.push({ productId: p ? Number(p.id) : null, name: i.name, categoryId: p?.category_id ? Number(p.category_id) : null, category: p?.category || '',
            baseCents: unitCents - options.reduce((s, x) => s + x.extraCents, 0), unitCents, quantity: i.quantity, totalCents: unitCents * i.quantity,
            options, note: i.note, customText: '', customTextLabel: '', prepMinutes: p?.prep_minutes ?? null });
          if (o.baixarEstoque && p?.stock != null) await db.query('UPDATE products SET stock=GREATEST(stock-$1,0), updated_at=NOW() WHERE id=$2', [i.quantity, p.id]);
        }
        const total = snapshot.reduce((s, i) => s + i.totalCents, 0);
        const paid = o.payments.reduce((s, p) => s + (p.kind === 'refund' ? -1 : 1) * cents(p.amount), 0);
        const paymentStatus = paid >= total && total > 0 ? 'confirmed' : paid > 0 ? 'partial' : 'awaiting_payment';
        const lastPay = o.payments.length ? o.payments[o.payments.length - 1].createdAt : null;
        // Mantém a senha original, a menos que o dia já tenha essa senha no local (ex.: pedidos do site no dia do evento local).
        const taken = await db.query(`SELECT 1 FROM orders WHERE ticket_number=$1 AND (created_at AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date`, [o.ticket, TZ, o.createdAt]);
        const ticket = taken.rowCount ? (await db.query(`SELECT COALESCE(MAX(ticket_number),0)+1 AS next FROM orders
          WHERE (created_at AT TIME ZONE $1)::date = ($2::timestamptz AT TIME ZONE $1)::date`, [TZ, o.createdAt])).rows[0].next : o.ticket;
        const team = (await db.query('SELECT id FROM teams WHERE name=$1', [o.teamName])).rows[0];
        const method = o.onCredit ? 'fiado' : (o.paymentMethod && o.paymentMethod !== 'fiado' ? o.paymentMethod : (o.payments[0]?.method || 'cash'));
        const { rows: [order] } = await db.query(`INSERT INTO orders(order_number,public_token,buyer_name,buyer_phone,team_id,team_name,mode,items,
            subtotal_cents,total_cents,delivery_fee_cents,paid_cents,refunded_cents,status,payment_status,production_status,service_type,payment_method,
            ticket_number,source,on_credit,credit_at,credit_by_name,credit_note,paid_at,finalized_at,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,0,$10,0,'active',$11,'finalized',$12,$13,$14,$15,$16,CASE WHEN $16 THEN $17::timestamptz END,
            CASE WHEN $16 THEN $18 END,$19,CASE WHEN $11='confirmed' THEN $20::timestamptz END,$17,$17,$17) RETURNING id`,
        [o.orderNumber, randomBytes(24).toString('base64url'), o.buyerName, o.buyerPhone, team?.id ?? null, o.teamName, o.mode, JSON.stringify(snapshot),
          total, Math.max(paid, 0), paymentStatus, o.serviceType, method, ticket, o.source === 'site' ? 'site' : 'balcao', o.onCredit, o.createdAt, ACTOR,
          o.nota || (o.onCredit ? 'Fiado do sistema da nuvem' : ''), lastPay]);
        for (const [index, p] of o.payments.entries()) {
          const inSession = session && localDay(p.createdAt) >= sessionDay;
          await db.query(`INSERT INTO payments(order_id,session_id,kind,method,amount_cents,note,idempotency_key,created_by_name,created_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [order.id, inSession ? session.id : null, p.kind, p.method, cents(p.amount),
            `Lançado do sistema da nuvem (${o.orderNumber})`, `nuvem:${o.orderNumber}:${index}`, ACTOR, p.createdAt]);
        }
        const note = `Lançado no sistema local a partir de ${o.source === 'papel' ? 'anotação em papel' : 'pedido da nuvem'} ${o.orderNumber}${ticket !== o.ticket ? ` (senha original #${o.ticket})` : ''}${o.nota ? ` — ${o.nota}` : ''}`;
        await db.query(`INSERT INTO order_history(order_id,kind,status,note,actor,created_at) VALUES($1,'order','created',$2,$3,$4),($1,'order','finalized',$5,$3,$4)`,
          [order.id, note, ACTOR, o.createdAt, 'Finalizado (pedido de dia anterior)']);
        if (o.onCredit) await db.query(`INSERT INTO order_history(order_id,kind,status,note,actor,created_at) VALUES($1,'payment','credit','Lançado como fiado',$2,$3)`, [order.id, ACTOR, o.createdAt]);
      }
      await db.query('COMMIT');
      console.log(`\nPronto: ${fresh.length} pedidos lançados.`);
    } catch (error) {
      await db.query('ROLLBACK');
      console.error('Lançamento cancelado, nada foi gravado:', error.message);
      process.exitCode = 1;
    }
  }
} finally {
  await close();
}
