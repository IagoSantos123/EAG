// Comanda de cobrança pronta para divulgar: prévia das imagens, copiar/baixar cada parte e copiar o texto do WhatsApp.
import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Download, Image as ImageIcon } from 'lucide-react';
import { Modal, Spinner, useToast } from '../components/ui.jsx';
import { money } from '../lib/api.js';
import { useAdmin } from './context.js';
import { chargeImages, chargeText } from './cobranca.js';

const slug = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export default function ChargeSheet({ charges, title, onClose }) {
  const { call } = useAdmin();
  const toast = useToast();
  const [pix, setPix] = useState(null);
  const [blobs, setBlobs] = useState(null);
  const urls = useMemo(() => (blobs || []).map((blob) => URL.createObjectURL(blob)), [blobs]);
  useEffect(() => () => urls.forEach((url) => URL.revokeObjectURL(url)), [urls]);

  useEffect(() => { call('/payment-info').then(setPix).catch(() => setPix({})); }, [call]);
  useEffect(() => {
    if (!pix) return;
    let alive = true;
    chargeImages(charges, { title, pix }).then((result) => { if (alive) setBlobs(result); });
    return () => { alive = false; };
  }, [charges, title, pix]);

  const text = chargeText(charges, { title, pix: pix || {} });
  const total = charges.reduce((sum, c) => sum + c.balance, 0);
  const name = slug(title || charges[0]?.name || 'fiado');
  const parts = urls.length;
  const fileName = (index) => `fiado-${name}${parts > 1 ? `-parte-${index + 1}` : ''}.png`;

  const copyText = async () => {
    try { await navigator.clipboard.writeText(text); toast('Texto copiado. Cole no grupo do WhatsApp.'); }
    catch { toast('Não deu para copiar. Selecione o texto e copie.', 'error'); }
  };
  const copyImage = async (index) => {
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobs[index] })]); toast(`Imagem${parts > 1 ? ` (parte ${index + 1})` : ''} copiada. Cole no WhatsApp com Ctrl+V.`); }
    catch { toast('Este navegador não copia imagem. Use "Baixar".', 'error'); }
  };
  const download = (index) => {
    const link = document.createElement('a');
    link.href = urls[index]; link.download = fileName(index); link.click();
  };
  // Baixa uma parte de cada vez (alguns navegadores bloqueiam vários downloads disparados juntos).
  const downloadAll = async () => {
    for (const index of urls.keys()) { download(index); await new Promise((resolve) => setTimeout(resolve, 400)); }
  };

  return <Modal title={title || `Comanda de ${charges[0]?.name}`}
    subtitle={`${charges.length} ${charges.length === 1 ? 'pessoa' : 'pessoas'} · ${money(total)} em aberto${parts > 1 ? ` · ${parts} imagens` : ''}`}
    onClose={onClose} size="lg" className="charge-sheet"
    footer={<>
      <button type="button" className="btn btn-ghost" onClick={copyText}><Copy size={16} /> Copiar texto</button>
      <button type="button" className="btn btn-outline" disabled={!parts} onClick={downloadAll}><Download size={16} /> {parts > 1 ? `Baixar as ${parts} imagens` : 'Baixar imagem'}</button>
      {parts === 1 && <button type="button" className="btn btn-primary" onClick={() => copyImage(0)}><ImageIcon size={16} /> Copiar imagem</button>}
    </>}>
    <div className="charge-grid">
      <div className="charge-preview">{!parts ? <Spinner /> : urls.map((url, index) => <figure key={url}>
        <img src={url} alt={`Comanda de fiado${parts > 1 ? `, parte ${index + 1}` : ''}`} />
        {parts > 1 && <figcaption>
          <span>Parte {index + 1} de {parts}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => download(index)}><Download size={14} /> Baixar</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => copyImage(index)}><ImageIcon size={14} /> Copiar</button>
        </figcaption>}
      </figure>)}</div>
      <label className="field charge-text"><span>Texto para o WhatsApp</span><textarea readOnly value={text} onFocus={(e) => e.target.select()} /></label>
    </div>
  </Modal>;
}
