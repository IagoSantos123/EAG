// Fiados: valores anotados no nome do cliente para cobrança posterior, e histórico das baixas.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, GitMerge, HandCoins, MessageCircle, Search, Users } from 'lucide-react';
import { EmptyState, ErrorState, Spinner } from '../components/ui.jsx';
import { dateTime, elapsed, money } from '../lib/api.js';
import { useAdmin, useLiveRefresh } from './context.js';
import { OrderDetail, PaymentDialog } from './shared.jsx';
import SettleCredits from './SettleCredits.jsx';
import ChargeSheet from './ChargeSheet.jsx';
import MergeNames, { suggestMerges } from './MergeNames.jsx';
import { buildCharge, chargesByPerson } from './cobranca.js';
import { personKey } from './nomes.js';

function whatsappLink(order) {
  let digits = order.buyerPhone.replace(/\D/g, '');
  if (digits.length <= 11) digits = `55${digits}`;
  const text = `Olá, ${order.buyerName.split(' ')[0]}! Aqui é da lanchonete Lá em Graças (EAG). Consta um fiado de ${money(order.balance)} referente ao pedido #${order.ticket ?? ''} (${order.orderNumber}). Quando puder, acerte no caixa ou por PIX. Obrigado!`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

// Agrupa pelo nome (sem acento, maiúsculas ou espaços extras), não pelo telefone: muitos fiados foram
// lançados com o telefone de enchimento (00) 00000-0000 e iam todos para a mesma pessoa.
const customerKey = (order) => personKey(order.buyerName);

export default function CreditsPage() {
  const { call, can } = useAdmin();
  const [tab, setTab] = useState('open');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [grouped, setGrouped] = useState('');
  const [paying, setPaying] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [settling, setSettling] = useState(null);
  const [settlingTeam, setSettlingTeam] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [merging, setMerging] = useState(null);
  const [picked, setPicked] = useState({});
  const now = Date.now();

  const load = useCallback(async () => {
    try { setData(await call(`/finance/credits?status=${tab === 'open' ? 'open' : 'settled'}`)); setError(''); }
    catch (err) { setError(err.message); }
  }, [call, tab]);
  useEffect(() => { setData(null); load(); }, [load]);
  useLiveRefresh(load);

  const orders = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.orders || []).filter((o) => !term || `${o.buyerName} ${o.buyerPhone} ${o.teamName} ${o.orderNumber} #${o.ticket}`.toLowerCase().includes(term));
  }, [data, search]);
  const customers = useMemo(() => {
    const map = new Map();
    for (const o of orders) {
      const key = customerKey(o);
      const entry = map.get(key) || { key, name: o.buyerName, phone: o.buyerPhone, team: o.teamName, total: 0, orders: [] };
      entry.total += o.balance; entry.orders.push(o);
      // Fica com um telefone de verdade, se alguma comanda da pessoa tiver.
      if (/^0*$/.test(entry.phone.replace(/\D/g, '')) && !/^0*$/.test(o.buyerPhone.replace(/\D/g, ''))) entry.phone = o.buyerPhone;
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [orders]);
  const teams = useMemo(() => {
    const map = new Map();
    for (const o of orders) {
      const entry = map.get(o.teamName) || { name: o.teamName, people: new Set(), count: 0, total: 0 };
      entry.people.add(customerKey(o)); entry.count += 1; entry.total += o.balance;
      map.set(o.teamName, entry);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [orders]);
  const suggestions = useMemo(() => suggestMerges(customers), [customers]);
  const pickedCustomers = customers.filter((c) => picked[c.key]);
  const teamCharges = (team) => setSheet({ title: `Fiados da equipe ${team}`, charges: chargesByPerson(orders.filter((o) => o.teamName === team)) });

  return <div className="admin-page">
    <header className="admin-page-head">
      <div><h1>Fiados</h1><p>Vendas anotadas no nome do cliente para pagar depois.</p></div>
      <div className="segmented">
        <button type="button" className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>Em aberto</button>
        <button type="button" className={tab === 'settled' ? 'active' : ''} onClick={() => setTab('settled')}>Baixados</button>
      </div>
    </header>

    {tab === 'open' && data?.summary && <div className="kpi-row">
      <div className="kpi kpi-warning"><span>Total a receber</span><b>{money(data.summary.total)}</b></div>
      <div className="kpi"><span>Pedidos no fiado</span><b>{data.summary.count}</b></div>
      <div className="kpi"><span>Clientes</span><b>{new Set(data.orders.map(customerKey)).size}</b></div>
    </div>}

    <div className="filters-bar">
      <label className="search-field"><Search size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nome, telefone, equipe ou pedido" /></label>
      {tab === 'open' && <div className="segmented">
        <button type="button" className={!grouped ? 'active' : ''} onClick={() => setGrouped('')}>Comandas</button>
        <button type="button" className={grouped === 'customer' ? 'active' : ''} onClick={() => setGrouped('customer')}>Por cliente</button>
        <button type="button" className={grouped === 'team' ? 'active' : ''} onClick={() => setGrouped('team')}>Por equipe</button>
      </div>}
      {tab === 'open' && can('payments.register') && <button type="button" className="btn btn-primary" onClick={() => setSettling(search.trim())}><HandCoins size={16} /> Receber fiado de uma pessoa</button>}
      {tab === 'open' && can('payments.register') && <button type="button" className="btn btn-outline" onClick={() => setSettlingTeam('')}><Users size={16} /> Receber fiado de uma equipe</button>}
      {tab === 'open' && can('credits.manage') && <button type="button" className="btn btn-outline" onClick={() => setMerging({ title: 'Nomes parecidos', groups: suggestions })}>
        <GitMerge size={16} /> Nomes parecidos{suggestions.length ? ` (${suggestions.length})` : ''}</button>}
    </div>

    {error ? <ErrorState message={error} onRetry={load} /> : !data ? <Spinner /> : orders.length === 0
      ? <EmptyState title={tab === 'open' ? 'Nenhum fiado em aberto' : 'Nenhuma baixa registrada'}>{tab === 'open' ? 'Para lançar um fiado, use a Venda no balcão ou finalize um pedido sem pagamento.' : null}</EmptyState>
      : grouped === 'team' && tab === 'open'
        ? <div className="table-wrap"><table className="table">
          <thead><tr><th>Equipe</th><th>Pessoas</th><th>Comandas</th><th>Total em aberto</th><th /></tr></thead>
          <tbody>{teams.map((t) => <tr key={t.name}>
            <td><b>{t.name}</b></td><td>{t.people.size}</td><td>{t.count}</td><td><b>{money(t.total)}</b></td>
            <td className="actions"><button type="button" className="btn btn-outline btn-sm" onClick={() => teamCharges(t.name)}><FileText size={15} /> Comandas</button>
              {can('payments.register') && <button type="button" className="btn btn-primary btn-sm" onClick={() => setSettlingTeam(t.name)}>Ver e receber</button>}</td>
          </tr>)}</tbody></table></div>
      : grouped === 'customer' && tab === 'open'
        ? <>{pickedCustomers.length > 0 && <div className="merge-bar">
          <span>{pickedCustomers.length} {pickedCustomers.length === 1 ? 'cliente selecionado' : 'clientes selecionados'}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked({})}>Limpar</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={pickedCustomers.length < 2} onClick={() => setMerging({ title: 'Juntar clientes', groups: [pickedCustomers] })}><GitMerge size={15} /> Juntar como uma pessoa</button>
        </div>}<div className="table-wrap"><table className="table">
          <thead><tr><th aria-label="Selecionar" /><th>Cliente</th><th>Telefone</th><th>Equipe</th><th>Pedidos</th><th>Total em aberto</th><th /></tr></thead>
          <tbody>{customers.map((c) => <tr key={c.key}>
            <td><input type="checkbox" aria-label={`Selecionar ${c.name}`} checked={Boolean(picked[c.key])} onChange={(e) => setPicked((current) => ({ ...current, [c.key]: e.target.checked }))} /></td>
            <td><b>{c.name}</b></td><td>{c.phone}</td><td>{c.team}</td>
            <td>{c.orders.map((o) => <button type="button" key={o.id} className="link-btn chip-link" onClick={() => setOpenId(o.id)}>#{o.ticket} {money(o.balance)}</button>)}</td>
            <td><b>{money(c.total)}</b></td>
            <td className="actions"><button type="button" className="btn btn-outline btn-sm" onClick={() => setSheet({ charges: [buildCharge(c.orders)] })}><FileText size={15} /> Comanda</button>
              <a className="btn btn-ghost btn-sm" href={whatsappLink({ ...c.orders[0], buyerPhone: c.phone, balance: c.total })} target="_blank" rel="noreferrer"><MessageCircle size={15} /> Cobrar</a>
              {can('payments.register') && <button type="button" className="btn btn-primary btn-sm" onClick={() => setSettling(c.name)}>Receber</button>}</td>
          </tr>)}</tbody></table></div></>
        : <div className="table-wrap"><table className="table">
          <thead><tr><th>Pedido</th><th>Cliente</th><th>Equipe</th><th>{tab === 'open' ? 'Anotado em' : 'Baixa em'}</th><th>{tab === 'open' ? 'Em aberto' : 'Valor'}</th><th /></tr></thead>
          <tbody>{orders.map((o) => <tr key={o.id}>
            <td><button type="button" className="link-btn" onClick={() => setOpenId(o.id)}>#{o.ticket}</button><small>{o.orderNumber}</small></td>
            <td><b>{o.buyerName}</b><small>{o.buyerPhone}</small></td>
            <td>{o.teamName}</td>
            <td>{tab === 'open' ? <>{dateTime(o.creditAt)}<small>há {elapsed(o.creditAt, now)} · por {o.creditBy}</small></> : dateTime(o.updatedAt)}</td>
            <td><b>{money(tab === 'open' ? o.balance : o.total)}</b></td>
            <td className="actions">{tab === 'open' && <>
              <a className="btn btn-ghost btn-sm" href={whatsappLink(o)} target="_blank" rel="noreferrer"><MessageCircle size={15} /> Cobrar</a>
              {can('payments.register') && <button type="button" className="btn btn-primary btn-sm" onClick={() => setPaying(o)}>Dar baixa</button>}
            </>}</td>
          </tr>)}</tbody></table></div>}

    {paying && <PaymentDialog order={paying} onClose={() => setPaying(null)} onDone={load} />}
    {settling !== null && data && <SettleCredits orders={tab === 'open' ? data.orders : []} initialName={settling} onClose={() => setSettling(null)} onDone={load} />}
    {settlingTeam !== null && data && <SettleCredits orders={tab === 'open' ? data.orders : []} initialTeam={settlingTeam} onClose={() => setSettlingTeam(null)} onDone={load} />}
    {sheet && <ChargeSheet charges={sheet.charges} title={sheet.title} onClose={() => setSheet(null)} />}
    {merging && <MergeNames groups={merging.groups} title={merging.title} onClose={() => setMerging(null)} onDone={() => { setPicked({}); load(); }} />}
    {openId && <OrderDetail orderId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
  </div>;
}
