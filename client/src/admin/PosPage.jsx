// Venda no balcão: a equipe registra o pedido, identifica o cliente e recebe na hora, deixa no fiado ou para pagar depois.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Minus, Plus, Printer, Search, Trash2 } from 'lucide-react';
import { ErrorState, Modal, Spinner } from '../components/ui.jsx';
import { imageUrl, money, request, uuid } from '../lib/api.js';
import { printComanda } from './comanda.js';
import { PAYMENT_METHODS, SERVICE_TYPES } from '../lib/labels.js';
import { ProductThumb, startingPrice } from '../shop/productUtils.jsx';
import ProductModal from '../shop/ProductModal.jsx';
import { useAdmin, useLiveRefresh } from './context.js';
import { OpenCashInline, PaymentLines, formatPhone, hasCashLine, hasCreditLine, linesError, linesPayload, newPaymentLines, useRegisterMethods, useTeams } from './shared.jsx';

const emptyCustomer = { buyerName: '', buyerPhone: '', teamId: '', serviceType: 'dine_in', tableNumber: '', deliveryAddress: '', deliveryReference: '' };

export default function PosPage() {
  const { call, can } = useAdmin();
  const teams = useTeams();
  const methods = useRegisterMethods();
  const [mode, setMode] = useState('snack');
  const [catalog, setCatalog] = useState(null);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [lines, setLines] = useState([]);
  const [configuring, setConfiguring] = useState(null);
  const [customer, setCustomer] = useState(emptyCustomer);
  const [payType, setPayType] = useState('pay');
  const [payLines, setPayLines] = useState([]);
  const [laterMethod, setLaterMethod] = useState('cash');
  const [cashOpen, setCashOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [done, setDone] = useState(null);
  const requestId = useRef(uuid());
  const payKey = useRef(uuid());

  const load = useCallback(async () => {
    try {
      const [data, cfg] = await Promise.all([request(`/catalog?mode=${mode}`), request('/public-config')]);
      setCatalog(data); setConfig(cfg); setError('');
    } catch (err) { setError(err.message); }
  }, [mode]);
  useEffect(() => { setCatalog(null); setCategory('all'); setLines([]); load(); }, [load]);
  const checkCash = useCallback(() => call('/admin/cash-status').then((r) => setCashOpen(r.open)).catch(() => {}), [call]);
  useEffect(() => { checkCash(); }, [checkCash]);
  useLiveRefresh(checkCash, ['cash']);

  const deliveryFee = customer.serviceType === 'delivery' ? Number(config?.deliveryFee || 0) : 0;
  const subtotal = Math.round(lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0) * 100) / 100;
  const totalCents = Math.round((subtotal + deliveryFee) * 100);
  // Mantém o valor da forma de pagamento acompanhando o total enquanto há uma só forma.
  useEffect(() => {
    setPayLines((current) => (current.length <= 1 ? newPaymentLines(totalCents, current[0]?.method || 'cash') : current));
  }, [totalCents]);

  useEffect(() => { setPayLines((current) => current.map((line) => (methods.includes(line.method) ? line : { ...line, method: 'pix' }))); }, [methods]);

  const products = useMemo(() => (catalog?.products || []).filter((p) => (category === 'all' || String(p.categoryId) === String(category))
    && (!search || p.name.toLowerCase().includes(search.toLowerCase()))), [catalog, category, search]);

  const addLine = (line) => setLines((current) => {
    const same = current.find((l) => l.productId === line.productId && l.note === line.note && l.customText === line.customText && JSON.stringify(l.selectedOptions) === JSON.stringify(line.selectedOptions));
    if (same) return current.map((l) => (l === same ? { ...l, quantity: Math.min(30, l.quantity + line.quantity) } : l));
    return [...current, { ...line, key: uuid() }];
  });
  const quickAdd = (product) => {
    if (product.optionGroups.length || product.customTextLabel) { setConfiguring(product); return; }
    addLine({ productId: product.id, name: product.name, unitPrice: product.price, quantity: 1, selectedOptions: [], optionLabels: [], note: '', customText: '' });
  };
  const setQty = (key, quantity) => setLines((current) => (quantity <= 0 ? current.filter((l) => l.key !== key) : current.map((l) => (l.key === key ? { ...l, quantity: Math.min(30, quantity) } : l))));
  const set = (key) => (event) => setCustomer((c) => ({ ...c, [key]: key === 'buyerPhone' ? formatPhone(event.target.value) : event.target.value }));

  const reset = () => {
    setLines([]); setCustomer(emptyCustomer); setPayType('pay'); setPayLines(newPaymentLines(0, 'cash')); setFormError('');
    requestId.current = uuid(); payKey.current = uuid();
  };

  const phoneOk = customer.buyerPhone.replace(/\D/g, '').length >= 10;
  const validation = (() => {
    if (!lines.length) return 'Adicione itens à venda.';
    if (customer.buyerName.trim().length < 2) return 'Informe o nome do cliente.';
    if (customer.buyerPhone && !phoneOk) return 'Telefone incompleto: informe com DDD.';
    if (customer.serviceType === 'delivery' && (customer.deliveryAddress.trim().length < 5 || !phoneOk)) return 'Delivery: informe endereço e telefone.';
    if (payType === 'credit' && !phoneOk) return 'Fiado: informe o telefone do cliente para a cobrança.';
    if (payType === 'pay') {
      if (hasCreditLine(payLines) && !phoneOk) return 'Para deixar parte no fiado, informe o telefone do cliente.';
      if (hasCashLine(payLines) && !cashOpen) return 'O caixa está fechado: abra o caixa ou use "Fiado" / "Pagar depois".';
      return linesError(payLines, totalCents);
    }
    return '';
  })();

  const submit = async () => {
    if (validation) { setFormError(validation); return; }
    setBusy(true); setFormError('');
    try {
      const payment = payType === 'pay' ? { type: 'pay', idempotencyKey: payKey.current, lines: linesPayload(payLines) }
        : payType === 'credit' ? { type: 'credit' } : { type: 'later', method: laterMethod };
      const result = await call('/admin/pos/orders', { method: 'POST', body: {
        clientRequestId: requestId.current, mode, buyerName: customer.buyerName.trim(), buyerPhone: customer.buyerPhone.trim(), teamId: customer.teamId || null,
        serviceType: customer.serviceType, tableNumber: customer.serviceType === 'dine_in' ? customer.tableNumber : '',
        deliveryAddress: customer.serviceType === 'delivery' ? customer.deliveryAddress : '', deliveryReference: customer.serviceType === 'delivery' ? customer.deliveryReference : '',
        items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, selectedOptions: l.selectedOptions, note: l.note || '', customText: l.customText || '' })),
        payment
      } });
      setDone({ ...result, payType });
      reset();
    } catch (err) {
      setFormError(err.code === 'NETWORK' ? 'A conexão falhou. Toque em "Concluir venda" de novo: a venda não será duplicada.' : err.message);
      if (err.code === 'NO_CASH_SESSION') checkCash();
    } finally { setBusy(false); }
  };

  if (error) return <div className="admin-page"><ErrorState message={error} onRetry={load} /></div>;
  const services = mode === 'religious' ? ['pickup', 'delivery'] : ['dine_in', 'pickup', 'delivery'];

  return <div className="admin-page pos-page">
    <header className="admin-page-head">
      <div><h1>Venda no balcão</h1><p>Registre o pedido do cliente. Ele vai direto para a cozinha.</p></div>
      <div className="segmented">
        <button type="button" className={mode === 'snack' ? 'active' : ''} onClick={() => setMode('snack')}>Lanchonete</button>
        <button type="button" className={mode === 'religious' ? 'active' : ''} onClick={() => setMode('religious')}>Artigos religiosos</button>
      </div>
    </header>
    <div className="pos-layout">
      <section className="pos-products">
        <div className="pos-tools">
          <label className="search-field"><Search size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar produto" /></label>
          <div className="chips">
            <button type="button" className={category === 'all' ? 'chip active' : 'chip'} onClick={() => setCategory('all')}>Todos</button>
            {(catalog?.categories || []).map((c) => <button type="button" key={c.id} className={String(category) === String(c.id) ? 'chip active' : 'chip'} onClick={() => setCategory(c.id)}>{c.name}</button>)}
          </div>
        </div>
        {!catalog ? <Spinner /> : products.length === 0 ? <p className="muted pad">{catalog.products.length ? 'Nenhum produto encontrado.' : 'Nenhum produto disponível neste catálogo.'}</p>
          : <div className="pos-grid">{products.map((p) => <button type="button" key={p.id} className="pos-tile" onClick={() => quickAdd(p)}>
            <ProductThumb product={p} size="md" /><span><b>{p.name}</b><small>{money(startingPrice(p).price)}</small></span>
          </button>)}</div>}
      </section>

      <section className="pos-ticket">
        <h2>Pedido</h2>
        {lines.length === 0 ? <p className="muted">Toque nos produtos para adicionar.</p> : <ul className="pos-lines">
          {lines.map((l) => <li key={l.key}>
            <div><b>{l.name}</b>{l.optionLabels.length > 0 && <small>{l.optionLabels.join(', ')}</small>}{l.note && <small>Obs.: {l.note}</small>}</div>
            <div className="qty qty-sm">
              <button type="button" onClick={() => setQty(l.key, l.quantity - 1)} aria-label="Diminuir">{l.quantity === 1 ? <Trash2 size={13} /> : <Minus size={14} />}</button>
              <span>{l.quantity}</span>
              <button type="button" onClick={() => setQty(l.key, l.quantity + 1)} aria-label="Aumentar"><Plus size={14} /></button>
            </div>
            <span className="line-total">{money(l.unitPrice * l.quantity)}</span>
          </li>)}
        </ul>}

        <h3>Cliente</h3>
        <div className="grid-2">
          <label className="field"><span>Nome *</span><input value={customer.buyerName} onChange={set('buyerName')} maxLength={120} /></label>
          <label className="field"><span>Telefone {payType === 'credit' || customer.serviceType === 'delivery' ? '*' : ''}</span><input value={customer.buyerPhone} onChange={set('buyerPhone')} inputMode="tel" placeholder="(83) 99999-0000" /></label>
        </div>
        <label className="field"><span>Equipe</span><select value={customer.teamId} onChange={set('teamId')}><option value="">Sem equipe / visitante</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>

        <h3>Atendimento</h3>
        <div className="segmented full">{services.map((type) => <button type="button" key={type} className={customer.serviceType === type ? 'active' : ''} onClick={() => setCustomer((c) => ({ ...c, serviceType: type }))}>{SERVICE_TYPES[type]}</button>)}</div>
        {customer.serviceType === 'dine_in' && <label className="field"><span>Mesa (opcional)</span><input value={customer.tableNumber} onChange={(e) => setCustomer((c) => ({ ...c, tableNumber: e.target.value.replace(/\D/g, '').slice(0, 4) }))} inputMode="numeric" /></label>}
        {customer.serviceType === 'delivery' && <div className="grid-2">
          <label className="field"><span>Endereço *</span><input value={customer.deliveryAddress} onChange={set('deliveryAddress')} maxLength={300} /></label>
          <label className="field"><span>Referência</span><input value={customer.deliveryReference} onChange={set('deliveryReference')} maxLength={200} /></label>
        </div>}

        <div className="pos-totals">
          <div><span>Subtotal</span><b>{money(subtotal)}</b></div>
          {deliveryFee > 0 && <div><span>Taxa de entrega</span><b>{money(deliveryFee)}</b></div>}
          <div className="grand"><span>Total</span><b>{money(totalCents / 100)}</b></div>
        </div>

        <h3>Pagamento</h3>
        <div className="segmented full">
          <button type="button" className={payType === 'pay' ? 'active' : ''} onClick={() => setPayType('pay')}>Pagar agora</button>
          {can('credits.manage') && <button type="button" className={payType === 'credit' ? 'active' : ''} onClick={() => setPayType('credit')}>Fiado</button>}
          <button type="button" className={payType === 'later' ? 'active' : ''} onClick={() => setPayType('later')}>Pagar depois</button>
        </div>
        {payType === 'pay' && <>
          {/* Atalho: o total inteiro numa forma só, com um toque. Para dividir, use as linhas abaixo. */}
          <div className="segmented full pay-quick" role="group" aria-label="Forma de pagamento">
            {methods.filter((m) => m !== 'fiado').map((method) => {
              const active = payLines.length === 1 && payLines[0].method === method;
              return <button type="button" key={method} className={active ? 'active' : ''}
                onClick={() => setPayLines(newPaymentLines(totalCents, method))}>{PAYMENT_METHODS[method]}</button>;
            })}
          </div>
          {payLines.length === 1 && payLines[0].method === 'pix' && <div className="pix-counter">
            {config?.pix?.qrImage && <img src={imageUrl(config.pix.qrImage)} alt="QR Code do PIX" />}
            <p><b>PIX de {money(totalCents / 100)}</b>{config?.pix?.key ? <span>Chave: {config.pix.key}</span> : null}
              <small>Confira o recebimento no celular antes de concluir a venda.</small></p>
          </div>}
          {!cashOpen && hasCashLine(payLines) && <OpenCashInline onOpened={checkCash} />}
          <PaymentLines lines={payLines} setLines={setPayLines} methods={methods} totalCents={totalCents} />
          {hasCreditLine(payLines) && <p className="muted small">A parte em "Fiado" fica anotada no nome do cliente (telefone obrigatório).</p>}
        </>}
        {payType === 'credit' && <p className="alert alert-info">O valor fica anotado no nome do cliente na aba <b>Fiados</b>. Na baixa, você escolhe as formas de pagamento.</p>}
        {payType === 'later' && <label className="field"><span>Como pretende pagar</span>
          <select value={laterMethod} onChange={(e) => setLaterMethod(e.target.value)}>{methods.map((m) => <option key={m} value={m}>{PAYMENT_METHODS[m]}</option>)}</select></label>}

        {formError && <p className="alert alert-error">{formError}</p>}
        <button type="button" className="btn btn-primary btn-block btn-lg" disabled={busy || !lines.length} onClick={submit}>{busy ? 'Registrando...' : `Concluir venda · ${money(totalCents / 100)}`}</button>
      </section>
    </div>

    {configuring && <ProductModal product={configuring} onClose={() => setConfiguring(null)} onAdd={(line) => { addLine(line); setConfiguring(null); }} />}
    {done && <Modal title="Venda registrada" onClose={() => setDone(null)} size="sm" footer={<>
      {mode === 'snack' && <button type="button" className="btn btn-outline" onClick={() => call(`/admin/orders/${done.id}`).then(printComanda).catch(() => {})}>
        <Printer size={16} /> Imprimir comanda</button>}
      <button type="button" className="btn btn-primary" onClick={() => setDone(null)}>Nova venda</button></>}>
      <div className="pos-done">
        <CheckCircle2 size={40} />
        <span>Senha</span><b>#{done.ticket}</b>
        <p>{done.orderNumber} · {money(done.total)}</p>
        {done.payType === 'pay' && done.change > 0 && <p className="change-big">Troco: <b>{money(done.change)}</b></p>}
        {done.payType === 'credit' && <p className="muted">Lançado no fiado.</p>}
        {done.payType === 'later' && <p className="muted">Pagamento pendente: receba depois em Pedidos ou Financeiro.</p>}
      </div>
    </Modal>}
  </div>;
}
