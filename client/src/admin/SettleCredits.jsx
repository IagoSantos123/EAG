// Cobrança de fiado de uma pessoa: busca pelo nome, lista as comandas fiadas com nome parecido
// (marca as que batem com todas as palavras), mostra itens, data e valor, e dá baixa de uma vez.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Modal, useToast } from '../components/ui.jsx';
import { money, uuid } from '../lib/api.js';
import { useAdmin } from './context.js';
import { OpenCashInline, PaymentLines, hasCashLine, linesError, linesPayload, newPaymentLines, useRegisterMethods } from './shared.jsx';

// Palavras sem acento, minúsculas e sem conectivos curtos ("e", "da").
const words = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  .split(' ').filter((word) => word.length > 2);

// Mesma palavra tolerando abreviação ("Rodol" x "Rodolpho") e uma letra trocada ("Kamila" x "Camila").
function similar(a, b) {
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length] <= 1;
}

const when = (order) => {
  const date = new Date(order.createdAt);
  const day = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  // Pedidos passados do papel não têm horário real.
  return order.orderNumber.startsWith('PAPEL-') ? `${day} · anotado no papel` : `${day} às ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
};

export default function SettleCredits({ orders, initialName = '', onClose, onDone }) {
  const { call } = useAdmin();
  const toast = useToast();
  const methods = useRegisterMethods();
  const [name, setName] = useState(initialName);
  const [checked, setChecked] = useState({});
  const [lines, setLines] = useState(() => newPaymentLines(0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cashOpen, setCashOpen] = useState(true);
  const key = useRef(uuid());

  const checkCash = useCallback(() => call('/admin/cash-status').then((r) => setCashOpen(r.open)).catch(() => {}), [call]);
  useEffect(() => { checkCash(); }, [checkCash]);

  // Comandas com alguma palavra parecida com a busca; marcadas por padrão as que têm todas as palavras.
  const matches = useMemo(() => {
    const wanted = words(name);
    if (!wanted.length) return [];
    return orders.map((order) => {
      const have = words(order.buyerName);
      const hits = wanted.filter((w) => have.some((h) => similar(w, h)));
      return { order, hits: hits.length, full: hits.length === wanted.length };
    }).filter((m) => m.hits).sort((a, b) => Number(b.full) - Number(a.full) || new Date(a.order.createdAt) - new Date(b.order.createdAt));
  }, [orders, name]);
  // Mantém o que a pessoa já marcou/desmarcou (a lista recarrega sozinha); só comandas novas recebem o padrão.
  useEffect(() => {
    setChecked((current) => Object.fromEntries(matches.map((m) => [m.order.id, m.order.id in current ? current[m.order.id] : m.full])));
  }, [matches]);

  const selected = matches.filter((m) => checked[m.order.id]).map((m) => m.order);
  const totalCents = Math.round(selected.reduce((sum, order) => sum + order.balance, 0) * 100);
  // O valor da forma de pagamento acompanha o total enquanto houver uma forma só.
  useEffect(() => { setLines((current) => (current.length <= 1 ? newPaymentLines(totalCents, current[0]?.method || '') : current)); }, [totalCents]);
  const payMethods = methods.filter((method) => method !== 'fiado');
  const validation = !selected.length ? 'Marque ao menos uma comanda.' : linesError(lines, totalCents)
    || (hasCashLine(lines) && !cashOpen ? 'Abra o caixa para registrar o recebimento.' : '');

  const submit = async () => {
    if (validation) { setError(validation); return; }
    setBusy(true); setError('');
    try {
      const result = await call('/finance/credits/settle', { method: 'POST', body: { orderIds: selected.map((order) => order.id), idempotencyKey: key.current, lines: linesPayload(lines) } });
      toast(`Fiado recebido: ${result.count ?? selected.length} ${selected.length === 1 ? 'comanda' : 'comandas'}, ${money(result.total ?? totalCents / 100)}.${result.change > 0 ? ` Troco: ${money(result.change)}.` : ''}`);
      onDone?.();
      onClose();
    } catch (err) {
      if (err.code === 'NO_CASH_SESSION') { setCashOpen(false); setError(''); } else setError(err.message);
    } finally { setBusy(false); }
  };

  return <Modal title="Receber fiado" subtitle="Busque pelo nome e marque as comandas da pessoa" onClose={onClose} size="lg"
    footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn btn-primary" disabled={busy || Boolean(validation)} onClick={submit}>{busy ? 'Registrando...' : `Receber ${money(totalCents / 100)}`}</button>
    </>}>
    <label className="search-field settle-search"><Search size={16} /><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome de quem vai pagar (ex.: Rodolpho)" /></label>

    {!words(name).length ? <p className="muted">Digite o nome (pelo menos 3 letras).</p>
      : !matches.length ? <p className="alert alert-info">Nenhum fiado em aberto com esse nome.</p>
      : <ul className="settle-list">
        {matches.map(({ order, full }) => <li key={order.id} className={checked[order.id] ? 'on' : ''}>
          <label>
            <input type="checkbox" checked={Boolean(checked[order.id])} onChange={(e) => setChecked((current) => ({ ...current, [order.id]: e.target.checked }))} />
            <span className="settle-main">
              <b>#{order.ticket} · {order.buyerName}</b>{!full && <em className="settle-maybe">nome parecido</em>}
              <small>{order.teamName} · {when(order)}</small>
              <small className="settle-items">{order.items.map((item) => `${item.quantity}× ${item.name}${item.options.length ? ` (${item.options.map((o) => o.option).join(', ')})` : ''}`).join(' · ')}</small>
            </span>
            <b className="settle-value">{money(order.balance)}</b>
          </label>
        </li>)}
      </ul>}

    {matches.length > 0 && <>
      <div className="pay-summary">
        <div><span>Comandas marcadas</span><b>{selected.length} de {matches.length}</b></div>
        <div className="highlight"><span>Total a receber</span><b>{money(totalCents / 100)}</b></div>
      </div>
      {!cashOpen && hasCashLine(lines) && <OpenCashInline onOpened={checkCash} />}
      <PaymentLines lines={lines} setLines={setLines} methods={payMethods} totalCents={totalCents} />
    </>}
    {error && <p className="alert alert-error">{error}</p>}
  </Modal>;
}
