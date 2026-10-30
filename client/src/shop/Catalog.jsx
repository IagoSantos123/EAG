import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bike, Clock3, Minus, Plus, Search, ShoppingBag, Store, UtensilsCrossed } from 'lucide-react';
import { request, money } from '../lib/api.js';
import { paths } from '../lib/router.js';
import { EmptyState, ErrorState, Spinner } from '../components/ui.jsx';
import ProductModal from './ProductModal.jsx';
import { ProductThumb, startingPrice } from './productUtils.jsx';

function ReligiousEmpty() {
  return <section className="no-stock">
    <img src="/brand/eag-gracas.png" alt="EAG — Encontro de Adolescentes Graças" />
    <h2>Ainda não temos estoque</h2>
    <p>Aguarde novidades! Em breve, disponibilizaremos nossos artigos religiosos.</p>
    <div className="no-stock-actions">
      <a className="btn btn-primary" href={paths.home}><ArrowLeft size={17} /> Voltar à página inicial</a>
    </div>
  </section>;
}

function StoreHeader({ mode, config }) {
  const snack = mode === 'snack';
  const services = (snack ? config?.serviceTypes : config?.religiousServiceTypes) || [];
  return <section className={`store-head ${snack ? '' : 'store-head-religious'}`}>
    <div className="store-cover">{snack && <img src="/products/capa.jpg" alt="" />}</div>
    <div className="store-card">
      <img className="store-logo" src={snack ? '/brand/la-em-gracas-lanches.png' : '/brand/eag-gracas.png'} alt="" />
      <div className="store-info">
        <h1>{snack ? 'Lá em Graças Lanches' : 'Artigos religiosos EAG'}</h1>
        <p>{snack ? 'Lanchonete do EAG Graças · Lanches, tapiocas, cuscuz e bebidas' : 'Loja do Encontro de Adolescentes Graças'}</p>
        {services.length > 0 && <ul className="store-facts">
          {services.includes('delivery') && <li><Bike size={15} /> Delivery {config.deliveryFee > 0 ? `· taxa ${money(config.deliveryFee)}` : 'grátis'}</li>}
          {services.includes('dine_in') && <li><UtensilsCrossed size={15} /> Consumo no salão</li>}
          {services.includes('pickup') && <li><Store size={15} /> Retirada no balcão</li>}
        </ul>}
      </div>
    </div>
  </section>;
}

function BagAside({ mode, cart }) {
  const items = cart.carts[mode];
  return <aside className="bag-aside">
    <h3>Sua sacola</h3>
    {items.length === 0 ? <div className="bag-empty"><ShoppingBag size={28} /><p>Sua sacola está vazia</p><small>Adicione itens do cardápio.</small></div> : <>
      <ul>{items.map((item) => <li key={item.key}>
        <div><b>{item.name}</b>{item.optionLabels?.length > 0 && <small>{item.optionLabels.join(', ')}</small>}<span>{money(item.unitPrice * item.quantity)}</span></div>
        <div className="qty qty-sm">
          <button type="button" aria-label="Diminuir" onClick={() => (item.quantity <= 1 ? cart.remove(mode, item.key) : cart.setQuantity(mode, item.key, item.quantity - 1))}><Minus size={14} /></button>
          <span>{item.quantity}</span>
          <button type="button" aria-label="Aumentar" onClick={() => cart.setQuantity(mode, item.key, item.quantity + 1)}><Plus size={14} /></button>
        </div>
      </li>)}</ul>
      <div className="summary-row total"><span>Subtotal</span><b>{money(cart.subtotal(mode))}</b></div>
      <a className="btn btn-primary btn-block" href={paths.checkout(mode)}>Finalizar pedido</a>
    </>}
  </aside>;
}

export default function Catalog({ mode, cart, config }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [activeCat, setActiveCat] = useState(null);
  const [selected, setSelected] = useState(null);
  const sectionsRef = useRef(null);
  const { sync } = cart;

  const load = useCallback(async () => {
    setError(''); setData(null);
    try {
      const result = await request(`/catalog?mode=${mode}`);
      setData(result);
      sync(mode, result.products);
    } catch (err) { setError(err.message); }
  }, [mode, sync]);
  useEffect(() => { setSearch(''); load(); }, [load]);

  const sections = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    const list = data.products.filter((product) => !term || `${product.name} ${product.description}`.toLowerCase().includes(term));
    const groups = data.categories.map((c) => ({ id: c.id, name: c.name, products: list.filter((p) => p.categoryId === c.id) }));
    const others = list.filter((p) => !data.categories.some((c) => c.id === p.categoryId));
    if (others.length) groups.push({ id: 'outros', name: 'Outros', products: others });
    return groups.filter((group) => group.products.length);
  }, [data, search]);

  // Marca a categoria visível na barra (como nos apps de delivery).
  useEffect(() => {
    const root = sectionsRef.current;
    if (!root || !('IntersectionObserver' in window)) return undefined;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActiveCat(visible.target.dataset.cat);
    }, { rootMargin: '-140px 0px -60% 0px' });
    root.querySelectorAll('[data-cat]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [sections]);

  const jump = (id) => {
    const el = document.getElementById(`cat-${id}`);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 128, behavior: 'smooth' });
  };

  const count = cart.count(mode);
  if (error) return <main className="page"><ErrorState message={error} onRetry={load} /></main>;
  if (!data) return <main className="page"><Spinner label="Carregando o cardápio..." /></main>;
  const empty = data.products.length === 0;

  return <main className="store-page">
    <StoreHeader mode={mode} config={config} />
    {empty ? (mode === 'religious' ? <ReligiousEmpty /> : <EmptyState title="Cardápio em preparação">Nenhum item disponível agora. Volte em instantes.</EmptyState>) : <>
      <div className="cat-bar">
        <div className="cat-bar-inner">
          <label className="search-field"><Search size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar no cardápio" aria-label="Buscar no cardápio" /></label>
          <nav className="cat-tabs" aria-label="Categorias">
            {sections.map((s) => <button type="button" key={s.id} className={String(activeCat) === String(s.id) ? 'active' : ''} onClick={() => jump(s.id)}>{s.name}</button>)}
          </nav>
        </div>
      </div>
      <div className="store-body">
        <div className="menu" ref={sectionsRef}>
          {sections.length === 0 && <EmptyState icon={<Search size={22} />} title="Nada encontrado">Tente buscar por outro nome.</EmptyState>}
          {sections.map((section) => <section key={section.id} id={`cat-${section.id}`} data-cat={section.id} className="menu-section">
            <h2>{section.name}</h2>
            <div className="menu-grid">
              {section.products.map((product) => {
                const start = startingPrice(product);
                return <button type="button" key={product.id} className="product-card" onClick={() => setSelected(product)}>
                  <span className="product-card-text">
                    <b>{product.name}</b>
                    {product.description && <small className="desc">{product.description}</small>}
                    <span className="price-line">{start.varies && <small>a partir de </small>}<strong>{money(start.price)}</strong>
                      {product.prepMinutes ? <small className="prep"><Clock3 size={12} /> {product.prepMinutes} min</small> : null}</span>
                  </span>
                  <ProductThumb product={product} size="lg" />
                </button>;
              })}
            </div>
          </section>)}
        </div>
        <BagAside mode={mode} cart={cart} />
      </div>
    </>}

    {count > 0 && <a className="mobile-bag" href={paths.cart(mode)}>
      <span className="mobile-bag-count">{count}</span><span>Ver sacola</span><b>{money(cart.subtotal(mode))}</b>
    </a>}
    {selected && <ProductModal product={selected} onClose={() => setSelected(null)} onAdd={(line) => { cart.add(mode, line); setSelected(null); }} />}
  </main>;
}
