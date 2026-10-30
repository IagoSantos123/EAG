import React, { useCallback, useEffect, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { EmptyState, ErrorState, Spinner, useToast } from '../components/ui.jsx';
import { dateTime, download, money } from '../lib/api.js';
import { MODES, PAYMENT_STATUS, PRODUCTION_SHORT, PRODUCTION_STEPS, SERVICE_TYPES } from '../lib/labels.js';
import { useAdmin, useLiveRefresh } from './context.js';
import { OrderDetail, PaymentBadge, PeriodFilter, ServiceBadge, StatusBadge, usePeriod } from './shared.jsx';

export default function OrdersPage() {
  const { call, can, token } = useAdmin();
  const toast = useToast();
  const period = usePeriod('today');
  const [filters, setFilters] = useState({ q: '', status: '', production: '', payment: '', mode: '', service: '' });
  const [orders, setOrders] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);

  const query = `${period.query}&${new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString()}`;
  const load = useCallback(async () => {
    try {
      const [list, stats] = await Promise.all([call(`/admin/orders?${query}`), call('/admin/summary')]);
      setOrders(list); setSummary(stats); setError('');
    } catch (err) { setError(err.message); }
  }, [call, query]);
  useEffect(() => {
    // Pequeno atraso para não consultar a cada tecla digitada na busca.
    const timer = setTimeout(load, filters.q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, filters.q]);
  useLiveRefresh(load);

  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));
  const exportCsv = async () => {
    try { await download(`/admin/report.csv?${period.query}`, token, `pedidos-${period.from}-a-${period.to}.csv`); }
    catch (err) { toast(err.message, 'error'); }
  };

  return <div className="admin-page">
    <header className="admin-page-head">
      <div><h1>Pedidos</h1><p>Todos os pedidos da lanchonete e dos artigos religiosos.</p></div>
      {can('finance.view') && <button type="button" className="btn btn-outline btn-sm" onClick={exportCsv}><Download size={15} /> Exportar CSV</button>}
    </header>

    {summary && <div className="kpi-row">
      <div className="kpi"><span>Pedidos hoje</span><b>{summary.today}</b></div>
      <div className="kpi"><span>Novos (aguardando cozinha)</span><b>{summary.new_orders}</b></div>
      <div className="kpi"><span>Em produção</span><b>{summary.in_production}</b></div>
      <div className="kpi"><span>Prontos / aguardando retirada</span><b>{summary.ready}</b></div>
      <div className="kpi kpi-info"><span>PIX para conferir</span><b>{summary.pending_review}</b></div>
    </div>}

    <div className="filters-bar">
      <PeriodFilter period={period} />
      <label className="search-field"><Search size={16} /><input value={filters.q} onChange={set('q')} placeholder="Nº do pedido, senha, nome, equipe ou telefone" /></label>
      <select value={filters.mode} onChange={set('mode')} aria-label="Catálogo"><option value="">Todos os catálogos</option>{Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <select value={filters.service} onChange={set('service')} aria-label="Atendimento"><option value="">Todo atendimento</option>{Object.entries(SERVICE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <select value={filters.production} onChange={set('production')} aria-label="Etapa"><option value="">Todas as etapas</option>{PRODUCTION_STEPS.map((s) => <option key={s} value={s}>{PRODUCTION_SHORT[s]}</option>)}</select>
      <select value={filters.payment} onChange={set('payment')} aria-label="Pagamento"><option value="">Todo pagamento</option>{Object.entries(PAYMENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
      <select value={filters.status} onChange={set('status')} aria-label="Situação"><option value="">Toda situação</option><option value="active">Ativos</option><option value="cancelled">Cancelados</option><option value="expired">Expirados</option></select>
    </div>

    {error ? <ErrorState message={error} onRetry={load} /> : !orders ? <Spinner /> : orders.length === 0
      ? <EmptyState title="Nenhum pedido encontrado">Ajuste o período ou os filtros.</EmptyState>
      : <>
        <p className="muted small">{orders.length} {orders.length === 1 ? 'pedido' : 'pedidos'}{orders.length >= 500 ? ' (mostrando os 500 mais recentes)' : ''}</p>
        <div className="table-wrap">
          <table className="table orders-table">
            <thead><tr><th>Senha / pedido</th><th>Cliente</th><th>Atendimento</th><th>Total</th><th>Pagamento</th><th>Etapa</th></tr></thead>
            <tbody>{orders.map((order) => <tr key={order.id} onClick={() => setOpenId(order.id)} className="clickable" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(order.id); }}>
              <td><b className="ticket-inline">{order.ticket ? `#${order.ticket}` : 'Sem senha'}</b><small>{order.orderNumber} · {dateTime(order.createdAt)}</small></td>
              <td>{order.buyerName}<small>{order.teamName} · {MODES[order.mode]}</small></td>
              <td><ServiceBadge order={order} /></td>
              <td><b>{money(order.total)}</b>{order.balance > 0 && order.status === 'active' && <small>Em aberto {money(order.balance)}</small>}</td>
              <td><PaymentBadge order={order} /></td>
              <td><StatusBadge order={order} /></td>
            </tr>)}</tbody>
          </table>
        </div>
      </>}

    {openId && <OrderDetail orderId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
  </div>;
}
