import pg from 'pg';
import bcrypt from 'bcryptjs';
import { MENU_CATEGORIES, MENU_PRODUCTS, MENU_DELIVERY_FEE_CENTS, MENU_IMAGES } from './menu-seed.js';

const { Pool, types } = pg;
if (!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL no arquivo .env.');

// BIGINT (ids e COUNT) passa a chegar como número em vez de string.
// Os valores do sistema ficam muito abaixo de Number.MAX_SAFE_INTEGER.
types.setTypeParser(20, (value) => Number(value));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('neon.tech') || process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

// Estrutura original do sistema (mantida para instalações novas e compatibilidade).
const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS teams (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT DEFAULT '', active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS categories (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('religious','snack')),
    sort_order INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE(name, mode)
  );
  CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, code TEXT DEFAULT '', description TEXT DEFAULT '',
    mode TEXT NOT NULL CHECK (mode IN ('religious','snack')), category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
    image_url TEXT DEFAULT '', price_cents INTEGER NOT NULL CHECK (price_cents >= 0), available BOOLEAN NOT NULL DEFAULT TRUE,
    stock INTEGER, prep_minutes INTEGER, option_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS admins (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','operator','finance')), active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY, order_number TEXT NOT NULL UNIQUE, public_token TEXT NOT NULL UNIQUE,
    buyer_name TEXT NOT NULL, buyer_phone TEXT NOT NULL, team_id BIGINT REFERENCES teams(id) ON DELETE SET NULL,
    team_name TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('religious','snack')),
    items JSONB NOT NULL, subtotal_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_payment', payment_status TEXT NOT NULL DEFAULT 'awaiting_payment',
    payment_claimed_at TIMESTAMPTZ, paid_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decision_note TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS order_history (
    id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL, note TEXT DEFAULT '', actor TEXT NOT NULL DEFAULT 'system', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC);
  CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, payment_status);
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

// Cada migração roda uma única vez, dentro de transação, e fica registrada em schema_migrations.
// Nunca altere uma migração já publicada; crie outra.
const MIGRATIONS = [
  {
    id: '2026-10-001-modelo-operacional',
    async run(client) {
      await client.query(`
        -- Perfis: Administrador, Atendimento (operator), Financeiro e Cozinha.
        ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_role_check;
        ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('admin','operator','finance','kitchen'));
        ALTER TABLE admins ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        -- Produtos: campos de cadastro completos.
        ALTER TABLE products ADD COLUMN IF NOT EXISTS allow_notes BOOLEAN NOT NULL DEFAULT TRUE;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS custom_text_label TEXT NOT NULL DEFAULT '';
        ALTER TABLE products ADD COLUMN IF NOT EXISTS custom_text_required BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS admin_notes TEXT NOT NULL DEFAULT '';
        ALTER TABLE products ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE products ADD COLUMN IF NOT EXISTS seed_key TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS products_seed_key_idx ON products(seed_key) WHERE seed_key IS NOT NULL;
        ALTER TABLE products DROP CONSTRAINT IF EXISTS products_stock_check;
        ALTER TABLE products ADD CONSTRAINT products_stock_check CHECK (stock IS NULL OR stock >= 0);

        CREATE TABLE IF NOT EXISTS product_images (
          id BIGSERIAL PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL,
          created_by TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- Pedidos: modalidade de atendimento, produção separada do pagamento.
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS production_status TEXT;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_type TEXT NOT NULL DEFAULT 'pickup';
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'pix';
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee_cents INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT NOT NULL DEFAULT '';
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_reference TEXT NOT NULL DEFAULT '';
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_note TEXT NOT NULL DEFAULT '';
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_number TEXT NOT NULL DEFAULT '';
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_change_for_cents INTEGER;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_cents INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_cents INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS ticket_number INTEGER;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_request_id TEXT;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS production_started_at TIMESTAMPTZ;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS awaiting_pickup_at TIMESTAMPTZ;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT NOT NULL DEFAULT '';
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS restocked BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE orders ALTER COLUMN expires_at DROP NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS orders_client_request_idx ON orders(client_request_id) WHERE client_request_id IS NOT NULL;

        -- Histórico: tipo do evento, etapa anterior e responsável.
        ALTER TABLE order_history ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'order';
        ALTER TABLE order_history ADD COLUMN IF NOT EXISTS from_status TEXT;
        ALTER TABLE order_history ADD COLUMN IF NOT EXISTS actor_id BIGINT;
        CREATE INDEX IF NOT EXISTS order_history_order_idx ON order_history(order_id, created_at);
      `);

      // Converte os estados do modelo anterior (status misturava pagamento e preparo).
      await client.query(`
        UPDATE orders o SET
          production_started_at = (SELECT MIN(created_at) FROM order_history h WHERE h.order_id=o.id AND h.status='preparing'),
          ready_at = (SELECT MIN(created_at) FROM order_history h WHERE h.order_id=o.id AND h.status='ready'),
          finalized_at = (SELECT MIN(created_at) FROM order_history h WHERE h.order_id=o.id AND h.status='completed'),
          cancelled_at = CASE WHEN o.status='cancelled' THEN o.updated_at END
        WHERE o.production_status IS NULL;
        UPDATE orders SET production_status = CASE status
            WHEN 'preparing' THEN 'in_production' WHEN 'ready' THEN 'ready' WHEN 'completed' THEN 'finalized' ELSE 'new' END
          WHERE production_status IS NULL;
        UPDATE orders SET awaiting_pickup_at = ready_at WHERE production_status='finalized' AND awaiting_pickup_at IS NULL;
        ALTER TABLE orders ALTER COLUMN production_status SET DEFAULT 'new';
        ALTER TABLE orders ALTER COLUMN production_status SET NOT NULL;

        UPDATE orders SET status = CASE WHEN status IN ('cancelled','expired') OR payment_status IN ('cancelled','expired')
          THEN (CASE WHEN status='cancelled' OR payment_status='cancelled' THEN 'cancelled' ELSE 'expired' END) ELSE 'active' END;
        UPDATE orders SET payment_status = CASE payment_status WHEN 'confirmed' THEN 'confirmed' WHEN 'pending_review' THEN 'pending_review' ELSE 'awaiting_payment' END;
        ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'active';
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS cash_sessions (
          id BIGSERIAL PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
          opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), opened_by BIGINT REFERENCES admins(id), opened_by_name TEXT NOT NULL,
          opening_cash_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_cash_cents >= 0), opening_note TEXT NOT NULL DEFAULT '',
          closed_at TIMESTAMPTZ, closed_by BIGINT REFERENCES admins(id), closed_by_name TEXT, closing_note TEXT NOT NULL DEFAULT '',
          counted_cash_cents INTEGER, counted_pix_cents INTEGER, counted_debit_cents INTEGER, counted_credit_cents INTEGER,
          summary JSONB
        );
        CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_one_open_idx ON cash_sessions((status)) WHERE status='open';

        CREATE TABLE IF NOT EXISTS payments (
          id BIGSERIAL PRIMARY KEY,
          order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
          session_id BIGINT REFERENCES cash_sessions(id) ON DELETE RESTRICT,
          kind TEXT NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','refund')),
          method TEXT NOT NULL CHECK (method IN ('pix','cash','debit','credit')),
          amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
          tendered_cents INTEGER, change_cents INTEGER,
          status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','voided')),
          note TEXT NOT NULL DEFAULT '',
          idempotency_key TEXT UNIQUE,
          created_by BIGINT REFERENCES admins(id), created_by_name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          voided_at TIMESTAMPTZ, voided_by_name TEXT, void_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS payments_order_idx ON payments(order_id);
        CREATE INDEX IF NOT EXISTS payments_session_idx ON payments(session_id);
        CREATE INDEX IF NOT EXISTS payments_created_idx ON payments(created_at);

        CREATE TABLE IF NOT EXISTS cash_movements (
          id BIGSERIAL PRIMARY KEY,
          session_id BIGINT NOT NULL REFERENCES cash_sessions(id) ON DELETE RESTRICT,
          type TEXT NOT NULL CHECK (type IN ('withdrawal','supply')),
          amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
          reason TEXT NOT NULL,
          created_by BIGINT REFERENCES admins(id), created_by_name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS cash_adjustments (
          id BIGSERIAL PRIMARY KEY,
          session_id BIGINT NOT NULL REFERENCES cash_sessions(id) ON DELETE RESTRICT,
          method TEXT CHECK (method IN ('pix','cash','debit','credit')),
          amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
          reason TEXT NOT NULL,
          created_by BIGINT REFERENCES admins(id), created_by_name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS audit_log (
          id BIGSERIAL PRIMARY KEY, actor_id BIGINT, actor_name TEXT NOT NULL, action TEXT NOT NULL,
          entity TEXT NOT NULL, entity_id TEXT, details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // Pagamentos confirmados no modelo anterior viram registros de recebimento (PIX era a única forma).
      await client.query(`
        INSERT INTO payments(order_id,kind,method,amount_cents,note,created_by_name,created_at)
        SELECT o.id,'payment','pix',o.total_cents,'Recebimento migrado do sistema anterior',
          COALESCE((SELECT h.actor FROM order_history h WHERE h.order_id=o.id AND h.status='confirmed' ORDER BY h.created_at DESC LIMIT 1),'Sistema anterior'),
          COALESCE(o.paid_at,o.updated_at)
        FROM orders o
        WHERE o.payment_status='confirmed' AND o.total_cents > 0 AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id=o.id);
        UPDATE orders SET paid_cents=total_cents WHERE payment_status='confirmed';
      `);

      await client.query(`
        ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN ('active','cancelled','expired'));
        ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check CHECK (payment_status IN ('awaiting_payment','pending_review','partial','confirmed','refunded'));
        ALTER TABLE orders ADD CONSTRAINT orders_production_status_check CHECK (production_status IN ('new','in_production','ready','awaiting_pickup','finalized'));
        ALTER TABLE orders ADD CONSTRAINT orders_service_type_check CHECK (service_type IN ('dine_in','delivery','pickup'));
        ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('pix','cash','debit','credit'));
        ALTER TABLE orders ADD CONSTRAINT orders_amounts_check CHECK (paid_cents >= 0 AND refunded_cents >= 0 AND total_cents >= 0 AND delivery_fee_cents >= 0);
        CREATE INDEX IF NOT EXISTS orders_board_idx ON orders(mode, status, production_status, created_at);

        -- Proteções de integridade financeira aplicadas no próprio banco.
        CREATE OR REPLACE FUNCTION eag_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'Registros de auditoria e financeiros não podem ser apagados.' USING ERRCODE = 'P0001';
        END $fn$;

        CREATE OR REPLACE FUNCTION eag_guard_cash_rows() RETURNS trigger LANGUAGE plpgsql AS $fn$
        DECLARE st TEXT;
        BEGIN
          IF TG_OP = 'UPDATE' AND OLD.session_id IS NOT NULL THEN
            SELECT status INTO st FROM cash_sessions WHERE id = OLD.session_id;
            IF st = 'closed' THEN RAISE EXCEPTION 'Este registro pertence a um caixa fechado e não pode ser alterado.' USING ERRCODE = 'P0001'; END IF;
          END IF;
          IF NEW.session_id IS NOT NULL THEN
            SELECT status INTO st FROM cash_sessions WHERE id = NEW.session_id;
            IF st = 'closed' THEN RAISE EXCEPTION 'O caixa informado já está fechado.' USING ERRCODE = 'P0001'; END IF;
          END IF;
          RETURN NEW;
        END $fn$;

        CREATE OR REPLACE FUNCTION eag_guard_cash_session() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF OLD.status = 'closed' THEN
            RAISE EXCEPTION 'Caixa fechado não pode ser alterado. Registre um ajuste com justificativa.' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END $fn$;

        CREATE OR REPLACE FUNCTION eag_forbid_update() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'Registros de auditoria não podem ser alterados.' USING ERRCODE = 'P0001';
        END $fn$;

        DROP TRIGGER IF EXISTS payments_guard ON payments;
        CREATE TRIGGER payments_guard BEFORE INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION eag_guard_cash_rows();
        DROP TRIGGER IF EXISTS payments_no_delete ON payments;
        CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION eag_forbid_delete();

        DROP TRIGGER IF EXISTS cash_movements_guard ON cash_movements;
        CREATE TRIGGER cash_movements_guard BEFORE INSERT OR UPDATE ON cash_movements FOR EACH ROW EXECUTE FUNCTION eag_guard_cash_rows();
        DROP TRIGGER IF EXISTS cash_movements_no_delete ON cash_movements;
        CREATE TRIGGER cash_movements_no_delete BEFORE DELETE ON cash_movements FOR EACH ROW EXECUTE FUNCTION eag_forbid_delete();

        DROP TRIGGER IF EXISTS cash_sessions_guard ON cash_sessions;
        CREATE TRIGGER cash_sessions_guard BEFORE UPDATE ON cash_sessions FOR EACH ROW EXECUTE FUNCTION eag_guard_cash_session();
        DROP TRIGGER IF EXISTS cash_sessions_no_delete ON cash_sessions;
        CREATE TRIGGER cash_sessions_no_delete BEFORE DELETE ON cash_sessions FOR EACH ROW EXECUTE FUNCTION eag_forbid_delete();

        DROP TRIGGER IF EXISTS cash_adjustments_no_update ON cash_adjustments;
        CREATE TRIGGER cash_adjustments_no_update BEFORE UPDATE OR DELETE ON cash_adjustments FOR EACH ROW EXECUTE FUNCTION eag_forbid_update();

        DROP TRIGGER IF EXISTS order_history_no_update ON order_history;
        CREATE TRIGGER order_history_no_update BEFORE UPDATE OR DELETE ON order_history FOR EACH ROW EXECUTE FUNCTION eag_forbid_update();

        DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
        CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION eag_forbid_update();
      `);
    }
  },
  {
    // Produtos de demonstração da versão anterior (com fotos genéricas) saem dos catálogos.
    // Só são arquivados os registros que continuam idênticos ao exemplo original; nada é apagado.
    id: '2026-10-002-arquivar-demonstracao',
    async run(client) {
      const demos = [
        ['Bíblia Sagrada', 'religious', 'photo-1504052434569'],
        ['Devocional Graças', 'religious', 'photo-1507692049790'],
        ['Marcador de página', 'religious', 'photo-1519682337058'],
        ['Hambúrguer da casa', 'snack', 'photo-1568901346375'],
        ['Coxinha', 'snack', 'photo-1601050690597'],
        ['Suco natural', 'snack', 'photo-1600271886742']
      ];
      for (const [name, mode, image] of demos) {
        await client.query(
          `UPDATE products SET available=FALSE, archived=TRUE, admin_notes='Produto de demonstração da versão anterior, arquivado automaticamente.', updated_at=NOW()
           WHERE name=$1 AND mode=$2 AND image_url LIKE $3 AND seed_key IS NULL`,
          [name, mode, `%${image}%`]
        );
      }
      // Categorias de exemplo da lanchonete que ficaram sem produtos ativos.
      await client.query(`UPDATE categories c SET active=FALSE
        WHERE c.mode='snack' AND c.name IN ('Lanches','Salgados','Doces')
          AND NOT EXISTS (SELECT 1 FROM products p WHERE p.category_id=c.id AND p.archived=FALSE)`);
    }
  },
  {
    id: '2026-10-003-cardapio-la-em-gracas',
    async run(client) {
      for (const category of MENU_CATEGORIES) {
        await client.query(`INSERT INTO categories(name,mode,sort_order,active) VALUES($1,'snack',$2,TRUE)
          ON CONFLICT(name,mode) DO UPDATE SET active=TRUE, sort_order=EXCLUDED.sort_order`, [category.name, category.sort]);
      }
      let order = 0;
      for (const product of MENU_PRODUCTS) {
        order += 1;
        // Não duplica: ignora se já existir pela chave do cardápio ou pelo mesmo nome na lanchonete.
        await client.query(`INSERT INTO products(name,description,mode,category_id,price_cents,available,option_groups,needs_review,admin_notes,sort_order,seed_key,image_url)
          SELECT $1,$2,'snack',c.id,$3,TRUE,$4::jsonb,$5,$6,$7,$8,''
          FROM categories c WHERE c.name=$9 AND c.mode='snack'
            AND NOT EXISTS (SELECT 1 FROM products p WHERE p.seed_key=$8 OR (p.mode='snack' AND LOWER(p.name)=LOWER($1) AND p.archived=FALSE))`,
          [product.name, product.description || '', product.price, JSON.stringify(product.optionGroups || []), Boolean(product.review),
            product.review ? `Conferir: ${product.review}` : '', order, product.key, product.category]);
      }
    }
  },
  {
    id: '2026-10-004-fiado-balcao-fotos',
    async run(client) {
      await client.query(`
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS on_credit BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_at TIMESTAMPTZ;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_by_name TEXT;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_note TEXT NOT NULL DEFAULT '';
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'site';
        ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
        ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('pix','cash','debit','credit','fiado'));
        ALTER TABLE orders ADD CONSTRAINT orders_source_check CHECK (source IN ('site','balcao'));
        CREATE INDEX IF NOT EXISTS orders_credit_idx ON orders(on_credit, status, payment_status) WHERE on_credit;
      `);
      // Fotos ilustrativas (Unsplash) só nos itens do cardápio ainda sem imagem.
      for (const [key, image] of Object.entries(MENU_IMAGES)) {
        await client.query("UPDATE products SET image_url=$1, updated_at=NOW() WHERE seed_key=$2 AND COALESCE(image_url,'')=''", [image, key]);
      }
    }
  },
  {
    // Cobrança PIX gerada pelo Mercado Pago (QR Code dinâmico com confirmação automática).
    id: '2026-10-005-pix-mercado-pago',
    async run(client) {
      await client.query(`
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS mp_payment_id TEXT;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS mp_qr_code TEXT;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS mp_qr_base64 TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS orders_mp_payment_idx ON orders(mp_payment_id) WHERE mp_payment_id IS NOT NULL;
      `);
    }
  }
];

async function runMigrations(client) {
  for (const migration of MIGRATIONS) {
    const done = await client.query('SELECT 1 FROM schema_migrations WHERE id=$1', [migration.id]);
    if (done.rowCount) continue;
    await client.query('BEGIN');
    try {
      await migration.run(client);
      await client.query('INSERT INTO schema_migrations(id) VALUES($1)', [migration.id]);
      await client.query('COMMIT');
      console.log(`Migração aplicada: ${migration.id}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Falha na migração ${migration.id}: ${error.message}`);
    }
  }
}

export const DEFAULT_SETTINGS = {
  pix: {
    key: process.env.PAYMENT_PIX_KEY || '', type: process.env.PAYMENT_PIX_TYPE || 'Aleatória',
    beneficiary: process.env.PAYMENT_BENEFICIARY || 'EAG - Graças', city: process.env.PAYMENT_CITY || 'GRAÇAS',
    instructions: 'Faça o PIX e toque em “Já paguei” para solicitar a conferência. A confirmação depende da equipe financeira.'
  },
  payment_deadline_minutes: Number(process.env.PAYMENT_DEADLINE_MINUTES || 15),
  church_name: 'EAG — Encontro de Adolescentes Graças',
  payment_methods: { cash: true, debit: true, credit: true, fiado_self: false },
  service: {
    dine_in: true, delivery: true, pickup: true,
    delivery_fee_cents: MENU_DELIVERY_FEE_CENTS,
    tables_enabled: false, table_count: 0,
    delivery_instructions: 'Seu pedido sairá para entrega pela GRASFOOD assim que estiver pronto.',
    pickup_instructions: 'Retire seu pedido no balcão da lanchonete informando a senha.',
    dine_in_instructions: 'Quando o pedido estiver pronto, retire no balcão ou aguarde na sua mesa.'
  },
  kitchen: { require_pix_confirmation: true },
  contact: { phone: '' }
};

function sslFor(url) {
  return url.includes('neon.tech') || url.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined;
}

export async function initializeDatabase() {
  // Migrações usam conexão direta (sem pooler), necessária para o bloqueio consultivo de sessão.
  const direct = process.env.DATABASE_URL_UNPOOLED;
  const client = direct ? new pg.Client({ connectionString: direct, ssl: sslFor(direct) }) : await pool.connect();
  if (direct) await client.connect();
  try {
    // Evita que duas instâncias iniciando juntas apliquem migrações em paralelo.
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(BASE_SCHEMA);
    await runMigrations(client);

    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (adminEmail && adminPassword) {
      const exists = await client.query('SELECT 1 FROM admins WHERE email=LOWER($1)', [adminEmail]);
      if (!exists.rowCount) {
        const hash = await bcrypt.hash(adminPassword, 12);
        await client.query(`INSERT INTO admins(name,email,password_hash,role) VALUES($1,LOWER($2),$3,'admin') ON CONFLICT(email) DO NOTHING`,
          [process.env.ADMIN_NAME || 'Administrador', adminEmail, hash]);
      }
    }

    await client.query(`INSERT INTO teams(name) VALUES
      ('Louvor'),('Comunicação'),('Recepção'),('Intercessão'),('Infantil'),('Jovens'),('Organização'),('Visitante')
      ON CONFLICT(name) DO NOTHING`);

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await client.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING', [key, JSON.stringify(value)]);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    if (direct) await client.end().catch(() => {});
    else client.release();
  }
}

export async function readSettings(db = pool) {
  const { rows } = await db.query('SELECT key,value FROM settings');
  const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  // Mescla com os padrões para que chaves novas sempre existam.
  const merged = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    merged[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...value, ...(stored[key] || {}) } : (stored[key] ?? value);
  }
  return { ...stored, ...merged };
}
