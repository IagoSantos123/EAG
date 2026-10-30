// Utilitários HTTP compartilhados pelas rotas.
import { z } from 'zod';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const fail = (res, status, message, code) => res.status(status).json({ error: message, ...(code ? { code } : {}) });

// Valores monetários trafegam em reais na API e são armazenados em centavos inteiros.
export const toCents = (value) => Math.round(Number(value) * 100);
export const toMoney = (cents) => Number(cents || 0) / 100;

// IDs BIGSERIAL chegam do pg como string; normaliza para número.
export const toId = (value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Identificador inválido.');
  return id;
};

// Executa um bloco em transação, com ROLLBACK automático em qualquer erro.
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Mensagens padrão do zod (em inglês) são trocadas por um marcador; mensagens
// personalizadas declaradas nos schemas (em português) têm prioridade e chegam ao usuário.
const DEFAULT_MESSAGE = '__default__';
z.setErrorMap(() => ({ message: DEFAULT_MESSAGE }));

export function parse(schema, data, message = 'Dados inválidos.') {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues[0]?.message;
    throw new HttpError(400, detail && detail !== DEFAULT_MESSAGE ? detail : message);
  }
  return result.data;
}
