// Fiados: valores anotados no nome do cliente para cobrança posterior, e histórico das baixas.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MessageCircle, Search } from 'lucide-react';
import { EmptyState, ErrorState, Spinner } from '../components/ui.jsx';
import { dateTime, elapsed, money } from '../lib/api.js';
import { useAdmin, useLiveRefresh } from './context.js';
import { OrderDetail, PaymentDialog } from './shared.jsx';

function whatsappLink(order) {
  let digits = order.buyerPhone.replace(/\D/g, '');
  if (digits.length <= 11) digits = `55${digits}`;
  const text = `Olá, ${order.buyerName.split(' ')[0]}! Aqui é da lanchonete Lá em Graças (EAG). Consta um fiado de ${money(order.balance)} referente ao pedido #${order.ticket ?? ''} (${order.orderNumber}). Quando puder, acerte no caixa ou por PIX. Obrigado!`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export default function CreditsPage() {
  const { call, can } = useAdmin();
  const [tab, setTab] = useState('open');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [grouped, setGrouped] = useState(false);
  const [paying, setPaying] = useState(null);
  const [openId, setOpenId] = useState(null);
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
      const key = o.buyerPhone.replace(/\D/g, '') || o.buyerName.toLowerCase();
      const entry = map.get(key) || { key, name: o.buyerName, phone: o.buyerPhone, team: o.teamName, total: 0, orders: [] };
      entry.total += o.balance; entry.orders.push(o);
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [orders]);

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
      <div className="kpi"><span>Clientes</span><b>{data.summary.customers}</b></div>
    </div>}

    <div className="filters-bar">
      <label className="search-field"><Search size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nome, telefone, equipe ou pedido" /></label>
      {tab === 'open' && <label className="check-line"><input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Agrupar por cliente</label>}
    </div>

    {error ? <ErrorState message={error} onRetry={load} /> : !data ? <Spinner /> : orders.length === 0
      ? <EmptyState title={tab === 'open' ? 'Nenhum fiado em aberto' : 'Nenhuma baixa registrada'}>{tab === 'open' ? 'Para lançar um fiado, use a Venda no balcão ou finalize um pedido sem pagamento.' : null}</EmptyState>
      : grouped && tab === 'open'
        ? <div className="table-wrap"><table className="table">
          <thead><tr><th>Cliente</th><th>Telefone</th><th>Equipe</th><th>Pedidos</th><th>Total em aberto</th><th /></tr></thead>
          <tbody>{customers.map((c) => <tr key={c.key}>
            <td><b>{c.name}</b></td><td>{c.phone}</td><td>{c.team}</td>
            <td>{c.orders.map((o) => <button type="button" key={o.id} className="link-btn chip-link" onClick={() => setOpenId(o.id)}>#{o.ticket} {money(o.balance)}</button>)}</td>
            <td><b>{money(c.total)}</b></td>
            <td className="actions"><a className="btn btn-outline btn-sm" href={whatsappLink({ ...c.orders[0], balance: c.total })} target="_blank" rel="noreferrer"><MessageCircle size={15} /> Cobrar</a></td>
          </tr>)}</tbody></table></div>
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
    {openId && <OrderDetail orderId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
  </div>;
}
