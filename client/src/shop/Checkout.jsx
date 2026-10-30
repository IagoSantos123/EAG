import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Banknote, BookUser, CreditCard, LockKeyhole, Minus, Plus, QrCode, ShoppingBag, Store, Trash2, Truck, UtensilsCrossed } from 'lucide-react';
import { EmptyState, Field, useToast } from '../components/ui.jsx';
import { money, parseMoney, request, uuid } from '../lib/api.js';
import { go, paths } from '../lib/router.js';
import { rememberOrder, readJson, writeJson } from '../lib/storage.js';
import { PAYMENT_METHODS, SERVICE_TYPES } from '../lib/labels.js';
import { ProductThumb } from './productUtils.jsx';

const SERVICE_ICONS = { dine_in: UtensilsCrossed, delivery: Truck, pickup: Store };
const METHOD_ICONS = { pix: QrCode, cash: Banknote, debit: CreditCard, credit: CreditCard, fiado: BookUser };
const METHOD_HINTS = {
  pix: 'Chave PIX exibida após confirmar o pedido.',
  cash: 'Pague no caixa ou na entrega.',
  debit: 'Pague no caixa ou na entrega.',
  credit: 'Pague no caixa ou na entrega.',
  fiado: 'Fica anotado no seu nome para pagar depois.'
};

export function CartPage({ mode, cart }) {
  const items = cart.carts[mode];
  const subtotal = cart.subtotal(mode);
  return <main className="page page-narrow">
    <a className="back-link" href={paths.catalog(mode)}><ArrowLeft size={16} /> Continuar escolhendo</a>
    <h1 className="page-title">Sua sacola</h1>
    {items.length === 0 ? <EmptyState icon={<ShoppingBag size={26} />} title="Sua sacola está vazia"
      action={<a className="btn btn-primary" href={paths.catalog(mode)}>Ver {mode === 'snack' ? 'cardápio' : 'artigos'}</a>}>Escolha alguns itens para começar.</EmptyState>
      : <div className="cart-layout">
        <ul className="cart-list">
          {items.map((item) => <li key={item.key} className="cart-line">
            <ProductThumb product={{ name: item.name, category: item.category || '', imageUrl: item.imageUrl }} />
            <div className="cart-line-info">
              <b>{item.name}</b>
              {item.optionLabels?.length > 0 && <small>{item.optionLabels.join(' · ')}</small>}
              {item.customText && <small>{item.customTextLabel}: {item.customText}</small>}
              {item.note && <small className="note">Obs.: {item.note}</small>}
              <span className="unit">{money(item.unitPrice)} cada</span>
            </div>
            <div className="qty qty-sm">
              <button type="button" onClick={() => cart.setQuantity(mode, item.key, item.quantity - 1)} aria-label="Diminuir" disabled={item.quantity <= 1}><Minus size={14} /></button>
              <span>{item.quantity}</span>
              <button type="button" onClick={() => cart.setQuantity(mode, item.key, item.quantity + 1)} aria-label="Aumentar"><Plus size={14} /></button>
            </div>
            <strong>{money(item.unitPrice * item.quantity)}</strong>
            <button type="button" className="icon-btn danger" onClick={() => cart.remove(mode, item.key)} aria-label={`Remover ${item.name}`}><Trash2 size={16} /></button>
          </li>)}
        </ul>
        <aside className="summary-card">
          <h3>Resumo</h3>
          <div className="summary-row"><span>Subtotal</span><b>{money(subtotal)}</b></div>
          <p className="muted small">Taxa de entrega e forma de pagamento são escolhidas na próxima etapa.</p>
          <a className="btn btn-primary btn-block" href={paths.checkout(mode)}>Continuar <ArrowRight size={17} /></a>
        </aside>
      </div>}
  </main>;
}

function formatPhone(value) {
  const d = value.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

const BUYER_KEY = 'eag-buyer';

export function CheckoutPage({ mode, cart, config }) {
  const toast = useToast();
  const items = cart.carts[mode];
  const [teams, setTeams] = useState([]);
  const saved = readJson(BUYER_KEY, {});
  const services = (config?.serviceTypes || []).filter((type) => !(mode === 'religious' && type === 'dine_in'));
  const baseMethods = config?.paymentMethods || [];
  const [form, setForm] = useState({
    buyerName: saved.buyerName || '', buyerPhone: saved.buyerPhone || '', teamId: saved.teamId || '',
    serviceType: services.length === 1 ? services[0] : '', paymentMethod: baseMethods.length === 1 ? baseMethods[0] : '',
    tableNumber: '', deliveryAddress: saved.deliveryAddress || '', deliveryReference: saved.deliveryReference || '', deliveryNote: '', cashChangeFor: ''
  });
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(uuid());

  useEffect(() => {
    request('/teams').then((list) => {
      setTeams(list);
      // Equipe salva em outro pedido pode ter sido desativada.
      setForm((current) => (current.teamId && !list.some((team) => String(team.id) === String(current.teamId)) ? { ...current, teamId: '' } : current));
    }).catch(() => setTeams([]));
  }, []);
  // Fiado no autoatendimento só existe para consumo no salão (quando liberado pela administração).
  const methods = config?.selfCredit && form.serviceType === 'dine_in' ? [...baseMethods, 'fiado'] : baseMethods;
  useEffect(() => { if (form.paymentMethod === 'fiado' && form.serviceType !== 'dine_in') setForm((current) => ({ ...current, paymentMethod: '' })); }, [form.serviceType, form.paymentMethod]);
  const set = (key, value) => { setForm((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [key]: undefined })); };

  const subtotal = cart.subtotal(mode);
  const deliveryFee = form.serviceType === 'delivery' ? Number(config?.deliveryFee || 0) : 0;
  const total = Math.round((subtotal + deliveryFee) * 100) / 100;

  if (!items.length) return <main className="page page-narrow"><EmptyState icon={<ShoppingBag size={26} />} title="Sua sacola está vazia"
    action={<a className="btn btn-primary" href={paths.catalog(mode)}>Voltar ao catálogo</a>} /></main>;

  const validate = () => {
    const next = {};
    if (form.buyerName.trim().length < 3) next.buyerName = 'Informe seu nome completo.';
    const digits = form.buyerPhone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) next.buyerPhone = 'Informe um telefone com DDD.';
    if (!form.serviceType) next.serviceType = 'Escolha como quer receber o pedido.';
    if (form.serviceType === 'delivery' && form.deliveryAddress.trim().length < 5) next.deliveryAddress = 'Informe o endereço de entrega.';
    if (form.serviceType === 'dine_in' && config?.tablesEnabled) {
      const table = Number(form.tableNumber);
      if (!form.tableNumber) next.tableNumber = 'Informe o número da mesa.';
      else if (config.tableCount > 0 && (!Number.isInteger(table) || table < 1 || table > config.tableCount)) next.tableNumber = `Mesa de 1 a ${config.tableCount}.`;
    }
    if (!form.paymentMethod) next.paymentMethod = 'Escolha a forma de pagamento.';
    if (form.paymentMethod === 'cash' && form.cashChangeFor) {
      const change = parseMoney(form.cashChangeFor);
      if (Number.isNaN(change) || change < total) next.cashChangeFor = `Informe um valor igual ou maior que ${money(total)}, ou deixe em branco.`;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (event) => {
    event.preventDefault();
    setSubmitError('');
    if (!validate()) { toast('Confira os campos destacados.', 'error'); return; }
    setBusy(true);
    try {
      const body = {
        clientRequestId: requestId.current, mode, buyerName: form.buyerName.trim(), buyerPhone: form.buyerPhone.trim(), teamId: form.teamId ? Number(form.teamId) : null,
        serviceType: form.serviceType, paymentMethod: form.paymentMethod, tableNumber: form.serviceType === 'dine_in' ? String(form.tableNumber).trim() : '',
        deliveryAddress: form.serviceType === 'delivery' ? form.deliveryAddress.trim() : '', deliveryReference: form.serviceType === 'delivery' ? form.deliveryReference.trim() : '',
        deliveryNote: form.serviceType === 'delivery' ? form.deliveryNote.trim() : '',
        cashChangeFor: form.paymentMethod === 'cash' && form.cashChangeFor ? parseMoney(form.cashChangeFor) : null,
        items: items.map((item) => ({ productId: Number(item.productId), quantity: item.quantity, selectedOptions: item.selectedOptions, note: item.note || '', customText: item.customText || '' }))
      };
      const order = await request('/orders', { method: 'POST', body });
      writeJson(BUYER_KEY, { buyerName: body.buyerName, buyerPhone: body.buyerPhone, teamId: form.teamId, deliveryAddress: form.deliveryAddress, deliveryReference: form.deliveryReference });
      rememberOrder({ token: order.token, orderNumber: order.orderNumber, ticket: order.ticket, mode, total: order.total });
      cart.clear(mode);
      requestId.current = uuid();
      go(paths.tracking(order.token));
    } catch (error) {
      setSubmitError(error.code === 'NETWORK'
        ? 'A conexão falhou. Toque em "Confirmar pedido" novamente: se o pedido já tiver sido registrado, ele não será duplicado.'
        : error.message);
    } finally { setBusy(false); }
  };

  return <main className="page page-narrow">
    <a className="back-link" href={paths.cart(mode)}><ArrowLeft size={16} /> Voltar à sacola</a>
    <h1 className="page-title">Finalizar pedido</h1>
    <form className="checkout-layout" onSubmit={submit} noValidate>
      <div className="checkout-steps">
        <section className="form-card">
          <h2><span className="step-n">1</span> Seus dados</h2>
          <Field label="Nome completo" error={errors.buyerName}>
            <input value={form.buyerName} onChange={(e) => set('buyerName', e.target.value)} autoComplete="name" maxLength={120} placeholder="Ex.: Maria da Silva" />
          </Field>
          <div className="grid-2">
            <Field label="Telefone (WhatsApp)" error={errors.buyerPhone}>
              <input value={form.buyerPhone} onChange={(e) => set('buyerPhone', formatPhone(e.target.value))} inputMode="tel" autoComplete="tel" placeholder="(83) 99999-0000" />
            </Field>
            <Field label="Equipe">
              <select value={form.teamId} onChange={(e) => set('teamId', e.target.value)}>
                <option value="">Sem equipe / visitante</option>
                {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
              </select>
            </Field>
          </div>
        </section>

        <section className="form-card">
          <h2><span className="step-n">2</span> Como você quer receber?</h2>
          {services.length === 0 ? <p className="alert alert-warning">Nenhuma modalidade de atendimento disponível no momento. Procure a equipe.</p>
            : <div className={`choice-grid ${errors.serviceType ? 'invalid' : ''}`} role="radiogroup">
              {services.map((type) => {
                const Icon = SERVICE_ICONS[type];
                return <label key={type} className={`choice-card ${form.serviceType === type ? 'selected' : ''}`}>
                  <input type="radio" name="serviceType" checked={form.serviceType === type} onChange={() => set('serviceType', type)} />
                  <Icon size={22} /><b>{SERVICE_TYPES[type]}</b>
                  <small>{type === 'delivery' ? (config.deliveryFee > 0 ? `Taxa de entrega ${money(config.deliveryFee)}` : 'Sem taxa de entrega') : type === 'dine_in' ? 'Para consumir aqui' : 'Retire no balcão'}</small>
                </label>;
              })}
            </div>}
          {errors.serviceType && <small className="field-error">{errors.serviceType}</small>}

          {form.serviceType === 'delivery' && <div className="sub-fields">
            <Field label="Endereço de entrega" error={errors.deliveryAddress}>
              <input value={form.deliveryAddress} onChange={(e) => set('deliveryAddress', e.target.value)} maxLength={300} autoComplete="street-address" placeholder="Rua, número, bairro" />
            </Field>
            <Field label="Complemento ou ponto de referência (opcional)">
              <input value={form.deliveryReference} onChange={(e) => set('deliveryReference', e.target.value)} maxLength={200} />
            </Field>
            <Field label="Observações para a entrega (opcional)">
              <input value={form.deliveryNote} onChange={(e) => set('deliveryNote', e.target.value)} maxLength={300} placeholder="Ex.: chamar no portão" />
            </Field>
          </div>}
          {form.serviceType === 'dine_in' && config?.tablesEnabled && <div className="sub-fields">
            <Field label="Número da mesa" error={errors.tableNumber} hint={config.tableCount > 0 ? `Mesas de 1 a ${config.tableCount}` : undefined}>
              <input value={form.tableNumber} onChange={(e) => set('tableNumber', e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" />
            </Field>
          </div>}
        </section>

        <section className="form-card">
          <h2><span className="step-n">3</span> Forma de pagamento</h2>
          {methods.length === 0 ? <p className="alert alert-warning">Nenhuma forma de pagamento disponível no momento. Procure a equipe.</p>
            : <div className={`choice-grid ${errors.paymentMethod ? 'invalid' : ''}`} role="radiogroup">
              {methods.map((method) => {
                const Icon = METHOD_ICONS[method];
                return <label key={method} className={`choice-card ${form.paymentMethod === method ? 'selected' : ''}`}>
                  <input type="radio" name="paymentMethod" checked={form.paymentMethod === method} onChange={() => set('paymentMethod', method)} />
                  <Icon size={22} /><b>{PAYMENT_METHODS[method]}</b><small>{method === 'pix' && config?.pixAutomatic ? 'QR Code na próxima tela, confirmação automática.' : METHOD_HINTS[method]}</small>
                </label>;
              })}
            </div>}
          {errors.paymentMethod && <small className="field-error">{errors.paymentMethod}</small>}
          {form.paymentMethod === 'cash' && <div className="sub-fields">
            <Field label="Precisa de troco para quanto? (opcional)" error={errors.cashChangeFor}>
              <input value={form.cashChangeFor} onChange={(e) => set('cashChangeFor', e.target.value.replace(/[^\d,.]/g, ''))} inputMode="decimal" placeholder="Ex.: 50,00" />
            </Field>
          </div>}
        </section>
      </div>

      <aside className="summary-card sticky">
        <h3>Resumo do pedido</h3>
        <ul className="summary-items">
          {items.map((item) => <li key={item.key}><span>{item.quantity}× {item.name}{item.optionLabels?.length ? <small>{item.optionLabels.join(' · ')}</small> : null}</span><b>{money(item.unitPrice * item.quantity)}</b></li>)}
        </ul>
        <div className="summary-row"><span>Subtotal</span><b>{money(subtotal)}</b></div>
        {form.serviceType === 'delivery' && <div className="summary-row"><span>Taxa de entrega</span><b>{money(deliveryFee)}</b></div>}
        <div className="summary-row total"><span>Total</span><b>{money(total)}</b></div>
        {submitError && <p className="alert alert-error">{submitError}</p>}
        <button className="btn btn-primary btn-block btn-lg" disabled={busy || !services.length || !methods.length}>{busy ? 'Enviando...' : 'Confirmar pedido'} {!busy && <ArrowRight size={17} />}</button>
        <p className="secure-note"><LockKeyhole size={13} /> Seus dados são usados apenas para identificar e entregar este pedido. Os valores são conferidos pelo sistema.</p>
      </aside>
    </form>
  </main>;
}
