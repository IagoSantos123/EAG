import React, { useCallback, useEffect, useState } from 'react';
import { ConfirmProvider, ToastProvider } from './components/ui.jsx';
import { request } from './lib/api.js';
import { useRoute } from './lib/router.js';
import { useCarts } from './shop/cart.js';
import { ShopFooter, ShopHeader } from './shop/Layout.jsx';
import Catalog from './shop/Catalog.jsx';
import { CartPage, CheckoutPage } from './shop/Checkout.jsx';
import Tracking, { LookupPage, MyOrders } from './shop/Tracking.jsx';
import AdminApp from './admin/AdminApp.jsx';

function Shop({ route }) {
  const cart = useCarts();
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(false);
  const loadConfig = useCallback(() => {
    request('/public-config').then((data) => { setConfig(data); setConfigError(false); }).catch(() => setConfigError(true));
  }, []);
  useEffect(() => { loadConfig(); }, [loadConfig]);
  // Sem conexão na primeira carga: tenta de novo a cada 10 s.
  useEffect(() => {
    if (!configError) return undefined;
    const timer = setTimeout(loadConfig, 10000);
    return () => clearTimeout(timer);
  }, [configError, loadConfig]);

  const mode = route.params.mode;
  let page;
  switch (route.name) {
    case 'catalog': page = <Catalog key={mode} mode={mode} cart={cart} config={config} />; break;
    case 'cart': page = <CartPage mode={mode} cart={cart} />; break;
    case 'checkout': page = config ? <CheckoutPage mode={mode} cart={cart} config={config} />
      : <main className="page page-narrow"><p className="alert alert-warning">{configError ? 'Sem conexão com o servidor. Tentando novamente...' : 'Carregando...'}</p></main>; break;
    case 'tracking': page = <Tracking token={route.params.token} />; break;
    case 'myOrders': page = <MyOrders />; break;
    case 'lookup': page = <LookupPage />; break;
    default: page = <Catalog key="home" mode="snack" cart={cart} config={config} />;
  }
  return <div className="shop">
    <ShopHeader route={route} mode={mode || 'snack'} count={cart.count(mode || 'snack')} />
    {configError && route.name === 'home' && <p className="alert alert-warning page-alert">Não foi possível conectar ao servidor. Verifique a internet; tentaremos novamente.</p>}
    {page}
    <ShopFooter contactPhone={config?.contactPhone} />
  </div>;
}

export default function App() {
  const route = useRoute();
  return <ToastProvider>
    <ConfirmProvider>
      {route.name === 'admin' ? <AdminApp tab={route.params.tab} /> : <Shop route={route} />}
    </ConfirmProvider>
  </ToastProvider>;
}
