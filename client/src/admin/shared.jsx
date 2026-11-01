// Peças compartilhadas do painel: período, movimentação de etapas, recebimento e detalhes do pedido.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Bike, Plus, Store, Trash2, UtensilsCrossed, X } from 'lucide-react';
import { Badge, Modal, MoneyInput, Spinner, useConfirm, useToast } from '../components/ui.jsx';
import { fullDateTime, localDate, money, parseMoney, request, time, uuid } from '../lib/api.js';
import { ADVANCE_LABELS, MODES, ORDER_STATUS, PAYMENT_METHODS, PAYMENT_STATUS, PRODUCTION_SHORT, PRODUCTION_STEPS, SERVICE_TYPES } from '../lib/labels.js';
import { useAdmin, useLiveRefresh } from './context.js';

// ---------- Período ----------

export const PERIODS = {
  today: { label: 'Hoje', range: () => [localDate(), localDate()] },
  yesterday: { label: 'Ontem', range: () => [localDate(-1), localDate(-1)] },
  week: { label: '7 dias', range: () => [localDate(-6), localDate()] },
  month: { label: '30 dias', range: () => [localDate(-29), localDate()] }
};

export function usePeriod(initial = 'today') {
  const [preset, setPreset] = useState(initial);
  const [custom, setCustom] = useState({ from: localDate(), to: localDate() });
  const [from, to] = preset === 'custom' ? [custom.from, custom.to] : PERIODS[preset].range();
  return { preset, setPreset, custom, setCustom, from, to, query: `from=${from}&to=${to}` };
}

export function PeriodFilter({ period }) {
  return <div className="period-filter">
    <div className="segmented">
      {Object.entries(PERIODS).map(([key, value]) => <button type="button" key={key} className={period.preset === key ? 'active' : ''} onClick={() => period.setPreset(key)}>{value.label}</button>)}
      <button type="button" className={period.preset === 'custom' ? 'active' : ''} onClick={() => period.setPreset('custom')}>Período</button>
    </div>
    {period.preset === 'custom' && <div className="date-range">
      <input type="date" value={period.custom.from} max={period.custom.to} onChange={(e) => e.target.value && period.setCustom({ ...period.custom, from: e.target.value })} aria-label="Data inicial" />
      <span>até</span>
      <input type="date" value={period.custom.to} min={period.custom.from} onChange={(e) => e.target.value && period.setCustom({ ...period.custom, to: e.target.value })} aria-label="Data final" />
    </div>}
  </div>;
}

// ---------- Badges ----------

export function PaymentBadge({ order }) {
  if (order.onCredit && order.paymentStatus !== 'confirmed' && order.status === 'active') return <Badge tone="purple">Fiado</Badge>;
  const info = PAYMENT_STATUS[order.paymentStatus] || { label: order.paymentStatus, tone: 'neutral' };
  return <Badge tone={info.tone}>{info.label}</Badge>;
}

export function ServiceBadge({ order }) {
  const Icon = order.serviceType === 'delivery' ? Bike : order.serviceType === 'dine_in' ? UtensilsCrossed : Store;
  return <Badge tone={order.serviceType === 'delivery' ? 'purple' : 'blue'} icon={<Icon size={13} />}>
    {SERVICE_TYPES[order.serviceType]}{order.tableNumber ? ` · Mesa ${order.tableNumber}` : ''}
  </Badge>;
}

export function StatusBadge({ order }) {
  if (order.status === 'active') return <Badge tone="neutral">{PRODUCTION_SHORT[order.productionStatus]}</Badge>;
  const info = ORDER_STATUS[order.status];
  return <Badge tone={info.tone}>{info.label}</Badge>;
}

// ---------- Movimentação de etapas (mesmas regras do servidor, para exibir só o que é permitido) ----------

const FORWARD_ROLES = { in_production: ['admin', 'kitchen'], ready: ['admin', 'kitchen'], awaiting_pickup: ['admin', 'kitchen', 'operator'], finalized: ['admin', 'kitchen', 'operator'] };

export function productionActions(order, role) {
  if (order.status !== 'active') return { next: null, previous: null };
  const index = PRODUCTION_STEPS.indexOf(order.productionStatus);
  const next = PRODUCTION_STEPS[index + 1];
  const previous = PRODUCTION_STEPS[index - 1];
  const backRoles = order.productionStatus === 'finalized' ? ['admin'] : ['admin', 'kitchen'];
  return {
    next: next && FORWARD_ROLES[next].includes(role) ? next : null,
    previous: previous && backRoles.includes(role) ? previous : null
  };
}

export function useProductionMove(onChanged) {
  const { call, can } = useAdmin();
  const confirm = useConfirm();
  const toast = useToast();
  const [busyId, setBusyId] = useState(null);
  const move = useCallback(async (order, to) => {
    const back = PRODUCTION_STEPS.indexOf(to) < PRODUCTION_STEPS.indexOf(order.productionStatus);
    let reason;
    if (back) {
      reason = await confirm({ title: `Voltar #${order.ticket ?? order.orderNumber} para "${PRODUCTION_SHORT[to]}"?`, message: 'Use apenas para corrigir uma movimentação feita por engano. A correção fica registrada no histórico.',
        input: { label: 'Motivo da correção', placeholder: 'Ex.: movido por engano' }, confirmLabel: 'Voltar etapa' });
      if (!reason) return false;
    }
    setBusyId(order.id);
    const send = (acknowledgeUnpaid) => call(`/admin/orders/${order.id}/production`, { method: 'POST', body: { from: order.productionStatus, to, reason, acknowledgeUnpaid } });
    try {
      await send(false);
      toast(`Pedido #${order.ticket ?? order.orderNumber}: ${PRODUCTION_SHORT[to]}.`);
    } catch (error) {
      if (error.code === 'UNPAID') {
        const choice = await confirm({ title: `Pedido #${order.ticket ?? ''} sem pagamento`,
          message: <>Ainda há <b>{money(order.balance)}</b> em aberto. Escolha como finalizar:<ul className="confirm-list">
            <li><b>Lançar no fiado</b>: o valor fica na aba Fiados, no nome de {order.buyerName}, para cobrar depois.</li>
            <li><b>Finalizar sem pagamento</b>: o valor continua pendente no financeiro.</li></ul></>,
          choices: [
            ...(can('credits.manage') ? [{ value: 'credit', label: 'Finalizar e lançar no fiado', className: 'btn-primary' }] : []),
            { value: 'unpaid', label: 'Finalizar sem pagamento', className: 'btn-outline' }
          ] });
        if (choice) {
          try {
            await call(`/admin/orders/${order.id}/production`, { method: 'POST', body: { from: order.productionStatus, to, credit: choice === 'credit', acknowledgeUnpaid: choice === 'unpaid' } });
            toast(choice === 'credit' ? 'Pedido finalizado e lançado no fiado.' : 'Pedido finalizado. Pagamento continua pendente.', 'info');
          } catch (err) { toast(err.message, 'error'); }
        }
      } else toast(error.message, 'error');
    } finally {
      setBusyId(null);
      onChanged?.();
    }
    return true;
  }, [call, can, confirm, toast, onChanged]);
  return { move, busyId };
}

// ---------- Recebimento (um ou mais meios de pagamento) ----------

const toCents = (value) => Math.round(parseMoney(value) * 100);
const centsText = (cents) => (cents / 100).toFixed(2).replace('.', ',');

// Formas habilitadas para registrar recebimento (PIX sempre; demais conforme configuração).
// Inclui "Fiado" para quem pode lançar fiado (pode ser só uma parte do valor).
export function useRegisterMethods() {
  const { can } = useAdmin();
  const credit = can('credits.manage');
  const [methods, setMethods] = useState(['pix', 'cash', 'debit', 'credit']);
  useEffect(() => {
    request('/public-config').then((config) => setMethods(['pix', ...config.paymentMethods.filter((m) => m !== 'pix')])).catch(() => {});
  }, []);
  return useMemo(() => (credit ? [...methods, 'fiado'] : methods), [credit, methods]);
}

export const hasCashLine = (lines) => lines.some((line) => line.method !== 'fiado');
export const hasCreditLine = (lines) => lines.some((line) => line.method === 'fiado');

// Abertura rápida do caixa, sem sair da tela (para quem tem permissão).
export function OpenCashInline({ onOpened }) {
  const { call, can } = useAdmin();
  const toast = useToast();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  if (!can('finance.cash')) return <p className="alert alert-warning">O caixa está fechado. Peça a alguém do <b>Financeiro</b> para abrir o caixa (Financeiro › Caixa › Abrir caixa). Enquanto isso, você pode deixar no fiado ou para pagar depois.</p>;
  const open = async () => {
    const opening = value === '' ? 0 : parseMoney(value);
    if (Number.isNaN(opening) || opening < 0) { toast('Valor inicial inválido.', 'error'); return; }
    setBusy(true);
    try { await call('/finance/cash/open', { method: 'POST', body: { openingCash: opening, note: '' } }); toast('Caixa aberto.'); onOpened?.(); }
    catch (err) { toast(err.message, 'error'); if (err.status === 409) onOpened?.(); } finally { setBusy(false); }
  };
  return <div className="open-cash">
    <p><b>O caixa está fechado.</b> Para registrar dinheiro, PIX ou cartão, abra o caixa informando o troco inicial (dinheiro na gaveta).</p>
    <div className="open-cash-row"><MoneyInput value={value} onChange={setValue} placeholder="0,00" aria-label="Troco inicial" />
      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={open}>{busy ? 'Abrindo...' : 'Abrir caixa agora'}</button></div>
  </div>;
}

// Sem forma marcada por padrão: quem atende escolhe na hora (evita registrar cartão/PIX como dinheiro).
export const newPaymentLines = (totalCents, method = '') => [{ method, amount: centsText(totalCents), tendered: '' }];

export function linesError(lines, totalCents) {
  let sum = 0;
  for (const line of lines) {
    if (!line.method) return 'Escolha a forma de pagamento.';
    const value = toCents(line.amount);
    if (Number.isNaN(value) || value <= 0) return 'Informe valores maiores que zero.';
    if (line.method === 'cash' && line.tendered) {
      const tendered = toCents(line.tendered);
      if (Number.isNaN(tendered) || tendered < value) return 'O valor entregue em dinheiro é menor que o valor a receber.';
    }
    sum += value;
  }
  if (new Set(lines.map((line) => line.method)).size !== lines.length) return 'Use cada forma de pagamento uma única vez.';
  const remaining = totalCents - sum;
  if (remaining !== 0) return remaining > 0 ? `Faltam ${money(remaining / 100)} para fechar o valor.` : `A soma passou ${money(-remaining / 100)} do valor.`;
  return '';
}

export const linesPayload = (lines) => lines.map((line) => ({ method: line.method, amount: toCents(line.amount) / 100,
  tendered: line.method === 'cash' && line.tendered ? toCents(line.tendered) / 100 : null }));

// Editor de uma ou mais formas de pagamento, com cálculo de troco no dinheiro.
export function PaymentLines({ lines, setLines, methods, totalCents }) {
  const sum = lines.reduce((total, line) => total + (Number.isNaN(toCents(line.amount)) ? 0 : toCents(line.amount)), 0);
  const remaining = totalCents - sum;
  const update = (index, patch) => setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  return <div className="pay-editor">
    {lines.map((line, index) => {
      const change = line.method === 'cash' && line.tendered ? toCents(line.tendered) - toCents(line.amount) : null;
      return <div key={index} className="pay-line">
        <select value={line.method} onChange={(e) => update(index, { method: e.target.value })} aria-label="Forma de pagamento" className={line.method ? '' : 'needs-choice'}>
          <option value="" disabled>Escolha a forma</option>
          {methods.map((method) => <option key={method} value={method}>{PAYMENT_METHODS[method]}</option>)}
        </select>
        <MoneyInput value={line.amount} onChange={(value) => update(index, { amount: value })} aria-label="Valor" />
        {line.method === 'cash' ? <MoneyInput value={line.tendered} onChange={(value) => update(index, { tendered: value })} placeholder="Recebido" aria-label="Valor entregue pelo cliente" /> : <span />}
        {lines.length > 1 ? <button type="button" className="icon-btn" onClick={() => setLines((current) => current.filter((_, i) => i !== index))} aria-label="Remover forma"><Trash2 size={16} /></button> : <span />}
        {change != null && !Number.isNaN(change) && change >= 0 && <span className="change-tag">Troco <b>{money(change / 100)}</b></span>}
      </div>;
    })}
    <div className="pay-editor-foot">
      {lines.length < 4 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLines((current) => [...current, {
        method: '', amount: remaining > 0 ? centsText(remaining) : '', tendered: '' }])}>
        <Plus size={15} /> Adicionar outra forma</button>}
      <span className={`pay-check ${remaining === 0 ? 'ok' : 'bad'}`}>{remaining === 0 ? `Soma confere: ${money(sum / 100)}` : `${remaining > 0 ? 'Faltam' : 'Excedeu'} ${money(Math.abs(remaining) / 100)}`}</span>
    </div>
  </div>;
}

export function PaymentDialog({ order, onClose, onDone }) {
  const { call } = useAdmin();
  const toast = useToast();
  const methods = useRegisterMethods();
  const balanceCents = Math.round(order.balance * 100);
  const [lines, setLines] = useState(() => newPaymentLines(balanceCents));
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(uuid());
  const [cashOpen, setCashOpen] = useState(true);
  const checkCash = useCallback(() => call('/admin/cash-status').then((r) => setCashOpen(r.open)).catch(() => {}), [call]);
  useEffect(() => { checkCash(); }, [checkCash]);
  useEffect(() => { setLines((current) => current.map((line) => (!line.method || methods.includes(line.method) ? line : { ...line, method: '' }))); }, [methods]);
  const validation = linesError(lines, balanceCents) || (hasCashLine(lines) && !cashOpen ? 'Abra o caixa para registrar este recebimento.' : '')
    || (hasCreditLine(lines) && order.buyerPhone.replace(/\D/g, '').length < 10 ? 'Para deixar parte no fiado, o pedido precisa ter o telefone do cliente (edite os dados do cliente).' : '');

  const submit = async () => {
    if (validation) { setError(validation); return; }
    setBusy(true); setError('');
    try {
      const result = await call(`/finance/orders/${order.id}/payments`, { method: 'POST', body: { idempotencyKey: key.current, note, lines: linesPayload(lines) } });
      toast([hasCashLine(lines) ? 'Recebimento registrado.' : 'Lançado no fiado.', result.change > 0 ? `Troco: ${money(result.change)}.` : ''].join(' '));
      onDone?.();
      onClose();
    } catch (err) {
      if (err.code === 'NO_CASH_SESSION') { setCashOpen(false); setError(''); } else setError(err.message);
    } finally { setBusy(false); }
  };

  return <Modal title={`${order.onCredit ? 'Dar baixa no fiado' : 'Registrar recebimento'} · #${order.ticket ?? ''}`} subtitle={`${order.orderNumber} · ${order.buyerName}`} onClose={onClose} size="md"
    footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn btn-primary" disabled={busy || Boolean(validation)} onClick={submit}>{busy ? 'Registrando...' : 'Confirmar recebimento'}</button>
    </>}>
    <div className="pay-summary">
      <div><span>Total do pedido</span><b>{money(order.total)}</b></div>
      <div><span>Já recebido</span><b>{money(order.paid)}</b></div>
      <div className="highlight"><span>A receber</span><b>{money(order.balance)}</b></div>
    </div>
    {order.paymentStatus === 'pending_review' && <p className="alert alert-info">O comprador informou que pagou via PIX às {time(order.paymentClaimedAt)}. Confirme somente após ver o valor no extrato.</p>}
    {!cashOpen && hasCashLine(lines) && <OpenCashInline onOpened={checkCash} />}
    <PaymentLines lines={lines} setLines={setLines} methods={methods} totalCents={balanceCents} />
    {hasCreditLine(lines) && <p className="muted small">A parte em "Fiado" fica anotada no nome de {order.buyerName} na aba Fiados.</p>}
    <label className="field"><span>Observação (opcional)</span><input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: comprovante conferido no extrato" /></label>
    {error && <p className="alert alert-error">{error}</p>}
  </Modal>;
}

// ---------- Cancelamento ----------

export function useCancelOrder(onChanged) {
  const { call, user } = useAdmin();
  const confirm = useConfirm();
  const toast = useToast();
  return useCallback(async (order) => {
    const paid = order.paid > 0;
    if (paid && !['admin', 'finance'].includes(user.role)) { toast('Pedido com pagamento registrado: o cancelamento com estorno é feito pelo financeiro.', 'error'); return; }
    const reason = await confirm({
      title: `Cancelar pedido #${order.ticket ?? order.orderNumber}?`, danger: true, confirmLabel: paid ? 'Cancelar e estornar' : 'Cancelar pedido',
      message: paid ? <>Este pedido tem <b>{money(order.paid)}</b> recebidos. O cancelamento registra o <b>estorno</b> desse valor no caixa aberto (devolva o dinheiro ao cliente). O histórico é mantido.</>
        : order.paymentStatus === 'pending_review' ? <>Atenção: o comprador informou que pagou via PIX. Confira o extrato antes de cancelar.</> : 'O pedido sai da cozinha e do acompanhamento como cancelado. O histórico é mantido.',
      input: { label: 'Motivo do cancelamento', placeholder: 'Ex.: cliente desistiu' }
    });
    if (!reason) return;
    try {
      await call(`/admin/orders/${order.id}/cancel`, { method: 'POST', body: { reason, refund: paid } });
      toast(paid ? 'Pedido cancelado e estorno registrado.' : 'Pedido cancelado.');
      onChanged?.();
    } catch (error) {
      toast(error.code === 'NO_CASH_SESSION' ? 'Para estornar é preciso ter um caixa aberto.' : error.message, 'error');
    }
  }, [call, confirm, toast, onChanged, user]);
}

// ---------- Detalhes do pedido ----------

const HISTORY_LABELS = {
  created: 'Pedido criado', claimed: 'Comprador informou o PIX', confirmed: 'Recebimento registrado', claim_rejected: 'PIX não localizado',
  voided: 'Lançamento anulado', refunded: 'Estorno', cancelled: 'Cancelado', expired: 'Expirado', reactivated: 'Reativado',
  new: 'Novo pedido', in_production: 'Em produção', ready: 'Pronto', awaiting_pickup: 'Aguardando retirada', finalized: 'Finalizado',
  // Estados do modelo anterior
  awaiting_payment: 'Aguardando pagamento', pending_review: 'Conferência de PIX', preparing: 'Em preparo', completed: 'Concluído'
};

export function OrderItems({ items, compact }) {
  return <ul className={`order-items ${compact ? 'compact' : ''}`}>
    {items.map((item, index) => <li key={index}>
      <span className="qty-tag">{item.quantity}×</span>
      <div><b>{item.name}</b>
        {item.options.length > 0 && <small>{item.options.map((o) => o.option).join(' · ')}</small>}
        {item.customText && <small>{item.customTextLabel}: {item.customText}</small>}
        {item.note && <small className="note">Obs.: {item.note}</small>}</div>
      {!compact && <b>{money(item.total)}</b>}
    </li>)}
  </ul>;
}

export function OrderDetail({ orderId, onClose, onChanged }) {
  const { call, can, user } = useAdmin();
  const confirm = useConfirm();
  const toast = useToast();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try { setOrder(await call(`/admin/orders/${orderId}`)); setError(''); }
    catch (err) { setError(err.message); }
  }, [call, orderId]);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh(() => load());

  const changed = useCallback(() => { load(); onChanged?.(); }, [load, onChanged]);
  const { move, busyId } = useProductionMove(changed);
  const cancel = useCancelOrder(changed);

  const rejectClaim = async () => {
    const reason = await confirm({ title: 'PIX não localizado', message: 'O pedido volta para "Aguardando pagamento" e o comprador vê o aviso. Se o prazo do PIX já terminou, o pedido expira.',
      input: { label: 'Motivo', placeholder: 'Ex.: valor não encontrado no extrato' }, confirmLabel: 'Registrar', danger: true });
    if (!reason) return;
    try { await call(`/finance/orders/${orderId}/reject-claim`, { method: 'POST', body: { reason } }); toast('Registrado.'); changed(); }
    catch (err) { toast(err.message, 'error'); }
  };
  const voidPayment = async (payment) => {
    const reason = await confirm({ title: 'Anular lançamento', danger: true, confirmLabel: 'Anular',
      message: `Anula o recebimento de ${money(payment.amount)} (${PAYMENT_METHODS[payment.method]}). Use para corrigir um lançamento errado. Lançamentos de caixa já fechado não podem ser anulados.`,
      input: { label: 'Motivo', minLength: 5 } });
    if (!reason) return;
    try { await call(`/finance/payments/${payment.id}/void`, { method: 'POST', body: { reason } }); toast('Lançamento anulado.'); changed(); }
    catch (err) { toast(err.message, 'error'); }
  };

  const toCredit = async () => {
    if (order.buyerPhone.replace(/\D/g, '').length < 10) { toast('Informe o telefone do cliente antes de lançar no fiado (botão Editar).', 'error'); setEditing(true); return; }
    const ok = await confirm({ title: 'Lançar no fiado?', confirmLabel: 'Lançar no fiado',
      message: <><b>{money(order.balance)}</b> ficarão anotados no nome de <b>{order.buyerName}</b> ({order.buyerPhone}) para cobrança posterior, na aba Fiados.</> });
    if (!ok) return;
    try { await call(`/finance/orders/${orderId}/credit`, { method: 'POST', body: {} }); toast('Lançado no fiado.'); changed(); }
    catch (err) { toast(err.message, 'error'); }
  };

  const actions = order ? productionActions(order, user.role) : {};
  return <Modal title={order ? `Pedido #${order.ticket ?? ''} · ${order.orderNumber}` : 'Pedido'} onClose={onClose} size="lg" className="order-detail">
    {error ? <p className="alert alert-error">{error}</p> : !order ? <Spinner /> : <>
      <div className="detail-badges">
        <StatusBadge order={order} /><PaymentBadge order={order} /><ServiceBadge order={order} /><Badge tone="neutral">{MODES[order.mode]}</Badge>
      </div>
      {order.status === 'cancelled' && <p className="alert alert-error">Cancelado em {fullDateTime(order.cancelledAt)}: {order.cancelReason}</p>}
      <div className="detail-grid">
        <section>
          <h3>Cliente {can('orders.edit') && <button type="button" className="link-btn small" onClick={() => setEditing(true)}>Editar</button>}</h3>
          <p><b>{order.buyerName}</b><br />{order.buyerPhone ? <a href={`tel:${order.buyerPhone.replace(/[^\d+]/g, '')}`}>{order.buyerPhone}</a> : <span className="muted">Sem telefone</span>}<br />Equipe: {order.teamName}
            {order.source === 'balcao' && <><br /><span className="muted small">Venda registrada no balcão</span></>}</p>
          <h3>Atendimento</h3>
          <p>{SERVICE_TYPES[order.serviceType]}{order.tableNumber ? ` · Mesa ${order.tableNumber}` : ''}<br />
            {order.serviceType === 'delivery' && <>Endereço: <b>{order.deliveryAddress}</b>{order.deliveryReference && <><br />Ref.: {order.deliveryReference}</>}{order.deliveryNote && <><br />Obs.: {order.deliveryNote}</>}</>}
          </p>
          <p className="muted small">Criado em {fullDateTime(order.createdAt)}</p>
        </section>
        <section>
          <h3>Pagamento</h3>
          <div className="pay-lines">
            <div><span>Forma escolhida</span><b>{PAYMENT_METHODS[order.paymentMethod]}</b></div>
            <div><span>Subtotal</span><b>{money(order.subtotal)}</b></div>
            {order.deliveryFee > 0 && <div><span>Taxa de entrega</span><b>{money(order.deliveryFee)}</b></div>}
            <div><span>Total</span><b>{money(order.total)}</b></div>
            <div><span>Recebido</span><b>{money(order.paid)}</b></div>
            <div><span>Em aberto</span><b>{money(order.balance)}</b></div>
            {order.cashChangeFor && <div><span>Troco para</span><b>{money(order.cashChangeFor)}</b></div>}
            {order.onCredit && <div><span>Fiado</span><b>{fullDateTime(order.creditAt)} · {order.creditBy}</b></div>}
          </div>
          {order.status !== 'cancelled' && order.balance > 0 && <div className="btn-row">
            {can('payments.register') && <button type="button" className="btn btn-primary btn-sm" onClick={() => setPaying(true)}>{order.onCredit ? 'Dar baixa no fiado' : 'Registrar recebimento'}</button>}
            {can('credits.manage') && !order.onCredit && order.status === 'active' && <button type="button" className="btn btn-outline btn-sm" onClick={toCredit}>Lançar no fiado</button>}
            {can('finance.payments') && order.paymentStatus === 'pending_review' && <button type="button" className="btn btn-outline btn-sm" onClick={rejectClaim}>PIX não localizado</button>}
          </div>}
        </section>
      </div>

      <h3>Itens</h3>
      <OrderItems items={order.items} />

      {order.payments.length > 0 && <>
        <h3>Lançamentos financeiros</h3>
        <table className="table compact"><thead><tr><th>Data</th><th>Tipo</th><th>Forma</th><th>Valor</th><th>Por</th><th /></tr></thead>
          <tbody>{order.payments.map((p) => <tr key={p.id} className={p.status === 'voided' ? 'row-voided' : ''}>
            <td>{fullDateTime(p.created_at)}</td>
            <td>{p.kind === 'refund' ? 'Estorno' : 'Recebimento'}{p.status === 'voided' && <small>Anulado: {p.void_reason}</small>}</td>
            <td>{PAYMENT_METHODS[p.method]}{p.change != null && p.change > 0 && <small>Troco {money(p.change)}</small>}</td>
            <td>{p.kind === 'refund' ? '−' : ''}{money(p.amount)}</td>
            <td>{p.created_by_name}</td>
            <td>{can('finance.payments') && p.status === 'confirmed' && p.kind === 'payment' && order.status !== 'cancelled' && <button type="button" className="icon-btn danger" title="Anular lançamento" onClick={() => voidPayment(p)}><X size={15} /></button>}</td>
          </tr>)}</tbody></table>
      </>}

      <h3>Histórico</h3>
      <ol className="history">
        {order.history.map((h, index) => <li key={index}><time>{fullDateTime(h.created_at)}</time><b>{HISTORY_LABELS[h.status] || h.status}</b><span>{h.note}</span><small>{h.actor}</small></li>)}
      </ol>

      <div className="detail-actions">
        {actions.previous && <button type="button" className="btn btn-ghost" disabled={busyId === order.id} onClick={() => move(order, actions.previous)}>Voltar para "{PRODUCTION_SHORT[actions.previous]}"</button>}
        {can('orders.cancel') && order.status !== 'cancelled' && <button type="button" className="btn btn-danger-outline" onClick={() => cancel(order)}><Ban size={16} /> Cancelar pedido</button>}
        {actions.next && <button type="button" className="btn btn-primary" disabled={busyId === order.id} onClick={() => move(order, actions.next)}>{ADVANCE_LABELS[actions.next]}</button>}
      </div>
    </>}
    {paying && order && <PaymentDialog order={order} onClose={() => setPaying(false)} onDone={changed} />}
    {editing && order && <CustomerDialog order={order} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); changed(); }} />}
  </Modal>;
}

// ---------- Dados do cliente (nome, telefone e equipe) ----------

export function useTeams() {
  const [teams, setTeams] = useState([]);
  useEffect(() => { request('/teams').then(setTeams).catch(() => setTeams([])); }, []);
  return teams;
}

export function formatPhone(value) {
  const d = value.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function CustomerDialog({ order, onClose, onSaved }) {
  const { call } = useAdmin();
  const teams = useTeams();
  const [form, setForm] = useState({ buyerName: order.buyerName, buyerPhone: order.buyerPhone, teamId: '' });
  const [error, setError] = useState('');
  useEffect(() => { const team = teams.find((t) => t.name === order.teamName); if (team) setForm((f) => ({ ...f, teamId: String(team.id) })); }, [teams, order.teamName]);
  const save = async (event) => {
    event.preventDefault();
    try { await call(`/admin/orders/${order.id}/customer`, { method: 'PATCH', body: form }); onSaved(); }
    catch (err) { setError(err.message); }
  };
  return <Modal title="Dados do cliente" onClose={onClose} size="sm"
    footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button><button type="submit" form="customer-form" className="btn btn-primary">Salvar</button></>}>
    <form id="customer-form" onSubmit={save} className="stack">
      <label className="field"><span>Nome</span><input required minLength={2} value={form.buyerName} onChange={(e) => setForm({ ...form, buyerName: e.target.value })} /></label>
      <label className="field"><span>Telefone</span><input inputMode="tel" value={form.buyerPhone} onChange={(e) => setForm({ ...form, buyerPhone: formatPhone(e.target.value) })} placeholder="(83) 99999-0000" /></label>
      <label className="field"><span>Equipe</span><select value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}>
        <option value="">Sem equipe / visitante</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      {error && <p className="alert alert-error">{error}</p>}
    </form>
  </Modal>;
}
