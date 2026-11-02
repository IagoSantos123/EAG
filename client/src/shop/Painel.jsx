// Painel de senhas para a TV do salão: "Preparando" e "Pronto, pode retirar", com aviso sonoro.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { imageUrl, request, subscribe } from '../lib/api.js';
import { chime } from '../lib/beep.js';
import { readJson, writeJson } from '../lib/storage.js';
import '../styles/painel.css';

const HIGHLIGHT_MS = 12000;

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(timer); }, []);
  return now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export default function Painel() {
  const [data, setData] = useState(null);
  const [offline, setOffline] = useState(false);
  const [sound, setSound] = useState(() => readJson('eag-painel-sound', false));
  const [fresh, setFresh] = useState({});
  const [called, setCalled] = useState(null);
  const knownReady = useRef(null);
  const clock = useClock();

  const load = useCallback(async () => {
    try {
      const next = await request('/painel', { timeout: 8000 });
      const ready = next.orders.filter((order) => order.status === 'pronto').map((order) => order.ticket);
      // Na primeira carga só memoriza; depois, toda senha que entra em "pronto" é anunciada.
      if (knownReady.current) {
        const added = next.orders.filter((order) => order.status === 'pronto' && !knownReady.current.has(order.ticket));
        if (added.length) {
          const at = Date.now();
          setFresh((current) => ({ ...current, ...Object.fromEntries(added.map((order) => [order.ticket, at])) }));
          setCalled({ ...added[added.length - 1], at });
          if (readJson('eag-painel-sound', false)) chime();
        }
      }
      knownReady.current = new Set(ready);
      setData(next);
      setOffline(false);
    } catch { setOffline(true); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribe('/painel/events', { onChange: () => load() }), [load]);
  // Reserva: sem tempo real (ou se ele cair), atualiza a cada 10 s.
  useEffect(() => { const timer = setInterval(load, 10000); return () => clearInterval(timer); }, [load]);
  // Tira o destaque e o anúncio depois de alguns segundos.
  useEffect(() => {
    const timer = setInterval(() => {
      const limit = Date.now() - HIGHLIGHT_MS;
      setFresh((current) => Object.fromEntries(Object.entries(current).filter(([, at]) => at > limit)));
      setCalled((current) => (current && current.at > limit ? current : null));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const toggleSound = () => { const value = !sound; setSound(value); writeJson('eag-painel-sound', value); if (value) chime(); };
  const fullscreen = () => { document.documentElement.requestFullscreen?.().catch(() => {}); };

  const orders = data?.orders || [];
  const preparing = orders.filter((order) => order.status === 'preparo');
  const ready = orders.filter((order) => order.status === 'pronto');

  return <div className="painel" onDoubleClick={fullscreen}>
    <header className="painel-head">
      <div className="painel-brand">
        <img src="/brand/la-em-gracas-lanches.png" alt="" />
        <img src="/brand/eag-gracas.png" alt="" />
        <span>Acompanhe sua senha</span>
      </div>
      <div className="painel-tools">
        {offline && <span className="painel-offline">Sem conexão com o sistema</span>}
        <button type="button" className={`painel-sound ${sound ? 'on' : ''}`} onClick={toggleSound}>
          {sound ? <Volume2 size={20} /> : <VolumeX size={20} />} {sound ? 'Som ligado' : 'Ativar som'}
        </button>
        <time>{clock}</time>
      </div>
    </header>

    {called && <div className="painel-call" role="status">
      <span>Senha</span><b>{called.ticket}</b>{called.firstName && <em>{called.firstName}</em>}<strong>pode retirar!</strong>
    </div>}

    <main className="painel-cols">
      <section className="painel-col preparing">
        <h2>Preparando</h2>
        <ul>{preparing.map((order) => <li key={order.ticket}><b>{order.ticket}</b>{order.firstName && <span>{order.firstName}</span>}</li>)}</ul>
        {!preparing.length && <p className="painel-empty">Nenhum pedido em preparo</p>}
      </section>
      <section className="painel-col ready">
        <h2>Pronto, pode retirar</h2>
        <ul>{ready.map((order) => <li key={order.ticket} className={fresh[order.ticket] ? 'fresh' : ''}><b>{order.ticket}</b>{order.firstName && <span>{order.firstName}</span>}</li>)}</ul>
        {!ready.length && <p className="painel-empty">As senhas prontas aparecem aqui</p>}
      </section>
    </main>

    {data?.pixQr && <aside className="painel-pix">
      <img src={imageUrl(data.pixQr)} alt="QR Code do PIX" />
      <span>Pague com PIX<br />no balcão</span>
    </aside>}
    <p className="painel-hint">Dois cliques na tela: tela cheia</p>
  </div>;
}
