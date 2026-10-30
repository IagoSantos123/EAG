// Barramento de eventos em memória para atualização em tempo real via Server-Sent Events.
// Os eventos só avisam "algo mudou"; os clientes recarregam os dados pela API,
// que continua sendo a única fonte de verdade (banco de dados).
import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(0);

// type: 'order' | 'payment' | 'cash'; orderId opcional.
export function publish(type, payload = {}) {
  bus.emit('event', { type, ...payload, at: new Date().toISOString() });
}

// Abre um fluxo SSE. `filter` decide quais eventos este cliente recebe.
export function openStream(req, res, filter = () => true) {
  // Em ambiente serverless (Vercel) não há conexão persistente: o navegador usa atualização periódica.
  if (process.env.VERCEL) {
    res.setHeader('X-Realtime', 'off');
    return res.status(204).end();
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 5000\n\n');
  res.write(`event: ready\ndata: {}\n\n`);

  const send = (event) => {
    if (!filter(event)) return;
    res.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
  };
  bus.on('event', send);
  // Comentário periódico evita que proxies encerrem a conexão ociosa.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('event', send);
  });
}
