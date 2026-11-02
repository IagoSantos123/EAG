import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownCircle, ArrowUpCircle, Banknote, CheckCircle2, CreditCard, Download, Info, Lock, Printer, QrCode, Trophy, Unlock } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Field, Modal, MoneyInput, Spinner, useConfirm, useNow, useToast } from '../components/ui.jsx';
import { dateTime, download, elapsed, fullDateTime, money, moneyCents, parseMoney, time } from '../lib/api.js';
import { MODES, PAYMENT_METHODS, SERVICE_TYPES } from '../lib/labels.js';
import { useAdmin, useLiveRefresh } from './context.js';
import { OpenCashInline, OrderDetail, PaymentBadge, PaymentDialog, PeriodFilter, ServiceBadge, usePeriod } from './shared.jsx';
import ShareSheet from './ShareSheet.jsx';
import { buildRanking, periodLabel, rankingImages, rankingText } from './ranking.js';

// Relação dos mais vendidos do período, em imagem e texto para divulgar.
function RankingSheet({ rows, from, to, onClose }) {
  const sections = useMemo(() => buildRanking(rows), [rows]);
  const period = periodLabel(from, to);
  const makeImages = useCallback(() => rankingImages(sections, { period }), [sections, period]);
  const count = sections.reduce((sum, s) => sum + s.items.length, 0);
  return <ShareSheet title="Itens mais vendidos" fileBase={`mais-vendidos-${period}`} subtitle={`${period} · ${count} produtos`}
    text={rankingText(sections, { period })} makeImages={makeImages} onClose={onClose} />;
}

const METHOD_ICONS = { pix: QrCode, cash: Banknote, debit: CreditCard, credit: CreditCard };
const METHOD_ORDER = ['pix', 'cash', 'debit', 'credit'];
const SUBTABS = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'receive', label: 'Receber e conferir' },
  { id: 'cash', label: 'Caixa' },
  { id: 'history', label: 'Fechamentos' },
  { id: 'entries', label: 'Lançamentos' }
];

function Kpi({ label, value, help, tone }) {
  return <div className={`kpi ${tone ? `kpi-${tone}` : ''}`}><span>{label}</span><b>{value}</b>{help && <small>{help}</small>}</div>;
}

function Diff({ cents }) {
  if (cents == null) return <span className="muted">não conferido</span>;
  if (cents === 0) return <span className="diff ok">Sem diferença</span>;
  return <span className={`diff ${cents > 0 ? 'over' : 'under'}`}>{cents > 0 ? 'Sobra de ' : 'Falta de '}{moneyCents(Math.abs(cents))}</span>;
}

// ---------- Visão geral ----------

function Overview() {
  const { call } = useAdmin();
  const period = usePeriod('today');
  const [filters, setFilters] = useState({ service: '', mode: '', method: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [ranking, setRanking] = useState(false);
  const query = `${period.query}&${new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString()}`;
  const load = useCallback(async () => {
    try { setData(await call(`/finance/summary?${query}`)); setError(''); } catch (err) { setError(err.message); }
  }, [call, query]);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh(load);
  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));

  return <>
    <div className="filters-bar">
      <PeriodFilter period={period} />
      <select value={filters.service} onChange={set('service')} aria-label="Atendimento"><option value="">Todo atendimento</option>{Object.entries(SERVICE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <select value={filters.mode} onChange={set('mode')} aria-label="Catálogo"><option value="">Todos os catálogos</option>{Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <select value={filters.method} onChange={set('method')} aria-label="Forma de pagamento"><option value="">Todas as formas</option>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
    </div>
    {error ? <ErrorState message={error} onRetry={load} /> : !data ? <Spinner /> : <>
      <h3 className="section-title">Pedidos <small>(pela data do pedido)</small></h3>
      <div className="kpi-row">
        <Kpi label="Pedidos no período" value={data.orders.total} help="Todos os pedidos criados, inclusive cancelados e expirados." />
        <Kpi label="Pagos" value={data.orders.paid} tone="success" help="Pedidos ativos com pagamento confirmado pela equipe." />
        <Kpi label="Pendentes" value={data.orders.pending} tone="warning" help={`Ativos sem pagamento completo. ${data.orders.pix_review} com PIX em conferência.`} />
        <Kpi label="Cancelados" value={data.orders.cancelled} tone="danger" help="Não contam como venda." />
        <Kpi label="Expirados" value={data.orders.expired} help="PIX não pago no prazo. Não contam como venda." />
      </div>
      <h3 className="section-title">Valores</h3>
      <div className="kpi-row">
        <Kpi label="Vendas registradas" value={money(data.orders.sales)} help="Soma dos pedidos ativos do período. Não significa que o dinheiro já entrou." />
        <Kpi label="Recebido (líquido)" value={money(data.received.net)} tone="success" help={`Recebimentos confirmados pela equipe no período (pela data do recebimento), menos estornos de ${money(data.received.refunded)}.`} />
        <Kpi label="A receber" value={money(data.orders.pendingAmount)} tone="warning" help="Valor em aberto dos pedidos ativos do período (inclui fiados). Não entra no recebido." />
        <Kpi label="Fiado em aberto" value={money(data.credits.total)} help={`${data.credits.count} pedido(s) anotados, de todos os períodos. Veja a aba Fiados.`} />
      </div>

      <div className="grid-2 gap-lg">
        <section className="panel">
          <h3>Recebido por forma de pagamento</h3>
          <table className="table compact"><thead><tr><th>Forma</th><th>Lançamentos</th><th>Recebido</th><th>Estornos</th><th>Líquido</th></tr></thead>
            <tbody>{METHOD_ORDER.map((method) => { const m = data.methods[method]; const Icon = METHOD_ICONS[method]; return <tr key={method}>
              <td><Icon size={15} /> {PAYMENT_METHODS[method]}</td><td>{m.count}</td><td>{money(m.received)}</td><td>{m.refunded ? `−${money(m.refunded)}` : '—'}</td><td><b>{money(m.net)}</b></td></tr>; })}</tbody>
            <tfoot><tr><td>Total</td><td /><td>{money(data.received.gross)}</td><td>{data.received.refunded ? `−${money(data.received.refunded)}` : '—'}</td><td><b>{money(data.received.net)}</b></td></tr></tfoot>
          </table>
          <p className="muted small">Cartão: valores registrados no caixa, sem confirmação de liquidação bancária.</p>
        </section>
        <section className="panel">
          <h3>Por modalidade de atendimento</h3>
          <table className="table compact"><thead><tr><th>Modalidade</th><th>Pedidos</th><th>Vendas</th><th>Recebido</th></tr></thead>
            <tbody>{data.byService.map((row) => <tr key={row.serviceType}><td>{SERVICE_TYPES[row.serviceType]}</td><td>{row.orders}</td><td>{money(row.sales)}</td><td>{money(row.received)}</td></tr>)}</tbody>
          </table>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h3>Vendas por produto <small className="muted">(pedidos ativos)</small></h3>
          {data.byProduct.length > 0 && <button type="button" className="btn btn-outline btn-sm" onClick={() => setRanking(true)}><Trophy size={15} /> Relação dos mais vendidos</button>}
        </div>
        {data.byProduct.length === 0 ? <p className="muted">Sem vendas no período.</p>
          : <table className="table compact"><thead><tr><th>Produto</th><th>Categoria</th><th>Qtd.</th><th>Total</th></tr></thead>
            <tbody>{data.byProduct.map((row) => <tr key={`${row.name}-${row.mode}-${row.category}`}><td>{row.name}</td><td>{row.category}</td><td>{row.quantity}</td><td>{money(row.total)}</td></tr>)}</tbody></table>}
      </section>
      {ranking && <RankingSheet rows={data.byProduct} from={period.from} to={period.to} onClose={() => setRanking(false)} />}
    </>}
  </>;
}

// ---------- Receber e conferir ----------

function Receive({ cashOpen, goToCash }) {
  const { call } = useAdmin();
  const confirm = useConfirm();
  const toast = useToast();
  const now = useNow(30000);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(null);
  const [openId, setOpenId] = useState(null);
  const load = useCallback(async () => {
    try { setData(await call('/finance/queue')); setError(''); } catch (err) { setError(err.message); }
  }, [call]);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh(load);

  const reject = async (order) => {
    const reason = await confirm({ title: `PIX não localizado · #${order.ticket}`, danger: true, confirmLabel: 'Registrar',
      message: 'O pedido volta para "Aguardando pagamento". Se o prazo do PIX já terminou, ele expira.', input: { label: 'Motivo', placeholder: 'Ex.: valor não consta no extrato' } });
    if (!reason) return;
    try { await call(`/finance/orders/${order.id}/reject-claim`, { method: 'POST', body: { reason } }); toast('Registrado.'); load(); }
    catch (err) { toast(err.message, 'error'); }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <Spinner />;
  return <>
    {!cashOpen && <OpenCashInline onOpened={goToCash} />}
    <section className="panel">
      <h3><QrCode size={18} /> PIX aguardando conferência <Badge tone="info">{data.review.length}</Badge></h3>
      <p className="muted small">O comprador tocou em "Já paguei". Confira no extrato da conta antes de confirmar — o aviso do comprador não é recebimento.</p>
      {data.review.length === 0 ? <p className="muted">Nenhum PIX para conferir agora.</p>
        : <div className="table-wrap"><table className="table">
          <thead><tr><th>Senha / pedido</th><th>Cliente</th><th>Valor</th><th>Avisou às</th><th /></tr></thead>
          <tbody>{data.review.map((order) => <tr key={order.id}>
            <td><button type="button" className="link-btn" onClick={() => setOpenId(order.id)}><b>#{order.ticket}</b></button><small>{order.orderNumber}</small></td>
            <td>{order.buyerName}<small>{order.teamName}</small></td>
            <td><b>{money(order.balance)}</b>{order.status === 'expired' && <small>Pedido expirado</small>}</td>
            <td>{time(order.paymentClaimedAt)}<small>há {elapsed(order.paymentClaimedAt, now)}</small></td>
            <td className="actions"><button type="button" className="btn btn-sm btn-primary" onClick={() => setPaying(order)}>Confirmar recebimento</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => reject(order)}>Não localizado</button></td>
          </tr>)}</tbody></table></div>}
    </section>
    <section className="panel">
      <h3><Banknote size={18} /> Pedidos aguardando pagamento <Badge tone="warning">{data.unpaid.length}</Badge></h3>
      <p className="muted small">Pedidos ativos dos últimos 3 dias sem pagamento completo. Use para receber no caixa (dinheiro, cartão ou PIX conferido).</p>
      {data.unpaid.length === 0 ? <p className="muted">Nenhum pedido pendente.</p>
        : <div className="table-wrap"><table className="table">
          <thead><tr><th>Senha / pedido</th><th>Cliente</th><th>Atendimento</th><th>Forma escolhida</th><th>Em aberto</th><th /></tr></thead>
          <tbody>{data.unpaid.map((order) => <tr key={order.id}>
            <td><button type="button" className="link-btn" onClick={() => setOpenId(order.id)}><b>#{order.ticket}</b></button><small>{order.orderNumber} · {dateTime(order.createdAt)}</small></td>
            <td>{order.buyerName}<small>{order.teamName}</small></td>
            <td><ServiceBadge order={order} /></td>
            <td>{PAYMENT_METHODS[order.paymentMethod]}{order.cashChangeFor ? <small>Troco p/ {money(order.cashChangeFor)}</small> : null}</td>
            <td><b>{money(order.balance)}</b><PaymentBadge order={order} /></td>
            <td className="actions"><button type="button" className="btn btn-sm btn-primary" onClick={() => setPaying(order)}>Receber</button></td>
          </tr>)}</tbody></table></div>}
    </section>
    {paying && <PaymentDialog order={paying} onClose={() => setPaying(null)} onDone={load} />}
    {openId && <OrderDetail orderId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
  </>;
}

// ---------- Resumo de caixa (usado no caixa aberto, no fechamento e no histórico) ----------

function SessionSummary({ summary, counted, differences }) {
  const s = summary;
  return <div className="session-summary">
    <div className="kpi-row">
      <Kpi label="Pedidos no período do caixa" value={s.orders.total} help={`${s.orders.paid} pagos · ${s.orders.pending} pendentes · ${s.orders.cancelled} cancelados`} />
      <Kpi label="Pedidos com recebimento neste caixa" value={s.paidOrders} />
      <Kpi label="Total recebido (líquido)" value={moneyCents(s.net)} tone="success" help={s.refunded ? `Inclui estornos de ${moneyCents(s.refunded)}` : 'Sem estornos'} />
      <Kpi label="Pendente de pagamento" value={moneyCents(s.orders.pending_cents)} tone="warning" help="Pedidos ativos sem pagamento completo. Não entram no total recebido." />
    </div>

    <table className="table compact"><thead><tr><th>Forma</th><th>Pedidos</th><th>Recebido</th><th>Estornos</th><th>Líquido</th>{counted && <th>Conferido</th>}{differences && <th>Diferença</th>}</tr></thead>
      <tbody>{METHOD_ORDER.map((method) => { const m = s.methods[method]; return <tr key={method}>
        <td>{PAYMENT_METHODS[method]}</td><td>{m.orders}</td><td>{moneyCents(m.received)}</td><td>{m.refunded ? `−${moneyCents(m.refunded)}` : '—'}</td><td><b>{moneyCents(m.net)}</b></td>
        {counted && <td>{method === 'cash' ? '—' : counted[method] == null ? <span className="muted">—</span> : moneyCents(counted[method])}</td>}
        {differences && <td>{method === 'cash' ? '—' : <Diff cents={differences[method]} />}</td>}
      </tr>; })}</tbody>
    </table>

    <div className="grid-2 gap-lg">
      <section className="panel soft">
        <h4><Banknote size={16} /> Dinheiro no caixa</h4>
        <div className="calc">
          <div><span>Valor inicial (troco)</span><b>{moneyCents(s.openingCash)}</b></div>
          <div><span>+ Vendas em dinheiro</span><b>{moneyCents(s.methods.cash.received)}</b></div>
          {s.methods.cash.refunded > 0 && <div><span>− Estornos em dinheiro</span><b>{moneyCents(s.methods.cash.refunded)}</b></div>}
          <div><span>− Sangrias</span><b>{moneyCents(s.withdrawals)}</b></div>
          <div><span>+ Suprimentos</span><b>{moneyCents(s.supplies)}</b></div>
          <div className="calc-total"><span>= Esperado no caixa</span><b>{moneyCents(s.expectedCash)}</b></div>
          {counted && <div><span>Contado</span><b>{moneyCents(counted.cash)}</b></div>}
          {differences && <div><span>Diferença</span><Diff cents={differences.cash} /></div>}
        </div>
        <p className="muted small">O valor inicial não entra no faturamento.</p>
      </section>
      <section className="panel soft">
        <h4><QrCode size={16} /> Conferência do PIX</h4>
        <div className="calc">
          <div><span>Pedidos pagos via PIX</span><b>{s.methods.pix.orders}</b></div>
          <div><span>Recebimentos PIX confirmados</span><b>{moneyCents(s.methods.pix.net)}</b></div>
          {counted && <div><span>Conferido no extrato</span><b>{counted.pix == null ? '—' : moneyCents(counted.pix)}</b></div>}
          {differences && <div><span>Diferença</span><Diff cents={differences.pix} /></div>}
          <div><span>Aguardando conferência</span><b>{s.pixPending.length} ({moneyCents(s.pixPending.reduce((sum, p) => sum + p.totalCents, 0))})</b></div>
        </div>
        <p className="muted small">Sem integração bancária: compare manualmente com o extrato da chave PIX. PIX em conferência não entra no total.</p>
      </section>
    </div>
    <section className="panel soft">
      <h4><CreditCard size={16} /> Cartão</h4>
      <p>Débito: <b>{moneyCents(s.methods.debit.net)}</b> ({s.methods.debit.count} lançamentos) · Crédito: <b>{moneyCents(s.methods.credit.net)}</b> ({s.methods.credit.count} lançamentos)</p>
      <p className="muted small">Vendas registradas em cartão. Não indicam que o valor já foi liquidado na conta bancária.</p>
    </section>
    {s.voided?.count > 0 && <p className="muted small">{s.voided.count} lançamento(s) anulado(s) neste caixa, somando {moneyCents(s.voided.cents)} (não contabilizados).</p>}
  </div>;
}

function PaymentsTable({ payments }) {
  if (!payments?.length) return <p className="muted">Nenhum lançamento.</p>;
  return <div className="table-wrap"><table className="table compact">
    <thead><tr><th>Hora</th><th>Pedido</th><th>Tipo</th><th>Forma</th><th>Valor</th><th>Responsável</th></tr></thead>
    <tbody>{payments.map((p) => <tr key={p.id} className={p.status === 'voided' ? 'row-voided' : ''}>
      <td>{dateTime(p.createdAt)}</td><td>#{p.ticket} <small>{p.orderNumber}</small></td>
      <td>{p.kind === 'refund' ? 'Estorno' : 'Recebimento'}{p.status === 'voided' && <small>Anulado: {p.voidReason}</small>}</td>
      <td>{PAYMENT_METHODS[p.method]}</td><td>{p.kind === 'refund' ? '−' : ''}{money(p.amount)}</td><td>{p.createdBy}</td>
    </tr>)}</tbody></table></div>;
}

// ---------- Caixa ----------

function CloseDialog({ session, summary, onClose, onDone }) {
  const { call } = useAdmin();
  const confirm = useConfirm();
  const toast = useToast();
  const [form, setForm] = useState({ cash: '', pix: '', debit: '', credit: '', note: '' });
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cents = (text) => (text === '' ? null : Math.round(parseMoney(text) * 100));
  const counted = { cash: cents(form.cash), pix: cents(form.pix), debit: cents(form.debit), credit: cents(form.credit) };
  const invalid = Object.values(counted).some((v) => v != null && (Number.isNaN(v) || v < 0)) || counted.cash == null;
  const differences = {
    cash: counted.cash == null || Number.isNaN(counted.cash) ? null : counted.cash - summary.expectedCash,
    pix: counted.pix == null || Number.isNaN(counted.pix) ? null : counted.pix - summary.methods.pix.net,
    debit: counted.debit == null || Number.isNaN(counted.debit) ? null : counted.debit - summary.methods.debit.net,
    credit: counted.credit == null || Number.isNaN(counted.credit) ? null : counted.credit - summary.methods.credit.net
  };
  const submit = async () => {
    const ok = await confirm({ title: 'Fechar o caixa agora?', confirmLabel: 'Fechar caixa', danger: true,
      message: <>Depois de fechado, os valores ficam registrados e <b>não podem ser alterados</b>. Correções posteriores só por ajuste do administrador, com justificativa.</> });
    if (!ok) return;
    setBusy(true); setError('');
    try {
      await call('/finance/cash/close', { method: 'POST', body: { sessionId: session.id, countedCash: counted.cash / 100,
        countedPix: counted.pix == null ? null : counted.pix / 100, countedDebit: counted.debit == null ? null : counted.debit / 100,
        countedCredit: counted.credit == null ? null : counted.credit / 100, note: form.note, confirm: true } });
      toast('Caixa fechado. O resumo está em Fechamentos.');
      onDone();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  return <Modal title="Fechar caixa" subtitle={`Aberto por ${session.openedBy} em ${fullDateTime(session.openedAt)}`} size="lg" onClose={onClose}
    footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Voltar</button>
      <button type="button" className="btn btn-danger" disabled={busy || invalid || !checked} onClick={submit}><Lock size={16} /> {busy ? 'Fechando...' : 'Fechar caixa'}</button></>}>
    <p className="alert alert-info"><Info size={17} /> Revise o resumo, conte o dinheiro físico e informe os valores conferidos. Os campos de PIX e cartão são opcionais (extrato e relatório da maquininha).</p>
    <SessionSummary summary={summary} counted={counted} differences={differences} />
    <div className="grid-2">
      <Field label="Dinheiro contado no caixa *" hint={`Esperado: ${moneyCents(summary.expectedCash)}`}><MoneyInput value={form.cash} onChange={set('cash')} /></Field>
      <Field label="PIX conferido no extrato" hint={`Registrado: ${moneyCents(summary.methods.pix.net)}`}><MoneyInput value={form.pix} onChange={set('pix')} /></Field>
      <Field label="Débito (relatório da maquininha)" hint={`Registrado: ${moneyCents(summary.methods.debit.net)}`}><MoneyInput value={form.debit} onChange={set('debit')} /></Field>
      <Field label="Crédito (relatório da maquininha)" hint={`Registrado: ${moneyCents(summary.methods.credit.net)}`}><MoneyInput value={form.credit} onChange={set('credit')} /></Field>
    </div>
    <Field label="Observações do fechamento"><textarea rows={2} maxLength={1000} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
    <label className="check-line"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> Conferi os valores e sou responsável por este fechamento.</label>
    {error && <p className="alert alert-error">{error}</p>}
  </Modal>;
}

function CashTab({ onChanged }) {
  const { call, can } = useAdmin();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState({ cash: '', note: '' });
  const [movement, setMovement] = useState({ type: 'withdrawal', amount: '', reason: '' });
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setData(await call('/finance/cash')); setError(''); } catch (err) { setError(err.message); }
  }, [call]);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh(load);

  const open = async (event) => {
    event.preventDefault();
    const value = opening.cash === '' ? 0 : parseMoney(opening.cash);
    if (Number.isNaN(value) || value < 0) { toast('Valor inicial inválido.', 'error'); return; }
    setBusy(true);
    try { await call('/finance/cash/open', { method: 'POST', body: { openingCash: value, note: opening.note } }); toast('Caixa aberto.'); setOpening({ cash: '', note: '' }); load(); onChanged(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const addMovement = async (event) => {
    event.preventDefault();
    const value = parseMoney(movement.amount);
    if (Number.isNaN(value) || value <= 0) { toast('Informe um valor maior que zero.', 'error'); return; }
    if (movement.reason.trim().length < 3) { toast('Informe o motivo.', 'error'); return; }
    setBusy(true);
    try { await call('/finance/cash/movements', { method: 'POST', body: { type: movement.type, amount: value, reason: movement.reason } }); toast(movement.type === 'withdrawal' ? 'Sangria registrada.' : 'Suprimento registrado.'); setMovement({ ...movement, amount: '', reason: '' }); load(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <Spinner />;
  if (!data.session) return <section className="panel narrow-panel">
    <h3><Unlock size={18} /> Abrir caixa</h3>
    <p className="muted">Nenhum caixa aberto. Recebimentos só podem ser registrados com o caixa aberto.</p>
    {can('finance.cash') ? <form onSubmit={open} className="stack">
      <Field label="Valor inicial em dinheiro (troco)" hint="Não entra no faturamento."><MoneyInput value={opening.cash} onChange={(v) => setOpening({ ...opening, cash: v })} /></Field>
      <Field label="Observações (opcional)"><input value={opening.note} maxLength={300} onChange={(e) => setOpening({ ...opening, note: e.target.value })} /></Field>
      <button className="btn btn-primary" disabled={busy}>Abrir caixa</button>
    </form> : <p className="alert alert-info">Seu perfil não pode abrir o caixa.</p>}
  </section>;

  const { session, summary } = data;
  return <>
    <section className="panel cash-head">
      <div><Badge tone="success" icon={<Unlock size={13} />}>Caixa aberto</Badge>
        <p>Aberto por <b>{session.openedBy}</b> em {fullDateTime(session.openedAt)} · Valor inicial {money(session.openingCash)}{session.openingNote ? ` · ${session.openingNote}` : ''}</p></div>
      {can('finance.cash') && <button type="button" className="btn btn-danger" onClick={() => setClosing(true)}><Lock size={16} /> Fechar caixa</button>}
    </section>
    <SessionSummary summary={summary} />
    <div className="grid-2 gap-lg">
      <section className="panel">
        <h3>Sangria e suprimento</h3>
        {can('finance.cash') && <form onSubmit={addMovement} className="movement-form">
          <div className="segmented">
            <button type="button" className={movement.type === 'withdrawal' ? 'active' : ''} onClick={() => setMovement({ ...movement, type: 'withdrawal' })}><ArrowUpCircle size={15} /> Sangria (retirada)</button>
            <button type="button" className={movement.type === 'supply' ? 'active' : ''} onClick={() => setMovement({ ...movement, type: 'supply' })}><ArrowDownCircle size={15} /> Suprimento (entrada)</button>
          </div>
          <MoneyInput value={movement.amount} onChange={(v) => setMovement({ ...movement, amount: v })} aria-label="Valor" />
          <input value={movement.reason} maxLength={300} placeholder="Motivo" onChange={(e) => setMovement({ ...movement, reason: e.target.value })} />
          <button className="btn btn-outline" disabled={busy}>Registrar</button>
        </form>}
        {summary.movements.length === 0 ? <p className="muted">Nenhuma movimentação.</p>
          : <ul className="movements">{summary.movements.map((m) => <li key={m.id}>
            <span>{m.type === 'withdrawal' ? 'Sangria' : 'Suprimento'} · {time(m.createdAt)}<small>{m.reason} — {m.createdBy}</small></span>
            <b className={m.type === 'withdrawal' ? 'neg' : 'pos'}>{m.type === 'withdrawal' ? '−' : '+'}{money(m.amount)}</b></li>)}</ul>}
      </section>
      <section className="panel">
        <h3>PIX aguardando conferência</h3>
        {summary.pixPending.length === 0 ? <p className="muted">Nenhum.</p>
          : <ul className="movements">{summary.pixPending.map((p) => <li key={p.id}><span>#{p.ticket} · {p.buyerName}<small>Avisou às {time(p.claimedAt)}</small></span><b>{moneyCents(p.totalCents)}</b></li>)}</ul>}
      </section>
    </div>
    <section className="panel">
      <h3>Lançamentos deste caixa</h3>
      <PaymentsTable payments={summary.payments} />
    </section>
    {closing && <CloseDialog session={session} summary={summary} onClose={() => setClosing(false)} onDone={() => { setClosing(false); load(); onChanged(); }} />}
  </>;
}

// ---------- Histórico de fechamentos ----------

function SessionDetail({ id, onClose }) {
  const { call, can, token } = useAdmin();
  const confirm = useConfirm();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [adjust, setAdjust] = useState({ method: 'cash', amount: '', reason: '' });
  const load = useCallback(async () => {
    try { setData(await call(`/finance/cash/sessions/${id}`)); } catch (err) { setError(err.message); }
  }, [call, id]);
  useEffect(() => { load(); }, [load]);

  const print = () => {
    document.body.classList.add('printing');
    window.print();
    setTimeout(() => document.body.classList.remove('printing'), 500);
  };
  const addAdjustment = async (event) => {
    event.preventDefault();
    const value = parseMoney(adjust.amount.replace(/^-/, ''));
    const negative = adjust.amount.trim().startsWith('-');
    if (Number.isNaN(value) || value === 0) { toast('Informe o valor do ajuste.', 'error'); return; }
    const ok = await confirm({ title: 'Registrar ajuste?', message: 'O ajuste fica registrado separadamente, com seu nome e justificativa. Os valores originais do fechamento não são alterados.', confirmLabel: 'Registrar ajuste' });
    if (!ok) return;
    try { await call(`/finance/cash/sessions/${id}/adjustments`, { method: 'POST', body: { method: adjust.method || null, amount: negative ? -value : value, reason: adjust.reason } }); toast('Ajuste registrado.'); setAdjust({ method: 'cash', amount: '', reason: '' }); load(); }
    catch (err) { toast(err.message, 'error'); }
  };

  return <Modal title={`Caixa nº ${id}`} onClose={onClose} size="lg">
    {error ? <p className="alert alert-error">{error}</p> : !data ? <Spinner /> : <div className="print-area">
      <div className="print-header"><img src="/brand/la-em-gracas-lanches.png" alt="" /><img src="/brand/eag-gracas.png" alt="" /><h2>Resumo do caixa nº {id}</h2></div>
      <div className="session-meta">
        <Badge tone={data.session.status === 'closed' ? 'neutral' : 'success'}>{data.session.status === 'closed' ? 'Fechado' : 'Aberto'}</Badge>
        <p>Aberto por <b>{data.session.openedBy}</b> em {fullDateTime(data.session.openedAt)}{data.session.closedAt && <> · Fechado por <b>{data.session.closedBy}</b> em {fullDateTime(data.session.closedAt)}</>}</p>
        {data.session.closingNote && <p>Observações: {data.session.closingNote}</p>}
      </div>
      <SessionSummary summary={data.summary} counted={data.summary.counted} differences={data.summary.differences} />
      {data.adjustments.length > 0 && <section className="panel">
        <h3>Ajustes após o fechamento</h3>
        <ul className="movements">{data.adjustments.map((a) => <li key={a.id}><span>{a.method ? PAYMENT_METHODS[a.method] : 'Geral'} · {fullDateTime(a.createdAt)}<small>{a.reason} — {a.createdBy}</small></span><b className={a.amount < 0 ? 'neg' : 'pos'}>{a.amount > 0 ? '+' : ''}{money(a.amount)}</b></li>)}</ul>
      </section>}
      <section className="panel"><h3>Lançamentos</h3><PaymentsTable payments={data.summary.payments} /></section>
      <div className="btn-row no-print">
        <button type="button" className="btn btn-outline" onClick={print}><Printer size={16} /> Imprimir</button>
        <button type="button" className="btn btn-outline" onClick={() => download(`/finance/cash/sessions/${id}/export.csv`, token, `caixa-${id}.csv`).catch((err) => toast(err.message, 'error'))}><Download size={16} /> Exportar CSV</button>
      </div>
      {data.session.status === 'closed' && can('finance.adjust') && <form className="panel no-print adjust-form" onSubmit={addAdjustment}>
        <h3>Ajuste autorizado (administrador)</h3>
        <p className="muted small">Use para corrigir algo identificado depois do fechamento. Para diminuir, use valor negativo (ex.: -5,00).</p>
        <div className="grid-3">
          <select value={adjust.method} onChange={(e) => setAdjust({ ...adjust, method: e.target.value })}><option value="">Geral</option>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input value={adjust.amount} inputMode="decimal" placeholder="Valor (ex.: 5,00 ou -5,00)" onChange={(e) => setAdjust({ ...adjust, amount: e.target.value.replace(/[^\d,.-]/g, '') })} />
          <input value={adjust.reason} maxLength={500} placeholder="Justificativa (mín. 10 caracteres)" onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} />
        </div>
        <button className="btn btn-outline btn-sm" disabled={adjust.reason.trim().length < 10}>Registrar ajuste</button>
      </form>}
    </div>}
  </Modal>;
}

function History() {
  const { call } = useAdmin();
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const load = useCallback(async () => {
    try { setList(await call('/finance/cash/sessions')); setError(''); } catch (err) { setError(err.message); }
  }, [call]);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh(load, ['cash']);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!list) return <Spinner />;
  if (!list.length) return <EmptyState title="Nenhum caixa registrado">Abra o primeiro caixa na aba Caixa.</EmptyState>;
  return <div className="table-wrap"><table className="table">
    <thead><tr><th>Caixa</th><th>Abertura / fechamento</th><th>Responsável</th><th>Pedidos pagos</th><th>PIX</th><th>Dinheiro</th><th>Cartão</th><th>Total recebido</th><th>Dinheiro: esperado × contado</th><th>Situação</th></tr></thead>
    <tbody>{list.map((s) => { const sum = s.summary; return <tr key={s.id} className="clickable" onClick={() => setOpenId(s.id)}>
      <td><b>nº {s.id}</b></td>
      <td>{fullDateTime(s.openedAt)}<small>{s.closedAt ? `até ${fullDateTime(s.closedAt)}` : 'em andamento'}</small></td>
      <td>{s.closedBy || s.openedBy}</td>
      {sum ? <>
        <td>{sum.paidOrders}</td><td>{moneyCents(sum.methods.pix.net)}</td><td>{moneyCents(sum.methods.cash.net)}</td>
        <td>{moneyCents(sum.methods.debit.net + sum.methods.credit.net)}</td><td><b>{moneyCents(sum.net)}</b></td>
        <td>{moneyCents(sum.expectedCash)} × {moneyCents(sum.counted.cash)}<small><Diff cents={sum.differences.cash} /></small></td>
      </> : <td colSpan={6} className="muted">Caixa aberto — veja a aba Caixa</td>}
      <td>{s.status === 'closed' ? <Badge tone="neutral" icon={<CheckCircle2 size={12} />}>Fechado</Badge> : <Badge tone="success">Aberto</Badge>}{s.adjustments ? <small>Ajustes: {money(s.adjustments)}</small> : null}</td>
    </tr>; })}</tbody>
  </table>
  {openId && <SessionDetail id={openId} onClose={() => setOpenId(null)} />}
  </div>;
}

// ---------- Lançamentos ----------

function Entries() {
  const { call } = useAdmin();
  const period = usePeriod('today');
  const [method, setMethod] = useState('');
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const load = useCallback(async () => {
    try { setList(await call(`/finance/payments?${period.query}`)); setError(''); } catch (err) { setError(err.message); }
  }, [call, period.query]);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh(load);
  const rows = (list || []).filter((p) => !method || p.method === method);
  return <>
    <div className="filters-bar">
      <PeriodFilter period={period} />
      <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Forma"><option value="">Todas as formas</option>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
    </div>
    <p className="muted small">Para anular um lançamento errado, abra o pedido. Lançamentos de caixas fechados não podem ser alterados.</p>
    {error ? <ErrorState message={error} onRetry={load} /> : !list ? <Spinner /> : rows.length === 0 ? <EmptyState title="Nenhum lançamento no período" />
      : <div className="table-wrap"><table className="table">
        <thead><tr><th>Data</th><th>Pedido</th><th>Tipo</th><th>Forma</th><th>Valor</th><th>Troco</th><th>Caixa</th><th>Responsável</th></tr></thead>
        <tbody>{rows.map((p) => <tr key={p.id} className={`clickable ${p.status === 'voided' ? 'row-voided' : ''}`} onClick={() => setOpenId(p.orderId)}>
          <td>{dateTime(p.createdAt)}</td><td>#{p.ticket}<small>{p.orderNumber} · {p.buyerName}</small></td>
          <td>{p.kind === 'refund' ? 'Estorno' : 'Recebimento'}{p.status === 'voided' && <small>Anulado: {p.voidReason}</small>}</td>
          <td>{PAYMENT_METHODS[p.method]}</td><td>{p.kind === 'refund' ? '−' : ''}{money(p.amount)}</td><td>{p.change ? money(p.change) : '—'}</td>
          <td>{p.sessionId ? `nº ${p.sessionId}` : '—'}</td><td>{p.createdBy}</td>
        </tr>)}</tbody></table></div>}
    {openId && <OrderDetail orderId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
  </>;
}

export default function FinancePage() {
  const { call } = useAdmin();
  const [tab, setTab] = useState('overview');
  const [cashOpen, setCashOpen] = useState(null);
  const checkCash = useCallback(() => call('/finance/cash').then((data) => setCashOpen(Boolean(data.session))).catch(() => {}), [call]);
  useEffect(() => { checkCash(); }, [checkCash]);
  useLiveRefresh(checkCash, ['cash']);

  return <div className="admin-page">
    <header className="admin-page-head">
      <div><h1>Financeiro</h1><p>Vendas, conferência de recebimentos e fechamento de caixa.</p></div>
      {cashOpen != null && <Badge tone={cashOpen ? 'success' : 'warning'} icon={cashOpen ? <Unlock size={13} /> : <Lock size={13} />}>{cashOpen ? 'Caixa aberto' : 'Caixa fechado'}</Badge>}
    </header>
    <nav className="subtabs">{SUBTABS.map((item) => <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
    {tab === 'overview' && <Overview />}
    {tab === 'receive' && <Receive cashOpen={cashOpen} goToCash={checkCash} />}
    {tab === 'cash' && <CashTab onChanged={checkCash} />}
    {tab === 'history' && <History />}
    {tab === 'entries' && <Entries />}
  </div>;
}
