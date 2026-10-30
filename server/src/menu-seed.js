// Cardápio inicial da lanchonete "Lá em Graças Lanches", transcrito do cardápio oficial
// (imagem fornecida pela equipe, salva em docs/referencias/cardapio-la-em-gracas.png).
// Somente informações visíveis no cardápio foram cadastradas. Itens com dados
// ausentes estão marcados com `review` para conferência administrativa.
// Valores em centavos. `key` é o identificador estável que evita duplicações.

export const MENU_CATEGORIES = [
  { name: 'Cuscuz', sort: 1 },
  { name: 'Tapioca', sort: 2 },
  { name: 'Diversos', sort: 3 },
  { name: 'Sobremesas', sort: 4 },
  { name: 'Bebidas', sort: 5 }
];

const TAPIOCA_FLAVORS = ['Manteiga', 'Coco', 'Queijo', 'Coco + leite condensado', 'Frango', 'Carne de sol', 'Misto (queijo + presunto)'];

export const MENU_PRODUCTS = [
  { key: 'menu:cuscuz-ovo', category: 'Cuscuz', name: 'Cuscuz com ovo', price: 600 },
  { key: 'menu:cuscuz-frango', category: 'Cuscuz', name: 'Cuscuz com frango', price: 700 },
  { key: 'menu:cuscuz-carne-de-sol', category: 'Cuscuz', name: 'Cuscuz com carne de sol', price: 800 },

  { key: 'menu:tapioca-manteiga', category: 'Tapioca', name: 'Tapioca de manteiga', price: 300 },
  { key: 'menu:tapioca-coco', category: 'Tapioca', name: 'Tapioca de coco', price: 500 },
  { key: 'menu:tapioca-queijo', category: 'Tapioca', name: 'Tapioca de queijo', price: 500 },
  { key: 'menu:tapioca-coco-leite-condensado', category: 'Tapioca', name: 'Tapioca de coco + leite condensado', price: 500 },
  { key: 'menu:tapioca-frango', category: 'Tapioca', name: 'Tapioca de frango', price: 700 },
  { key: 'menu:tapioca-carne-de-sol', category: 'Tapioca', name: 'Tapioca de carne de sol', price: 800 },
  { key: 'menu:tapioca-misto', category: 'Tapioca', name: 'Tapioca mista', description: 'Queijo + presunto.', price: 600 },
  {
    key: 'menu:tapioca-do-meu-jeito', category: 'Tapioca', name: 'Tapioca do meu jeito', description: 'Escolha até 2 sabores.', price: 1000,
    optionGroups: [{ name: 'Sabores', min: 1, max: 2, options: TAPIOCA_FLAVORS.map((name) => ({ name, extraCents: 0, available: true })) }],
    review: 'O cardápio diz "escolha até 2 sabores" sem listar quais. Foram usados os sabores de tapioca do próprio cardápio; confirme a lista.'
  },

  { key: 'menu:pao-com-ovo', category: 'Diversos', name: 'Pão com ovo', price: 500 },
  { key: 'menu:misto-quente', category: 'Diversos', name: 'Misto quente', price: 500 },
  { key: 'menu:crepe', category: 'Diversos', name: 'Crepe', price: 600, review: 'Sabores/recheios do crepe não aparecem no cardápio.' },
  { key: 'menu:salgado', category: 'Diversos', name: 'Salgado', price: 600, review: 'Tipos de salgado disponíveis não aparecem no cardápio.' },
  { key: 'menu:batata-frita', category: 'Diversos', name: 'Batata frita', price: 700 },
  { key: 'menu:mini-pizza', category: 'Diversos', name: 'Mini pizza', price: 800, review: 'Sabores da mini pizza não aparecem no cardápio.' },

  { key: 'menu:torta', category: 'Sobremesas', name: 'Torta', price: 1200, review: 'Sabor e tamanho (fatia ou inteira) não aparecem no cardápio.' },
  { key: 'menu:dindim-gourmet', category: 'Sobremesas', name: 'Dindim gourmet', price: 400, review: 'Sabores do dindim não aparecem no cardápio.' },
  { key: 'menu:acai', category: 'Sobremesas', name: 'Açaí', description: 'Com banana, granola, leite em pó e leite condensado.', price: 1000, review: 'Tamanho do copo não aparece no cardápio.' },

  { key: 'menu:agua-500', category: 'Bebidas', name: 'Água 500 ml', price: 200 },
  { key: 'menu:agua-com-gas', category: 'Bebidas', name: 'Água com gás', price: 300, review: 'Volume da garrafa não aparece no cardápio.' },
  { key: 'menu:refrigerante-250', category: 'Bebidas', name: 'Refrigerante 250 ml', price: 300, review: 'Marcas/sabores disponíveis não aparecem no cardápio.' },
  { key: 'menu:guarana-1l', category: 'Bebidas', name: 'Guaraná 1 L', price: 1000 },
  { key: 'menu:pepsi-1l', category: 'Bebidas', name: 'Pepsi 1 L', price: 1200 },
  { key: 'menu:suco-copo', category: 'Bebidas', name: 'Suco (copo)', price: 200, review: 'Sabores de suco não aparecem no cardápio.' },
  { key: 'menu:suco-1l', category: 'Bebidas', name: 'Suco 1 L', price: 1000, review: 'Sabores de suco não aparecem no cardápio.' }
];

// Taxa de entrega indicada no cardápio ("Taxa de entrega dois reais").
export const MENU_DELIVERY_FEE_CENTS = 200;

// Fotos ilustrativas em client/public/products (créditos em docs/referencias/CREDITOS-FOTOS.md).
const photo = (name) => `/products/${name}.jpg`;
export const MENU_IMAGES = {
  'menu:cuscuz-ovo': photo('cuscuz'), 'menu:cuscuz-frango': photo('cuscuz'), 'menu:cuscuz-carne-de-sol': photo('cuscuz'),
  'menu:tapioca-manteiga': photo('tapioca'), 'menu:tapioca-coco': photo('tapioca'), 'menu:tapioca-queijo': photo('tapioca'),
  'menu:tapioca-coco-leite-condensado': photo('tapioca'), 'menu:tapioca-frango': photo('tapioca'), 'menu:tapioca-carne-de-sol': photo('tapioca'),
  'menu:tapioca-misto': photo('tapioca'), 'menu:tapioca-do-meu-jeito': photo('tapioca'),
  'menu:pao-com-ovo': photo('pao-com-ovo'), 'menu:misto-quente': photo('misto-quente'), 'menu:crepe': photo('crepe'),
  'menu:salgado': photo('salgado'), 'menu:batata-frita': photo('batata-frita'), 'menu:mini-pizza': photo('mini-pizza'),
  'menu:torta': photo('torta'), 'menu:dindim-gourmet': photo('dindim'), 'menu:acai': photo('acai'),
  'menu:agua-500': photo('agua'), 'menu:agua-com-gas': photo('agua-com-gas'), 'menu:refrigerante-250': photo('refrigerante'),
  'menu:guarana-1l': photo('refrigerante'), 'menu:pepsi-1l': photo('refrigerante'), 'menu:suco-copo': photo('suco'), 'menu:suco-1l': photo('suco-1l')
};
