// Comanda para impressora térmica de 80 mm: senha grande, cliente, atendimento e itens.
// Imprime por um iframe oculto, sem mexer na página. No Chrome aberto com --kiosk-printing,
// sai direto na impressora padrão, sem a janela de impressão.
import { SERVICE_TYPES, PAYMENT_STATUS } from '../lib/labels.js';

const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (value) => (value ? new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '');

function comandaHtml(order) {
  const items = (order.items || []).map((item) => `
    <li><b>${item.quantity}× ${escape(item.name)}</b>
      ${(item.options || []).map((o) => `<div class="opt">• ${escape(o.option)}</div>`).join('')}
      ${item.customText ? `<div class="opt">${escape(item.customTextLabel || 'Personalização')}: ${escape(item.customText)}</div>` : ''}
      ${item.note ? `<div class="note">OBS: ${escape(item.note)}</div>` : ''}
    </li>`).join('');
  const service = SERVICE_TYPES[order.serviceType] || '';
  const table = order.tableNumber ? ` · Mesa ${escape(order.tableNumber)}` : '';
  const payment = order.onCredit ? 'Fiado' : (PAYMENT_STATUS[order.paymentStatus]?.label || '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Comanda #${escape(order.ticket)}</title><style>
    @page { size: 80mm auto; margin: 0; }
    * { box-sizing: border-box; }
    body { width: 72mm; margin: 0 auto; padding: 3mm 0 6mm; font: 13px/1.35 Arial, Helvetica, sans-serif; color: #000; }
    .ticket { text-align: center; border-bottom: 2px dashed #000; padding-bottom: 2mm; margin-bottom: 2mm; }
    .ticket small { display: block; font-size: 12px; letter-spacing: .1em; }
    .ticket b { display: block; font-size: 44px; line-height: 1.05; }
    .who { font-size: 15px; font-weight: 700; }
    .meta { font-size: 12px; margin: 1mm 0 2mm; }
    ul { list-style: none; margin: 0; padding: 2mm 0; border-top: 1px solid #000; border-bottom: 1px solid #000; }
    li { margin: 0 0 2mm; font-size: 15px; }
    li:last-child { margin-bottom: 0; }
    .opt { font-size: 13px; padding-left: 3mm; }
    .note { font-size: 13px; font-weight: 700; padding-left: 3mm; }
    .note.order { padding: 0 0 2mm; }
    .foot { font-size: 11px; margin-top: 2mm; display: flex; justify-content: space-between; }
  </style></head><body>
    <div class="ticket"><small>SENHA</small><b>#${escape(order.ticket)}</b></div>
    <div class="who">${escape(order.buyerName)}</div>
    <div class="meta">${escape(order.teamName)} · ${escape(service)}${table}</div>
    ${order.orderNote ? `<div class="note order">OBS DA COMANDA: ${escape(order.orderNote)}</div>` : ''}
    <ul>${items}</ul>
    <div class="foot"><span>${escape(order.orderNumber)}</span><span>${escape(payment)} · ${clock(order.createdAt)}</span></div>
  </body></html>`;
}

export function printComanda(order) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open(); doc.write(comandaHtml(order)); doc.close();
  // Remove o iframe depois da impressão (ou cancelamento) para não acumular na página.
  frame.contentWindow.onafterprint = () => setTimeout(() => frame.remove(), 500);
  setTimeout(() => { frame.contentWindow.focus(); frame.contentWindow.print(); setTimeout(() => frame.isConnected && frame.remove(), 60000); }, 50);
}
