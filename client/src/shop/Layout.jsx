import React from 'react';
import { Phone, Search, ShoppingBag } from 'lucide-react';
import { paths } from '../lib/router.js';

export function ShopHeader({ route, count = 0, mode }) {
  const active = (name, value) => (route.name === name && (!value || route.params.mode === value) ? 'active' : '');
  return <header className="site-header">
    <div className="site-header-inner">
      <a href={paths.home} className="site-brand" aria-label="Lá em Graças Lanches — início">
        <img src="/brand/la-em-gracas-lanches.png" alt="" />
        <span><b>Lá em Graças</b><small>Lanches · EAG Graças</small></span>
      </a>
      <nav className="site-nav" aria-label="Principal">
        <a href={paths.catalog('snack')} className={route.name === 'home' || active('catalog', 'snack') ? 'active' : ''}>Cardápio</a>
        <a href={paths.catalog('religious')} className={active('catalog', 'religious')}><em className="full-label">Artigos religiosos</em><em className="short-label">Artigos</em></a>
        <a href={paths.lookup} className={active('lookup') || active('tracking') || active('myOrders')}><Search size={16} /><span>Consultar pedido</span></a>
      </nav>
      <a href={paths.cart(mode || 'snack')} className="header-bag" aria-label={`Sacola: ${count} itens`}>
        <ShoppingBag size={18} /><span>Sacola</span>{count > 0 && <b>{count}</b>}
      </a>
    </div>
  </header>;
}

export function ShopFooter({ contactPhone }) {
  return <footer className="site-footer">
    <div className="site-footer-inner">
      <div className="footer-brand">
        <img src="/brand/la-em-gracas-lanches.png" alt="Lá em Graças Lanches" />
        <img src="/brand/eag-gracas.png" alt="EAG — Encontro de Adolescentes Graças" />
        <p>Lanchonete do EAG — Encontro de Adolescentes Graças.<br />Volte sempre e traga mais um com você!</p>
      </div>
      <div className="footer-col">
        <h4>Delivery GRASFOOD</h4>
        {contactPhone ? <a href={`tel:${contactPhone.replace(/[^\d+]/g, '')}`}><Phone size={14} /> {contactPhone}</a> : <span>Peça pelo site e acompanhe a entrega.</span>}
      </div>
      <div className="footer-col">
        <h4>Pedidos</h4>
        <a href={paths.catalog('snack')}>Cardápio</a>
        <a href={paths.lookup}>Consultar pedido</a>
        <a href={paths.myOrders}>Pedidos deste aparelho</a>
      </div>
      <div className="footer-col">
        <h4>Equipe</h4>
        <a href={paths.admin()}>Acesso da equipe</a>
      </div>
    </div>
    <div className="site-footer-bottom">© {new Date().getFullYear()} EAG Graças</div>
  </footer>;
}
