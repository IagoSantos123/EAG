// Autenticação (JWT) e matriz de permissões por perfil.
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { fail } from './http.js';

export const ROLES = {
  admin: 'Administrador',
  operator: 'Atendimento',
  finance: 'Financeiro',
  kitchen: 'Cozinha / Produção'
};

// Cada permissão lista os perfis autorizados. O backend é a autoridade final;
// o frontend usa a mesma lista apenas para esconder o que o usuário não pode usar.
export const PERMISSIONS = {
  'orders.view': ['admin', 'operator', 'finance', 'kitchen'],
  'orders.cancel': ['admin', 'operator', 'finance'],
  'orders.edit': ['admin', 'operator', 'finance'],
  'pos.sell': ['admin', 'operator', 'finance'],
  'payments.register': ['admin', 'operator', 'finance'],
  'credits.view': ['admin', 'operator', 'finance'],
  'credits.manage': ['admin', 'operator', 'finance', 'kitchen'],
  'kitchen.view': ['admin', 'kitchen', 'operator'],
  'kitchen.move': ['admin', 'kitchen', 'operator'],
  'finance.view': ['admin', 'finance'],
  'finance.payments': ['admin', 'finance'],
  'finance.refund': ['admin', 'finance'],
  'finance.cash': ['admin', 'finance'],
  'finance.adjust': ['admin'],
  'catalog.manage': ['admin'],
  'settings.manage': ['admin'],
  'users.manage': ['admin']
};

export const can = (role, permission) => Boolean(PERMISSIONS[permission]?.includes(role));
export const permissionsFor = (role) => Object.keys(PERMISSIONS).filter((permission) => can(role, permission));

const secret = () => process.env.JWT_SECRET;

export function signToken(user) {
  return jwt.sign({ id: Number(user.id), name: user.name, role: user.role }, secret(), { expiresIn: '12h' });
}

// Valida o token e confere no banco se o usuário continua ativo e com o mesmo perfil.
// Assim, desativar um usuário ou trocar seu perfil tem efeito imediato.
export function auth(permission) {
  return async (req, res, next) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return fail(res, 401, 'Autenticação necessária.');
    let payload;
    try { payload = jwt.verify(token, secret()); }
    catch { return fail(res, 401, 'Sessão expirada. Entre novamente.'); }
    try {
      const { rows } = await pool.query('SELECT id,name,email,role,active FROM admins WHERE id=$1', [payload.id]);
      const user = rows[0];
      if (!user || !user.active) return fail(res, 401, 'Usuário desativado. Procure o administrador.');
      if (permission && !can(user.role, permission)) return fail(res, 403, 'Seu perfil não tem acesso a esta área.');
      req.user = { id: Number(user.id), name: user.name, email: user.email, role: user.role };
      next();
    } catch (error) { next(error); }
  };
}
