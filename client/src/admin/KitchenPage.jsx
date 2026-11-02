import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Bell, BellOff, Clock3, MapPin, Printer, RotateCcw, Search, Tv } from 'lucide-react';
import { ErrorState, Spinner, useNow } from '../components/ui.jsx';
import { elapsed, time } from '../lib/api.js';
import { beep } from '../lib/beep.js';
import { printComanda } from './comanda.js';
import { ADVANCE_LABELS, PAYMENT_STATUS, PRODUCTION_LABELS, PRODUCTION_STEPS, SERVICE_TYPES } from '../lib/labels.js';
import { readJson, writeJson } from '../lib/storage.js';
import { useAdmin, useLiveRefresh } from './context.js';
import { OrderDetail, OrderItems, PaymentBadge, PeriodFilter, ServiceBadge, productionActions, useProductionMove, usePeriod } from './shared.jsx';

// Momento em que o pedido entrou na etapa atual (base para o tempo de espera).
const STAGE_SINCE = { new: 'createdAt', in_production: 'productionStartedAt', ready: 'readyAt', awaiting_pickup: 'awaitingPickupAt', finalized: 'finalizedAt' };
// Minutos de espera para alerta (amarelo) e atraso (vermelho) em cada etapa.
const LIMITS = { new: [5, 10], in_production: [15, 25], ready: [5, 10], awaiting_pickup: [10, 20] };

// Pedido com algo para a cozinha preparar (itens antigos, sem a marcação, contam como cozinha).
const hasKitchenItems = (order) => order.items.some((item) => item.kitchen !== false);

function waitLevel(order, now) {
  const limits = LIMITS[order.productionStatus];
  const since = order[STAGE_SINCE[order.productionStatus]] || order.createdAt;
  if (!limits || !since) return '';
  const minutes = (now - new Date(since).getTime()) / 60000;
  return minutes >= limits[1] ? 'late' : minutes >= limits[0] ? 'warn' : '';
}

function KitchenCard({ order, now, role, requirePix, busy, onMove, onOpen, fresh }) {
  const { next, previous, ahead } = productionActions(order, role);
  const waitingPix = next === 'in_production' && requirePix && order.paymentMethod === 'pix' && !order.onCredit && order.paymentStatus !== 'confirmed';
  const since = order[STAGE_SINCE[order.productionStatus]] || order.createdAt;
  const level = waitLevel(order, now);
  const draggable = Boolean(next || previous) && !busy;
  return <article className={`k-card ${level ? `k-${level}` : ''} ${fresh ? 'k-fresh' : ''}`} draggable={draggable}
    onDragStart={(event) => { event.dataTransfer.setData('text/plain', String(order.id)); event.dataTransfer.effectAllowed = 'move'; }}>
    <div role="button" tabIndex={0} className="k-card-body" onClick={() => onOpen(order.id)} onKeyDown={(event) => { if (event.key === 'Enter') onOpen(order.id); }} aria-label={`Abrir pedido ${order.ticket}`}>
      <header>
        <b className="k-ticket">{order.ticket ? `#${order.ticket}` : order.orderNumber.slice(-6)}</b>
        <span className="k-time"><Clock3 size={13} /> {time(order.createdAt)}</span>
        {order.productionStatus !== 'finalized' && <span className={`k-elapsed ${level}`}>{level === 'late' && <AlertTriangle size={12} />}{elapsed(since, now)}</span>}
      </header>
      <div className="k-buyer"><b>{order.buyerName}</b><span>{order.teamName}</span></div>
      <div className="k-badges"><ServiceBadge order={order} /><PaymentBadge order={order} /></div>
      {order.orderNote && <p className="k-note">Obs.: {order.orderNote}</p>}
      {order.serviceType === 'delivery' && <p className="k-address"><MapPin size={13} /> {order.deliveryAddress}{order.deliveryReference ? ` — ${order.deliveryReference}` : ''}</p>}
      {(() => {
        // Itens do balcão (salgado, café, bebida) aparecem discretos: a cozinha foca no que precisa preparar.
        const kitchenItems = order.items.filter((item) => item.kitchen !== false);
        const counterItems = order.items.filter((item) => item.kitchen === false);
        if (!kitchenItems.length) return <OrderItems items={order.items} compact />;
        return <><OrderItems items={kitchenItems} compact />
          {counterItems.length > 0 && <small className="k-counter">No balcão: {counterItems.map((item) => `${item.quantity}× ${item.name}`).join(', ')}</small>}</>;
      })()}
      {order.productionStartedAt && order.productionStatus === 'in_production' && <small className="muted">Produção iniciada às {time(order.productionStartedAt)}</small>}
      <small className="k-number">{order.orderNumber}</small>
    </div>
    <footer>
      <button type="button" className="icon-btn" title="Imprimir comanda" onClick={() => printComanda(order)}><Printer size={16} /></button>
      {previous && <button type="button" className="icon-btn" title="Voltar etapa (correção)" disabled={busy} onClick={() => onMove(order, previous)}><RotateCcw size={16} /></button>}
      {next && (waitingPix
        ? <span className="k-wait">Aguardando confirmação do PIX</span>
        : <button type="button" className={`btn btn-sm ${next === 'finalized' ? 'btn-success' : 'btn-primary'}`} disabled={busy} onClick={() => onMove(order, next)}>{ADVANCE_LABELS[next]} <ArrowRight size={15} /></button>)}
      {!waitingPix && ahead.length > 0 && <select className="k-skip" value="" disabled={busy} aria-label="Pular para outra etapa" onChange={(e) => e.target.value && onMove(order, e.target.value)}>
        <option value="">Pular para…</option>
        {ahead.map((step) => <option key={step} value={step}>{PRODUCTION_LABELS[step]}</option>)}
      </select>}
    </footer>
  </article>;
}

export default function KitchenPage() {
  const { call, user } = useAdmin();
  const period = usePeriod('today');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ q: '', team: '', service: '', payment: '' });
  const [openId, setOpenId] = useState(null);
  const [sound, setSound] = useState(() => readJson('eag-kitchen-sound', false));
  const [fresh, setFresh] = useState(new Set());
  const [dragOver, setDragOver] = useState(null);
  const [showAllDone, setShowAllDone] = useState(false);
  const known = useRef(null);
  const now = useNow(20000);
  const columnsRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const result = await call(`/admin/kitchen?${period.query}`);
      // Destaca (e avisa com som) pedidos que acabaram de chegar.
      // Só conta como novo (som/impressão) o que aparece neste aparelho.
      const ids = new Set(result.orders.filter((o) => readJson('eag-kitchen-show-counter', false) || hasKitchenItems(o)).map((o) => o.id));
      if (known.current) {
        const arrived = [...ids].filter((id) => !known.current.has(id));
        if (arrived.length) {
          setFresh((current) => new Set([...current, ...arrived]));
          setTimeout(() => setFresh((current) => new Set([...current].filter((id) => !arrived.includes(id)))), 15000);
          if (readJson('eag-kitchen-sound', false)) beep();
          // Aparelho com a impressora: imprime sozinho a comanda de cada pedido novo.
          if (readJson('eag-kitchen-autoprint', false)) result.orders.filter((o) => arrived.includes(o.id) && hasKitchenItems(o)).forEach(printComanda);
        }
      }
      known.current = ids;
      setData(result); setError('');
    } catch (err) { setError(err.message); }
  }, [call, period.query]);
  useEffect(() => { known.current = null; load(); }, [load]);
  useLiveRefresh(load);
  // Conferência periódica caso algum evento em tempo real se perca.
  useEffect(() => { const timer = setInterval(load, 60000); return () => clearInterval(timer); }, [load]);

  const { move, busyId } = useProductionMove(load);
  const toggleSound = () => { const value = !sound; setSound(value); writeJson('eag-kitchen-sound', value); if (value) beep(); };
  const [autoPrint, setAutoPrint] = useState(() => readJson('eag-kitchen-autoprint', false));
  // Pedidos só com itens do balcão: escondidos na cozinha; o notebook do balcão liga para entregar.
  const [showCounter, setShowCounter] = useState(() => readJson('eag-kitchen-show-counter', false));
  const toggleShowCounter = () => { const value = !showCounter; setShowCounter(value); writeJson('eag-kitchen-show-counter', value); };
  const toggleAutoPrint = () => { const value = !autoPrint; setAutoPrint(value); writeJson('eag-kitchen-autoprint', value); };

  const teams = useMemo(() => [...new Set((data?.orders || []).map((o) => o.teamName))].sort(), [data]);
  const filtered = useMemo(() => {
    const term = filters.q.trim().toLowerCase().replace(/^#/, '');
    return (data?.orders || []).filter((o) => (showCounter || hasKitchenItems(o)) && (!term || String(o.ticket) === term || o.orderNumber.toLowerCase().includes(term) || o.buyerName.toLowerCase().includes(term))
      && (!filters.team || o.teamName === filters.team) && (!filters.service || o.serviceType === filters.service) && (!filters.payment || o.paymentStatus === filters.payment));
  }, [data, filters, showCounter]);
  const columns = useMemo(() => Object.fromEntries(PRODUCTION_STEPS.map((step) => {
    const list = filtered.filter((o) => o.productionStatus === step);
    // Mais antigos primeiro; finalizados mostram os mais recentes primeiro.
    if (step === 'finalized') list.sort((a, b) => new Date(b.finalizedAt || 0) - new Date(a.finalizedAt || 0));
    return [step, list];
  })), [filtered]);

  const onDrop = (step) => (event) => {
    event.preventDefault();
    setDragOver(null);
    const id = Number(event.dataTransfer.getData('text/plain'));
    const order = data?.orders.find((o) => o.id === id);
    if (!order || order.productionStatus === step) return;
    const { next, previous, ahead } = productionActions(order, user.role);
    if (step !== next && step !== previous && !ahead.includes(step)) return;
    if (PRODUCTION_STEPS.indexOf(step) >= PRODUCTION_STEPS.indexOf('in_production') && order.productionStatus === 'new' && data.requirePixConfirmation && order.paymentMethod === 'pix' && !order.onCredit && order.paymentStatus !== 'confirmed') return;
    move(order, step);
  };
  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));

  // Modo TV: quadro em tela cheia para a TV da cozinha (sem menu e filtros, letras maiores, sem "Finalizados").
  const [tv, setTv] = useState(() => readJson('eag-kitchen-tv', false));
  const toggleTv = () => {
    const value = !tv;
    setTv(value); writeJson('eag-kitchen-tv', value);
    if (value) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  };
  useEffect(() => {
    document.body.classList.toggle('kitchen-tv', tv);
    return () => document.body.classList.remove('kitchen-tv');
  }, [tv]);
  const clock = new Date(now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const steps = tv ? PRODUCTION_STEPS.filter((step) => step !== 'finalized') : PRODUCTION_STEPS;

  return <div className={`admin-page kitchen-page ${tv ? 'is-tv' : ''}`}>
    {tv && <header className="k-tv-bar">
      <b>Cozinha</b>
      <span className="k-tv-counts">{steps.map((step) => <span key={step}>{PRODUCTION_LABELS[step]} <b>{columns[step]?.length ?? 0}</b></span>)}</span>
      <time>{clock}</time>
      <button type="button" className="btn btn-outline btn-sm" onClick={toggleSound}>{sound ? <Bell size={15} /> : <BellOff size={15} />} Som</button>
      <button type="button" className="btn btn-outline btn-sm" onClick={toggleTv}>Sair do modo TV</button>
    </header>}
    <header className="admin-page-head">
      <div><h1>Cozinha / Produção</h1><p>Pedidos da lanchonete, do mais antigo para o mais novo em cada etapa.</p></div>
      <div className="head-actions">
        <button type="button" className={`btn btn-sm ${showCounter ? 'btn-primary' : 'btn-outline'}`} onClick={toggleShowCounter} title="Pedidos só com salgados, cafés, bebidas e doces (saem prontos do balcão)">
          Pedidos do balcão: {showCounter ? 'mostrando' : 'ocultos'}</button>
        <button type="button" className="btn btn-outline btn-sm" onClick={toggleAutoPrint} title="Imprime a comanda de cada pedido novo neste aparelho">
          <Printer size={15} /> Imprimir novos: {autoPrint ? 'sim' : 'não'}</button>
        <button type="button" className="btn btn-outline btn-sm" onClick={toggleSound} title="Aviso sonoro de novo pedido">{sound ? <Bell size={15} /> : <BellOff size={15} />} Som {sound ? 'ligado' : 'desligado'}</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={toggleTv} title="Tela cheia para a TV da cozinha"><Tv size={15} /> Modo TV</button>
      </div>
    </header>

    <div className="filters-bar">
      <PeriodFilter period={period} />
      <label className="search-field"><Search size={16} /><input value={filters.q} onChange={set('q')} placeholder="Senha, nº do pedido ou cliente" /></label>
      <select value={filters.team} onChange={set('team')} aria-label="Equipe"><option value="">Todas as equipes</option>{teams.map((t) => <option key={t} value={t}>{t}</option>)}</select>
      <select value={filters.service} onChange={set('service')} aria-label="Atendimento"><option value="">Todo atendimento</option>{Object.entries(SERVICE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <select value={filters.payment} onChange={set('payment')} aria-label="Pagamento"><option value="">Todo pagamento</option>{Object.entries(PAYMENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
    </div>

    {data?.staleOpen > 0 && <p className="alert alert-warning"><AlertTriangle size={17} /> Há {data.staleOpen} {data.staleOpen === 1 ? 'pedido em aberto' : 'pedidos em aberto'} de dias anteriores ao período exibido.
      <button type="button" className="btn btn-sm btn-outline" onClick={() => period.setPreset('week')}>Ver últimos 7 dias</button></p>}

    {error && !data ? <ErrorState message={error} onRetry={load} /> : !data ? <Spinner /> : <>
      {error && <p className="alert alert-error">{error}</p>}
      <nav className="k-jump" aria-label="Ir para coluna">
        {PRODUCTION_STEPS.map((step) => <button type="button" key={step} onClick={() => columnsRef.current?.querySelector(`[data-step="${step}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })}>
          {PRODUCTION_LABELS[step]} <b>{columns[step].length}</b></button>)}
      </nav>
      <div className="kanban" ref={columnsRef}>
        {steps.map((step) => {
          const list = step === 'finalized' && !showAllDone ? columns[step].slice(0, 20) : columns[step];
          return <section key={step} data-step={step} className={`k-col k-col-${step} ${dragOver === step ? 'drag-over' : ''}`}
            onDragOver={(event) => { event.preventDefault(); setDragOver(step); }} onDragLeave={() => setDragOver(null)} onDrop={onDrop(step)}>
            <header><h2>{PRODUCTION_LABELS[step]}</h2><span className="k-count">{columns[step].length}</span></header>
            <div className="k-list">
              {list.length === 0 ? <p className="k-empty">Nenhum pedido</p> : list.map((order) => <KitchenCard key={order.id} order={order} now={now} role={user.role}
                requirePix={data.requirePixConfirmation} busy={busyId === order.id} onMove={move} onOpen={setOpenId} fresh={fresh.has(order.id)} />)}
              {step === 'finalized' && columns[step].length > 20 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAllDone((v) => !v)}>
                {showAllDone ? 'Mostrar menos' : `Mostrar todos (${columns[step].length})`}</button>}
            </div>
          </section>;
        })}
      </div>
    </>}
    {openId && <OrderDetail orderId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
  </div>;
}
