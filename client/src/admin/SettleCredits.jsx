// Cobrança de fiado de uma pessoa ou de uma equipe inteira. Por pessoa: busca pelo nome, lista as comandas
// fiadas com nome parecido (marca as que batem com todas as palavras). Por equipe: todas as comandas da equipe,
// agrupadas por pessoa com o subtotal de cada uma. Mostra itens, data e valor, e dá baixa de uma vez.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Modal, useToast } from '../components/ui.jsx';
import { money, uuid } from '../lib/api.js';
import { useAdmin } from './context.js';
import { personKey, similar, words } from './nomes.js';
import { OpenCashInline, PaymentLines, hasCashLine, linesError, linesPayload, newPaymentLines, useRegisterMethods } from './shared.jsx';

// Mesma pessoa mesmo com maiúsculas ou espaços diferentes ("amanda" e "Amanda ").
const orderPerson = (order) => personKey(order.buyerName);

const when = (order) => {
  const date = new Date(order.createdAt);
  const day = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  // Pedidos passados do papel não têm horário real.
  return order.orderNumber.startsWith('PAPEL-') ? `${day} · anotado no papel` : `${day} às ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
};

export default function SettleCredits({ orders, initialName = '', initialTeam = null, onClose, onDone }) {
  const { call } = useAdmin();
  const toast = useToast();
  const methods = useRegisterMethods();
  const [by, setBy] = useState(initialTeam != null ? 'team' : 'person');
  const [name, setName] = useState(initialName);
  const [team, setTeam] = useState(initialTeam || '');
  const [checked, setChecked] = useState({});
  const [lines, setLines] = useState(() => newPaymentLines(0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cashOpen, setCashOpen] = useState(true);
  const key = useRef(uuid());

  const checkCash = useCallback(() => call('/admin/cash-status').then((r) => setCashOpen(r.open)).catch(() => {}), [call]);
  useEffect(() => { checkCash(); }, [checkCash]);

  // Equipes com fiado em aberto, com quantidade e total, para escolher na cobrança por equipe.
  const teams = useMemo(() => {
    const map = new Map();
    for (const order of orders) {
      const entry = map.get(order.teamName) || { name: order.teamName, count: 0, total: 0 };
      entry.count += 1; entry.total += order.balance;
      map.set(order.teamName, entry);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [orders]);

  // Por equipe: todas as comandas da equipe, marcadas, em ordem de nome.
  // Por pessoa: comandas com alguma palavra parecida com a busca; marcadas por padrão as que têm todas as palavras.
  const matches = useMemo(() => {
    if (by === 'team') {
      return orders.filter((order) => team && order.teamName === team).map((order) => ({ order, hits: 1, full: true }))
        .sort((a, b) => orderPerson(a.order).localeCompare(orderPerson(b.order), 'pt-BR') || new Date(a.order.createdAt) - new Date(b.order.createdAt));
    }
    const wanted = words(name);
    if (!wanted.length) return [];
    return orders.map((order) => {
      const have = words(order.buyerName);
      const hits = wanted.filter((w) => have.some((h) => similar(w, h)));
      return { order, hits: hits.length, full: hits.length === wanted.length };
    }).filter((m) => m.hits).sort((a, b) => Number(b.full) - Number(a.full) || new Date(a.order.createdAt) - new Date(b.order.createdAt));
  }, [orders, name, by, team]);
  // Mantém o que a pessoa já marcou/desmarcou (a lista recarrega sozinha); só comandas novas recebem o padrão.
  useEffect(() => {
    setChecked((current) => Object.fromEntries(matches.map((m) => [m.order.id, m.order.id in current ? current[m.order.id] : m.full])));
  }, [matches]);

  // Subtotal de cada pessoa na lista da equipe (o que falta receber de cada uma).
  const personTotals = useMemo(() => {
    const totals = {};
    for (const { order } of matches) totals[orderPerson(order)] = (totals[orderPerson(order)] || 0) + order.balance;
    return totals;
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

  return <Modal title="Receber fiado" subtitle={by === 'team' ? 'Escolha a equipe e marque as comandas que vão ser pagas' : 'Busque pelo nome e marque as comandas da pessoa'} onClose={onClose} size="lg"
    footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn btn-primary" disabled={busy || Boolean(validation)} onClick={submit}>{busy ? 'Registrando...' : `Receber ${money(totalCents / 100)}`}</button>
    </>}>
    <div className="segmented full settle-by">
      <button type="button" className={by === 'person' ? 'active' : ''} onClick={() => setBy('person')}>Por pessoa</button>
      <button type="button" className={by === 'team' ? 'active' : ''} onClick={() => setBy('team')}>Por equipe</button>
    </div>
    {by === 'person'
      ? <label className="search-field settle-search"><Search size={16} /><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome de quem vai pagar (ex.: Rodolpho)" /></label>
      : <label className="field settle-search"><span>Equipe</span><select autoFocus value={team} onChange={(e) => setTeam(e.target.value)}>
        <option value="">Escolha a equipe</option>
        {teams.map((t) => <option key={t.name} value={t.name}>{t.name} · {t.count} {t.count === 1 ? 'comanda' : 'comandas'} · {money(t.total)}</option>)}
      </select></label>}

    {by === 'person' && !words(name).length ? <p className="muted">Digite o nome (pelo menos 3 letras).</p>
      : by === 'team' && !team ? <p className="muted">Escolha a equipe para ver os fiados dela.</p>
      : !matches.length ? <p className="alert alert-info">{by === 'team' ? 'Essa equipe não tem fiado em aberto.' : 'Nenhum fiado em aberto com esse nome.'}</p>
      : <ul className="settle-list">
        {matches.map(({ order, full }, index) => <React.Fragment key={order.id}>
          {by === 'team' && orderPerson(order) !== (matches[index - 1] && orderPerson(matches[index - 1].order))
            && <li className="settle-person"><b>{order.buyerName}</b><span>{money(personTotals[orderPerson(order)])}</span></li>}
          <li className={checked[order.id] ? 'on' : ''}>
          <label>
            <input type="checkbox" checked={Boolean(checked[order.id])} onChange={(e) => setChecked((current) => ({ ...current, [order.id]: e.target.checked }))} />
            <span className="settle-main">
              <b>#{order.ticket} · {order.buyerName}</b>{!full && <em className="settle-maybe">nome parecido</em>}
              <small>{order.teamName} · {when(order)}</small>
              {order.orderNote && <small className="settle-note">Obs.: {order.orderNote}</small>}
              <small className="settle-items">{order.items.map((item) => `${item.quantity}× ${item.name}${item.options.length ? ` (${item.options.map((o) => o.option).join(', ')})` : ''}`).join(' · ')}</small>
            </span>
            <b className="settle-value">{money(order.balance)}</b>
          </label>
        </li></React.Fragment>)}
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
