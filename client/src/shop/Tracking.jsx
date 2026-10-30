import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bike, Check, CheckCircle2, ChefHat, Clock3, Copy, Link2, PackageCheck, ReceiptText, Store, UtensilsCrossed } from 'lucide-react';
import { Badge, ErrorState, Spinner, useConfirm, useToast } from '../components/ui.jsx';
import { money, request, subscribe, time, fullDateTime } from '../lib/api.js';
import { PAYMENT_METHODS, PAYMENT_STATUS, customerStepLabel } from '../lib/labels.js';
import { paths } from '../lib/router.js';
import { recentOrders } from '../lib/storage.js';

const STEP_ICONS = { new: ReceiptText, in_production: ChefHat, ready: PackageCheck, awaiting_pickup: Store, finalized: CheckCircle2 };

function useCountdown(target) {
  const [left, setLeft] = useState(() => (target ? new Date(target).getTime() - Date.now() : 0));
  useEffect(() => {
    if (!target) return undefined;
    const tick = () => setLeft(new Date(target).getTime() - Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [target]);
  const safe = Math.max(0, left);
  return { expired: safe <= 0, text: `${String(Math.floor(safe / 60000)).padStart(2, '0')}:${String(Math.floor((safe % 60000) / 1000)).padStart(2, '0')}` };
}

function ReadyBanner({ order }) {
  if (order.status !== 'active') return null;
  const delivery = order.serviceType === 'delivery';
  if (order.productionStatus === 'ready') {
    return <div className="ready-banner"><PackageCheck size={26} /><div>
      <b>Seu pedido está pronto!</b>
      <span>{delivery ? 'Ele seguirá para entrega em instantes.' : `Ele já vai ser liberado para retirada. Fique atento à senha ${order.ticket ? `#${order.ticket}` : ''}.`}</span>
    </div></div>;
  }
  if (order.productionStatus === 'awaiting_pickup') {
    return <div className="ready-banner">{delivery ? <Bike size={26} /> : <Store size={26} />}<div>
      <b>{delivery ? 'Seu pedido saiu para entrega!' : 'Pode retirar seu pedido!'}</b>
      <span>{delivery ? `Endereço: ${order.deliveryAddress}` : `Apresente a senha ${order.ticket ? `#${order.ticket}` : ''} no balcão.`}</span>
    </div></div>;
  }
  return null;
}

function PaymentCard({ order, onClaim, claiming, pixError, onRetryPix }) {
  const toast = useToast();
  const countdown = useCountdown(order.paymentMethod === 'pix' && order.paymentStatus === 'awaiting_payment' ? order.expiresAt : null);
  const status = PAYMENT_STATUS[order.paymentStatus];
  const copy = async (text, done) => {
    try { await navigator.clipboard.writeText(text || ''); toast(done); }
    catch { toast('Não foi possível copiar. Selecione o código e copie manualmente.', 'error'); }
  };
  const awaitingPix = order.paymentMethod === 'pix' && order.paymentStatus === 'awaiting_payment' && order.status === 'active';
  return <section className="track-card">
    <header><h2>Pagamento</h2><Badge tone={status?.tone}>{status?.label}</Badge></header>
    <div className="pay-lines">
      <div><span>Forma escolhida</span><b>{PAYMENT_METHODS[order.paymentMethod]}</b></div>
      <div><span>Total</span><b>{money(order.total)}</b></div>
      {order.paid > 0 && <div><span>Recebido</span><b>{money(order.paid)}</b></div>}
      {order.cashChangeFor && <div><span>Troco para</span><b>{money(order.cashChangeFor)}</b></div>}
    </div>

    {order.paymentStatus === 'confirmed' && <p className="alert alert-success"><CheckCircle2 size={17} /> Pagamento confirmado.</p>}
    {order.paymentStatus === 'refunded' && <p className="alert alert-info">O valor deste pedido foi estornado.</p>}

    {awaitingPix && order.pixAutomatic && <div className="pix-box">
      <div className="pix-head"><span>Pague {money(order.balance)} via PIX</span>
        <span className={`countdown ${countdown.expired ? 'over' : ''}`}><Clock3 size={15} /> {countdown.text}</span></div>
      {order.pixCharge ? <>
        {order.pixCharge.qrCodeBase64 && <img className="pix-qr" src={`data:image/png;base64,${order.pixCharge.qrCodeBase64}`} alt="QR Code do PIX" width="220" height="220" />}
        <div className="pix-key"><small>PIX copia e cola</small><code>{order.pixCharge.qrCode}</code>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => copy(order.pixCharge.qrCode, 'Código PIX copiado!')}><Copy size={15} /> Copiar código</button></div>
        <p className="muted small">Abra o app do seu banco, escolha pagar com PIX e leia o QR Code ou cole o código. A confirmação é automática: esta tela atualiza sozinha.</p>
      </> : pixError
        ? <><p className="alert alert-warning"><AlertTriangle size={17} /> {pixError}</p>
          <button type="button" className="btn btn-primary btn-block" onClick={onRetryPix}>Gerar QR Code de novo</button></>
        : <Spinner label="Gerando o QR Code do PIX..." />}
    </div>}

    {awaitingPix && order.pix && <div className="pix-box">
      <div className="pix-head"><span>Pague {money(order.balance)} via PIX</span>
        <span className={`countdown ${countdown.expired ? 'over' : ''}`}><Clock3 size={15} /> {countdown.text}</span></div>
      <div className="pix-key"><small>Chave PIX ({order.pix.type})</small><code>{order.pix.key}</code>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => copy(order.pix.key, 'Chave PIX copiada!')}><Copy size={15} /> Copiar chave</button></div>
      <p className="muted small">Beneficiário: <b>{order.pix.beneficiary}</b>{order.pix.city ? ` · ${order.pix.city}` : ''}</p>
      {order.pix.instructions && <p className="small">{order.pix.instructions}</p>}
      <button type="button" className="btn btn-primary btn-block" disabled={claiming || countdown.expired} onClick={onClaim}><Check size={17} /> Já paguei — pedir conferência</button>
      <p className="muted small">Tocar no botão não confirma o pagamento: a equipe financeira confere o recebimento.</p>
    </div>}

    {order.paymentStatus === 'pending_review' && <p className="alert alert-info"><Clock3 size={17} /> Recebemos seu aviso de pagamento. A equipe financeira está conferindo o PIX.</p>}

    {order.onCredit && order.paymentStatus !== 'confirmed' && <p className="alert alert-info">Pedido anotado no fiado: {money(order.balance)} a pagar depois, no caixa da lanchonete.</p>}

    {order.status === 'active' && !order.onCredit && order.paymentMethod !== 'pix' && ['awaiting_payment', 'partial'].includes(order.paymentStatus) && <p className="alert alert-warning">
      Pague {money(order.balance)} em {PAYMENT_METHODS[order.paymentMethod].toLowerCase()} {order.serviceType === 'delivery' ? 'ao receber o pedido' : 'no caixa da lanchonete'}.
    </p>}
  </section>;
}

export default function Tracking({ token }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [pixError, setPixError] = useState('');

  const loaded = useRef(null);

  const load = useCallback(async () => {
    try {
      const data = await request(`/orders/${token}`);
      loaded.current = data;
      setOrder(data);
      setError('');
    } catch (err) {
      // Falha temporária de rede mantém a última informação na tela.
      if (err.status === 404 || !loaded.current) setError(err.message);
    }
  }, [token]);

  useEffect(() => { loaded.current = null; setOrder(null); setError(''); load(); }, [load]);
  useEffect(() => subscribe(`/orders/${token}/events`, { onChange: () => load(), onStatus: setLive }), [token, load]);
  // Segurança extra: recarrega periodicamente (mais vezes quando o tempo real cai).
  useEffect(() => {
    const timer = setInterval(load, live ? 60000 : 8000);
    return () => clearInterval(timer);
  }, [live, load]);
  // O cronômetro do PIX zerou: busca o estado oficial no servidor.
  useEffect(() => {
    if (!order?.expiresAt || order.paymentStatus !== 'awaiting_payment' || order.status !== 'active') return undefined;
    const wait = new Date(order.expiresAt).getTime() - Date.now() + 1500;
    const timer = setTimeout(load, Math.max(1000, wait));
    return () => clearTimeout(timer);
  }, [order?.expiresAt, order?.paymentStatus, order?.status, load]);

  // PIX automático: gera o QR Code se ainda não existir e confere no Mercado Pago enquanto aguarda.
  const waitingAutoPix = Boolean(order?.pixAutomatic && order.status === 'active' && order.paymentMethod === 'pix' && order.paymentStatus === 'awaiting_payment');
  // Tentar de novo só limpa o erro: o efeito abaixo gera o QR Code (uma chamada por vez).
  const createPix = useCallback(async () => {
    try { await request(`/orders/${token}/pix`, { method: 'POST' }); await load(); }
    catch (err) { setPixError(err.message); }
  }, [token, load]);
  useEffect(() => { if (waitingAutoPix && !order.pixCharge && !pixError) createPix(); }, [waitingAutoPix, order?.pixCharge, pixError, createPix]);
  useEffect(() => {
    if (!waitingAutoPix || !order.pixCharge) return undefined;
    const timer = setInterval(async () => {
      try { const result = await request(`/orders/${token}/pix/check`, { method: 'POST' }); if (result.paymentStatus !== 'awaiting_payment') await load(); }
      catch { /* tenta de novo no próximo ciclo */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [waitingAutoPix, order?.pixCharge, token, load]);

  const claim = async () => {
    const ok = await confirm({ title: 'Você já fez o PIX?', message: `Confirme somente depois de concluir a transferência de ${money(order.balance)} para a chave informada.`, confirmLabel: 'Sim, já paguei' });
    if (!ok) return;
    setClaiming(true);
    try { const result = await request(`/orders/${token}/claim-payment`, { method: 'POST' }); toast(result.message, 'info'); await load(); }
    catch (err) { toast(err.message, 'error'); await load(); }
    finally { setClaiming(false); }
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(window.location.href); toast('Link do pedido copiado.'); }
    catch { toast('Copie o endereço da página para acompanhar depois.', 'info'); }
  };

  if (error) return <main className="page page-narrow"><ErrorState message={error} onRetry={load} /></main>;
  if (!order) return <main className="page page-narrow"><Spinner label="Buscando seu pedido..." /></main>;

  const current = order.timeline.findIndex((step) => step.current);
  const ServiceIcon = order.serviceType === 'delivery' ? Bike : order.serviceType === 'dine_in' ? UtensilsCrossed : Store;
  return <main className="page page-narrow tracking-page">
    <section className="track-hero">
      <div className="ticket">{order.ticket ? <><small>Senha</small><b>#{order.ticket}</b></> : <ReceiptText size={30} />}</div>
      <div className="track-hero-info">
        <span className="eyebrow">Pedido {order.orderNumber}</span>
        <h1>{order.status === 'cancelled' ? 'Pedido cancelado' : order.status === 'expired' ? 'Prazo de pagamento encerrado' : `Obrigado, ${order.buyerName.split(' ')[0]}!`}</h1>
        <p><ServiceIcon size={15} /> {order.serviceLabel}{order.tableNumber ? ` · Mesa ${order.tableNumber}` : ''} · {fullDateTime(order.createdAt)}</p>
      </div>
      <span className="live-dot on" title="Esta página se atualiza sozinha">Atualização automática</span>
    </section>

    {order.status === 'cancelled' && <p className="alert alert-error"><AlertTriangle size={18} /> Este pedido foi cancelado{order.cancelReason ? `: ${order.cancelReason}` : '.'}</p>}
    {order.status === 'expired' && <p className="alert alert-warning"><AlertTriangle size={18} /> O prazo para o PIX terminou sem confirmação. Se você já pagou, procure a equipe financeira informando o pedido {order.orderNumber}.</p>}
    <ReadyBanner order={order} />

    <div className="track-grid">
      <section className="track-card">
        <header><h2>Preparo</h2></header>
        <ol className={`timeline ${order.status !== 'active' ? 'muted-timeline' : ''}`}>
          {order.timeline.map((step, index) => {
            const Icon = STEP_ICONS[step.step];
            const state = index < current || (step.current && step.step === 'finalized') ? 'done' : step.current ? 'current' : 'todo';
            return <li key={step.step} className={`tl-${state}`}>
              <span className="tl-dot"><Icon size={16} /></span>
              <span className="tl-text"><b>{customerStepLabel(step.step, order.serviceType)}</b><small>{step.at ? time(step.at) : state === 'todo' ? 'Aguardando' : ''}</small></span>
            </li>;
          })}
        </ol>
        {order.instructions && order.status === 'active' && <p className="muted small">{order.instructions}</p>}
        {order.serviceType === 'delivery' && <p className="small"><b>Entrega em:</b> {order.deliveryAddress}{order.deliveryReference ? ` — ${order.deliveryReference}` : ''}</p>}
      </section>

      <PaymentCard order={order} onClaim={claim} claiming={claiming} pixError={pixError} onRetryPix={() => setPixError('')} />
    </div>

    <section className="track-card">
      <header><h2>Itens do pedido</h2></header>
      <ul className="order-items">
        {order.items.map((item, index) => <li key={index}>
          <span className="qty-tag">{item.quantity}×</span>
          <div><b>{item.name}</b>
            {item.options.length > 0 && <small>{item.options.map((o) => o.option).join(' · ')}</small>}
            {item.customText && <small>{item.customTextLabel}: {item.customText}</small>}
            {item.note && <small className="note">Obs.: {item.note}</small>}</div>
          <b>{money(item.total)}</b>
        </li>)}
      </ul>
      <div className="summary-row"><span>Subtotal</span><b>{money(order.subtotal)}</b></div>
      {order.deliveryFee > 0 && <div className="summary-row"><span>Taxa de entrega</span><b>{money(order.deliveryFee)}</b></div>}
      <div className="summary-row total"><span>Total</span><b>{money(order.total)}</b></div>
    </section>

    <div className="track-actions">
      <button type="button" className="btn btn-outline" onClick={copyLink}><Link2 size={16} /> Copiar link do pedido</button>
      <a className="btn btn-ghost" href={paths.catalog(order.mode)}>Fazer outro pedido</a>
    </div>
    {order.contactPhone && <p className="muted small center">Dúvidas? Fale com a equipe: {order.contactPhone}</p>}
  </main>;
}

export function LookupPage() {
  const [form, setForm] = useState({ code: '', phone: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const recent = recentOrders();
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const result = await request('/orders/lookup', { method: 'POST', body: form });
      window.location.hash = paths.tracking(result.token);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <main className="page page-narrow lookup-page">
    <section className="lookup-card">
      <h1>Consultar pedido</h1>
      <p className="muted">Informe o número do pedido (ou a senha do dia) e o telefone usado na compra.</p>
      <form onSubmit={submit} className="stack">
        <label className="field"><span>Número do pedido ou senha</span>
          <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="Ex.: AG-261008-3FA2C1 ou 14" autoCapitalize="characters" /></label>
        <label className="field"><span>Telefone (com DDD)</span>
          <input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" placeholder="(83) 99999-0000" /></label>
        {error && <p className="alert alert-error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Consultando...' : 'Consultar'}</button>
      </form>
    </section>
    {recent.length > 0 && <section className="lookup-recent">
      <h2>Pedidos feitos neste aparelho</h2>
      <ul className="recent-orders">{recent.map((item) => <li key={item.token}>
        <a href={paths.tracking(item.token)}>
          <span className="ticket-sm">{item.ticket ? `#${item.ticket}` : '—'}</span>
          <span><b>{item.orderNumber}</b><small>{item.mode === 'snack' ? 'Lanchonete' : 'Artigos religiosos'} · {fullDateTime(item.savedAt)}</small></span>
          <b>{money(item.total)}</b>
        </a>
      </li>)}</ul>
    </section>}
  </main>;
}

export function MyOrders() {
  const list = recentOrders();
  return <main className="page page-narrow">
    <h1 className="page-title">Meus pedidos</h1>
    <p className="muted">Pedidos feitos neste aparelho. Por segurança, só é possível acompanhar um pedido pelo link recebido ao finalizar a compra.</p>
    {list.length === 0 ? <p className="alert alert-info">Nenhum pedido feito neste aparelho ainda.</p>
      : <ul className="recent-orders">{list.map((item) => <li key={item.token}>
        <a href={paths.tracking(item.token)}>
          <span className="ticket-sm">{item.ticket ? `#${item.ticket}` : '—'}</span>
          <span><b>{item.orderNumber}</b><small>{item.mode === 'snack' ? 'Lanchonete' : 'Artigos religiosos'} · {fullDateTime(item.savedAt)}</small></span>
          <b>{money(item.total)}</b>
        </a>
      </li>)}</ul>}
  </main>;
}
