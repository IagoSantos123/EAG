// Comparação de nomes de clientes: grafias diferentes da mesma pessoa ("Julio", "Júlio César", "Julio Cezar").

// Palavras sem acento, minúsculas e sem conectivos curtos ("e", "da").
export const words = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  .split(' ').filter((word) => word.length > 2);

// Mesma pessoa mesmo com acento, maiúsculas ou espaços diferentes ("amanda" e "Amanda ").
export const personKey = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Mesma palavra tolerando abreviação ("Rodol" x "Rodolpho") e uma letra trocada ("Kamila" x "Camila").
export function similar(a, b) {
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length] <= 1;
}

// Um nome "cabe" no outro quando todas as palavras do mais curto aparecem (parecidas) no mais longo:
// "Julio" cabe em "Julio Cesar"; "Julio Cesar" e "Julio Cezar" cabem um no outro.
export function sameName(a, b) {
  const [short, long] = [words(a), words(b)].sort((x, y) => x.length - y.length);
  return short.length > 0 && short.every((word) => long.some((other) => similar(word, other)));
}
