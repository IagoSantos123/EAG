import React, { useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Modal, useToast } from '../components/ui.jsx';
import { imageUrl, money } from '../lib/api.js';

function groupRule(group) {
  if (group.min === 0) return group.max === 1 ? 'Opcional · escolha 1' : `Opcional · até ${group.max}`;
  if (group.min === group.max) return `Obrigatório · escolha ${group.min}`;
  return `Obrigatório · de ${group.min} a ${group.max}`;
}

export default function ProductModal({ product, onClose, onAdd }) {
  const toast = useToast();
  const [choices, setChoices] = useState({});
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const [customText, setCustomText] = useState('');
  const [tried, setTried] = useState(false);

  const toggle = (group, option) => setChoices((current) => {
    const chosen = current[group.name] || [];
    if (chosen.includes(option.name)) return { ...current, [group.name]: chosen.filter((name) => name !== option.name) };
    if (group.max === 1) return { ...current, [group.name]: [option.name] };
    if (chosen.length >= group.max) return current;
    return { ...current, [group.name]: [...chosen, option.name] };
  });

  const invalidGroups = product.optionGroups.filter((group) => {
    const count = (choices[group.name] || []).length;
    return count < group.min || count > group.max;
  });
  const textMissing = product.customTextLabel && product.customTextRequired && !customText.trim();

  const unitPrice = useMemo(() => product.optionGroups.reduce((sum, group) => sum + (choices[group.name] || [])
    .reduce((acc, name) => acc + (group.options.find((o) => o.name === name)?.extra || 0), 0), product.price), [choices, product]);

  const submit = () => {
    setTried(true);
    if (invalidGroups.length || textMissing) return;
    // Mantém a ordem das opções igual à do cadastro para que linhas iguais se juntem na sacola.
    const selectedOptions = product.optionGroups.flatMap((group) => group.options
      .filter((option) => (choices[group.name] || []).includes(option.name)).map((option) => ({ group: group.name, option: option.name })));
    onAdd({
      productId: product.id, name: product.name, unitPrice, quantity, selectedOptions,
      optionLabels: selectedOptions.map((choice) => choice.option), note: product.allowNotes ? note.trim() : '',
      customText: product.customTextLabel ? customText.trim() : '', customTextLabel: product.customTextLabel || '',
      imageUrl: product.imageUrl, category: product.category
    });
    toast(`${quantity}× ${product.name} adicionado à sacola.`);
  };

  return <Modal onClose={onClose} size="md" className="product-modal"
    footer={<div className="product-modal-foot">
      <div className="qty" aria-label="Quantidade">
        <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label="Diminuir"><Minus size={16} /></button>
        <span>{quantity}</span>
        <button type="button" onClick={() => setQuantity((q) => Math.min(30, q + 1))} aria-label="Aumentar"><Plus size={16} /></button>
      </div>
      <button type="button" className="btn btn-primary btn-grow" onClick={submit}>Adicionar · {money(unitPrice * quantity)}</button>
    </div>}>
    {product.imageUrl && <img className="product-modal-photo" src={imageUrl(product.imageUrl)} alt="" />}
    <div className="product-modal-head">
      <h2>{product.name}</h2>
      {product.description && <p>{product.description}</p>}
      <b className="price">{money(product.price)}</b>
    </div>

    {product.optionGroups.map((group) => {
      const chosen = choices[group.name] || [];
      const invalid = tried && invalidGroups.includes(group);
      return <fieldset key={group.name} className={`option-group ${invalid ? 'invalid' : ''}`}>
        <legend><b>{group.name}</b><span>{groupRule(group)}{group.max > 1 ? ` · ${chosen.length}/${group.max}` : ''}</span></legend>
        {group.options.map((option) => {
          const checked = chosen.includes(option.name);
          const blocked = !checked && group.max > 1 && chosen.length >= group.max;
          return <label key={option.name} className={`option-row ${checked ? 'checked' : ''} ${blocked ? 'blocked' : ''}`}>
            <input type={group.max === 1 ? 'radio' : 'checkbox'} name={`g-${group.name}`} checked={checked} disabled={blocked} onChange={() => toggle(group, option)}
              onClick={() => { if (group.max === 1 && checked && group.min === 0) toggle(group, option); }} />
            <span>{option.name}</span>
            <small>{option.extra > 0 ? `+ ${money(option.extra)}` : 'grátis'}</small>
          </label>;
        })}
        {invalid && <small className="field-error">Escolha {group.min === group.max ? group.min : `de ${group.min} a ${group.max}`} {group.max === 1 ? 'opção' : 'opções'}.</small>}
      </fieldset>;
    })}

    {product.customTextLabel && <label className={`field ${tried && textMissing ? 'has-error' : ''}`}>
      <span>{product.customTextLabel}{product.customTextRequired ? ' *' : ' (opcional)'}</span>
      <input value={customText} maxLength={120} onChange={(e) => setCustomText(e.target.value)} />
      {tried && textMissing && <small className="field-error">Preencha este campo.</small>}
    </label>}

    {product.allowNotes && <label className="field">
      <span>Observações (opcional)</span>
      <textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: sem cebola, bem passado..." />
    </label>}
  </Modal>;
}
