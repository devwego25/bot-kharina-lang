import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const STORES = [
  {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "name": "Curitiba"
  },
  {
    "id": "550e8400-e29b-41d4-a716-446655440002",
    "name": "Londrina"
  },
  {
    "id": "550e8400-e29b-41d4-a716-446655440003",
    "name": "São Paulo"
  }
];

const MENU_DATA: Record<string, any[]> = {
  "Curitiba": [
    {
      "categoria": "Grill",
      "nome": "PICANHA",
      "descricao": "Eleita o melhor prato do mundo pelo Tasteatlas Awards 2023, com nota de 4,75 de 5, a picanha está de volta ao cardápio da melhor steakhouse do Brasil. Suculência e maciez incomparáveis. Aproveite!",
      "preco": 104.9
    },
    {
      "categoria": "Grill",
      "nome": "ENTRECÔTE",
      "descricao": "Também conhecido como Bife Ancho, o Entrecôte é considerado um dos melhores cortes da carne bovina, extremamente saboroso, suculento e macio, tem fibras curtas e macias e um marmoreio incrível.",
      "preco": 94
    },
    {
      "categoria": "Grill",
      "nome": "BIFE DE CHORIZO",
      "descricao": "O Bife de Chorizo é um corte nobre consagrado da Argentina, é uma carne macia e de sabor acentuado. Sua camada de gordura externa mantém a umidade da carne.",
      "preco": 94
    },
    {
      "categoria": "Grill",
      "nome": "MIGNON",
      "descricao": "O filé mignon é caracterizado como a parte bovina mais macia dentre todas as peças. O Filé tem sabor adocicado e menos acentuado. É suculento e possui pouca gordura. Para garantir uma combinação sensacional, sugerimos duas opções de molhos que acompanha o prato: GORGONZOLA ou MOSTARDA.",
      "preco": 84
    },
    {
      "categoria": "Grill",
      "nome": "FRANGO",
      "descricao": "Uma escolha leve e saudável, nosso filé de peito de frango é selecionado com maestria. Desfrute da suculência e sabor incluindo um dos molhos: GORGONZOLA ou MOSTARDA.",
      "preco": 58
    },
    {
      "categoria": "Grill",
      "nome": "TILÁPIA",
      "descricao": "Descubra o prazer do mar em nosso cardápio com o Filé de Tilápia levemente empanada e selada no fio de azeite. Leve, suculento e perfeitamente preparado, este prato é um convite irresistível. Acompanha molho de alcaparras.",
      "preco": 59
    },
    {
      "categoria": "Saladas",
      "nome": "CAPRESE",
      "descricao": "Mix de folhas verdes crocantes acompanhado de muçarela de búfala, tomatinhos cereja, tomates secos e croûtons. Coberto com nosso molho caseiro italiano.",
      "preco": 42.5
    },
    {
      "categoria": "Saladas",
      "nome": "SALMÃO DEFUMADO",
      "descricao": "Refinada seleção de folhas verdes acompanhada por lascas de salmão defumado e molho mostarda e mel.",
      "preco": 46.5
    },
    {
      "categoria": "Saladas",
      "nome": "CAESAR",
      "descricao": "Tradicional mix de folhas verdes acompanhado de croûtons e coberto com parmesão, além do nosso típico molho caesar artesanal.",
      "preco": 38.5
    },
    {
      "categoria": "Saladas",
      "nome": "MANGA",
      "descricao": "Mix de folhas verdes crocantes acompanhado de manga, croûtons e coberto com queijo parmesão e com nosso molho rosé especialmente caseiro.",
      "preco": 38.5
    },
    {
      "categoria": "Feijoada",
      "nome": "FEIJOADA KHARINA",
      "descricao": "Tradicional feijoada completa, acompanhada de arroz branco, farofa, laranja, vinagrete, couve refogada com bacon e o inseparável torresminho.",
      "preco": 59.5
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "PICANHA",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 112
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "RIBEYE / ENTRECÔTE",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 104
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "BIFE DE CHORIZO",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 104
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "MIGNON",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 104
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "T-BONE",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 0
    },
    {
      "categoria": "Massas",
      "nome": "CAMARÃO SICILIANO",
      "descricao": "Camarão selado, servido com penne ao molho cremoso de limão siciliano e vinho chardonnay.",
      "preco": 65.9
    },
    {
      "categoria": "Massas",
      "nome": "GNOCCHI DOS DEUSES",
      "descricao": "Delicioso gnocchi caseiro servido com ragu de costela bovina desfiada e manjericão com lascas de queijo parmesão.",
      "preco": 56.5
    },
    {
      "categoria": "Massas",
      "nome": "SPAGHETTI PRIMAVERA",
      "descricao": "Massa spaghetti com muçarela de búfala, azeitonas pretas, manjericão fresco e molho ao sugo.",
      "preco": 49.5
    },
    {
      "categoria": "Massas",
      "nome": "SPAGHETTI COM SALMÃO",
      "descricao": "Massa spaghetti com molho branco, ervilha fresca, salmão defumado e rúcula.",
      "preco": 49.5
    },
    {
      "categoria": "Kids",
      "nome": "01 - MASSA COM MIGNON KIDS",
      "descricao": "Massa: spaghetti ou penne. Molho: branco ou sugo. Acompanha: queijo ralado.",
      "preco": 33.5
    },
    {
      "categoria": "Kids",
      "nome": "01 - MASSA COM CUBOS DE FRANGO KIDS",
      "descricao": "Massa: spaghetti ou penne. Molho: branco ou sugo. Acompanha: queijo ralado.",
      "preco": 29.5
    },
    {
      "categoria": "Kids",
      "nome": "02 - SANDUBINHAS",
      "descricao": "2 sanduichinhos com hambúrger 100% black angus e queijo, acompanhado de fritas e maionese especial KHARINA.",
      "preco": 31.5
    },
    {
      "categoria": "Kids",
      "nome": "03 - FILÉ DE FRANGO EMPANADO",
      "descricao": "2 unidades, acompanhado de fritas e maionese especial KHARINA.",
      "preco": 26.5
    },
    {
      "categoria": "Kids",
      "nome": "04 - MASSA E MOLHO À SUA ESCOLHA",
      "descricao": "Massa: spaghetti ou penne. Molho: branco ou sugo. Acompanha: queijo ralado.",
      "preco": 23.5
    },
    {
      "categoria": "Kids",
      "nome": "05 - MIGNON KHARINA KIDS",
      "descricao": "Acompanha arroz, feijão e fritas.",
      "preco": 33.5
    },
    {
      "categoria": "Kids",
      "nome": "05 - CUBOS DE FRANGO KHARINA KIDS",
      "descricao": "Acompanha arroz, feijão e fritas.",
      "preco": 29.5
    },
    {
      "categoria": "Kids",
      "nome": "06 - PENNE À BOLONHESA",
      "descricao": "Clássico molho italiano preparado com carne moída de primeira refogada ao molho sugo.",
      "preco": 29.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "BROWNIE COM SORVETE",
      "descricao": "Fatia de bolo de chocolate, cacau e noz-pecã, coberto com calda de chocolate. Escolha o sabor do sorvete: creme, chocolate, morango, flocos ou banana sobre farofa de bolacha.",
      "preco": 35.4
    },
    {
      "categoria": "Sobremesas",
      "nome": "APPLE PIE",
      "descricao": "Incrível torta quente de maçã. Escolha o sabor do sorvete: creme, chocolate, morango, flocos ou banana sobre farofa de bolacha.",
      "preco": 29.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "PETIT GATEAU",
      "descricao": "Bolinho quente de chocolate com recheio cremoso, com calda de chocolate. Escolha o sabor do sorvete: creme, chocolate, morango, flocos ou banana sobre farofa de bolacha.",
      "preco": 35.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "O PUDIM PERFEITO",
      "descricao": "-",
      "preco": 19.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "MINI BRIGADEIRO",
      "descricao": "-",
      "preco": 9.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "KHARINA BLACK COOKIE",
      "descricao": "Taça envolvida com delicioso ganache, oreo e calda de chocolate. Um mix de sabores com sorvete de chocolate, sorvete de creme, chantilly e um biscoito oreo.",
      "preco": 37.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "MILKSHAKE",
      "descricao": "Creme, morango, chocolate, flocos ou banana.",
      "preco": 29.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "BANANA SPLIT",
      "descricao": "3 bolas de sorvete (creme, morango, chocolate, flocos ou banana) + toppings.",
      "preco": 38.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "SUNDAE",
      "descricao": "2 bolas de sorvete (creme, morango, chocolate, flocos ou banana) + toppings.",
      "preco": 29.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "COLEGIAL",
      "descricao": "1 bola de sorvete (creme, morango, chocolate, flocos ou banana) + toppings.",
      "preco": 19.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "TAÇA DE SORVETE",
      "descricao": "1 bola de sorvete (creme, morango, chocolate, flocos ou banana).",
      "preco": 14.5
    },
    {
      "categoria": "Entradas",
      "nome": "POLENTA FRITA",
      "descricao": "Deliciosa polenta frita com parmesão, crocante por fora e macia por dentro. Acompanha delicioso molho tipo cheddar.",
      "preco": 24.5
    },
    {
      "categoria": "Entradas",
      "nome": "MINI PASTÉIS",
      "descricao": "Carne, queijo ou misto. Acompanha: geleia de pimenta.",
      "preco": 29.5
    },
    {
      "categoria": "Entradas",
      "nome": "FRITAS MÉDIA",
      "descricao": "Acompanha: maionese especial KHARINA.",
      "preco": 24.5
    },
    {
      "categoria": "Entradas",
      "nome": "KIBE FRITO",
      "descricao": "Acompanha: molho especial de limão.",
      "preco": 34.5
    },
    {
      "categoria": "Entradas",
      "nome": "CARPACCIO",
      "descricao": "Tradicional carpaccio temperado com um delicioso molho de alcaparras, além de rúcula e queijo parmesão. Acompanha torradas.",
      "preco": 49.5
    },
    {
      "categoria": "Entradas",
      "nome": "CAMARÃO CRISPY",
      "descricao": "Deliciosa porção crocante de camarões empanados com\nfarinha Panko. Acompanha molho rosé levemente picante.",
      "preco": 62.5
    },
    {
      "categoria": "Entradas",
      "nome": "COSTELINHA BARBECUE",
      "descricao": "Deliciosa costelinha suína marinada no molho barbecue servida com batata rústica e salada caesar.",
      "preco": 86.5
    },
    {
      "categoria": "Entradas",
      "nome": "CHICKEN CRISPY",
      "descricao": "Filés de frango empanados, acompanhados de maionese especial KHARINA.",
      "preco": 39.5
    },
    {
      "categoria": "Entradas",
      "nome": "FRITAS BIG",
      "descricao": "Batata frita gratinada com queijo tipo cheddar, parmesão, prato e bacon.",
      "preco": 48.5
    },
    {
      "categoria": "Entradas",
      "nome": "LINGUICINHA",
      "descricao": "Deliciosa linguiça de Costela Bovina Black Angus. Acompanha: farofa, vinagrete, maionese especial KHARINA e torradas.",
      "preco": 64.5
    },
    {
      "categoria": "Entradas",
      "nome": "NACHOS BIG",
      "descricao": "Porção de nachos com carne moída coberta de molho especial de queijo tipo cheddar, sour cream e guacamole.",
      "preco": 67.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CHOPP BRAHMA - CANECA CONGELADA",
      "descricao": "Delicioso chopp Brahma em caneca congelada a -40º.",
      "preco": 14.9
    },
    {
      "categoria": "Happy Hour",
      "nome": "CHOPP BRAHMA - CALDERETA",
      "descricao": "Delicioso chopp Brahma em copo resfriado.",
      "preco": 12.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CAIPIRINHA VODKA",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 25.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CAIPIRINHA CACHAÇA",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 23.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CAIPIRINHA SAQUÊ",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 26.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "MOSCOW MULE",
      "descricao": "Vodka, suco de limão, gengibre e espuma de gengibre.",
      "preco": 33.9
    },
    {
      "categoria": "Happy Hour",
      "nome": "NEGRONI",
      "descricao": "O Negroni engarrafado da Draco é marcante e envolvente. Uma releitura secreta do coquetel centenário, de origem italiana, leva Gin Draco London Dry, Bitter e Vermouth artesanal.",
      "preco": 33.9
    },
    {
      "categoria": "Happy Hour",
      "nome": "HAWAII SUNSET",
      "descricao": "Vodka, xarope MONIN sabor coco, suco de abacaxi e limão espremido.",
      "preco": 25
    },
    {
      "categoria": "Happy Hour",
      "nome": "GINGERBERRY",
      "descricao": "Vodka, xarope MONIN sabor framboesa, xarope MONIN sabor gengibre, água com gás e limão espremido.",
      "preco": 28.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "VINHO TINTO EM TAÇA",
      "descricao": "-",
      "preco": 19.8
    },
    {
      "categoria": "Happy Hour",
      "nome": "VINHO BRANCO EM TAÇA",
      "descricao": "-",
      "preco": 19.8
    },
    {
      "categoria": "Happy Hour",
      "nome": "COSTELINHA BARBECUE",
      "descricao": "Deliciosa costelinha suína marinada no molho barbecue servida  com batata rústica e salada caesar.",
      "preco": 86.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "LINGUICINHA",
      "descricao": "Linguiça de Costela Bovina Black Angus 350g. Acompanha: farofa, vinagrete, maionese especial KHARINA e torradas.",
      "preco": 64.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "NACHOS BIG",
      "descricao": "Porção de nachos com carne moída coberta com molho especial de queijo tipo cheddar, sour cream e guacamole.",
      "preco": 67.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CHICKEN CRISPY",
      "descricao": "Filés de frango empanados acompanhados de maionese especial KHARINA.",
      "preco": 39.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "KIBE FRITO",
      "descricao": "Acompanha delicioso molho especial de limão.",
      "preco": 34.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "MINI PASTÉIS",
      "descricao": "Carne, queijo ou misto. Acompanha deliciosa geleia de pimenta.",
      "preco": 29.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "FRITAS BIG",
      "descricao": "Batata frita gratinada com queijo tipo cheddar, parmesão, prato e bacon.",
      "preco": 48.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CARPACCIO",
      "descricao": "Tradicional carpaccio temperado com molho de alcaparras, além de rúcula e queijo parmesão. Acompanha torradas.",
      "preco": 49.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "HANDYMAN",
      "descricao": "Pão crocante, 2 hambúrgeres black angus, queijo tipo cheddar derretido, cebola crispy, bacon e maionese especial KHARINA.",
      "preco": 56.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "ROCK BURGER",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, bacon, cebola caramelizada e molho barbecue.",
      "preco": 49.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLASSIC BURGER",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, mix de folhas verdes, tomate e maionese especial KHARINA.",
      "preco": 48.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLASSIC BURGER BACON",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, bacon, mix de folhas verdes, tomate e maionese especial KHARINA.",
      "preco": 51.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLUB KHARINA",
      "descricao": "Suculento filé mignon intercalado com cebola assada até a perfeição, tomate fresco e bacon grelhado. Acompanha arroz, farofa, vinagrete e banana à milanesa.",
      "preco": 59.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLUB CHICKEN",
      "descricao": "Delicioso gnocchi caseiro servido com ragu de costela bovina desfiada e manjericão com lascas de queijo parmesão.",
      "preco": 56.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLUB ROCK",
      "descricao": "Delicioso bife de steak black angus KHARINA com molho de mostarda ou de gorgonzola, acompanhado de arroz, feijão e batatas fritas.",
      "preco": 61.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CHOPP BRAHMA - CANECA CONGELADA",
      "descricao": "Delicioso chopp Brahma em caneca congelada a -40º.",
      "preco": 14.9
    },
    {
      "categoria": "Bebidas",
      "nome": "CHOPP BRAHMA - CALDERETA",
      "descricao": "Delicioso chopp Brahma em copo resfriado.",
      "preco": 12.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CAIPIRINHA VODKA",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 25.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CAIPIRINHA CACHAÇA",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 23.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CAIPIRINHA SAQUÊ",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 26.5
    },
    {
      "categoria": "Bebidas",
      "nome": "MOSCOW MULE",
      "descricao": "Vodka, suco de limão, gengibre e espuma de gengibre.",
      "preco": 33.9
    },
    {
      "categoria": "Bebidas",
      "nome": "NEGRONI",
      "descricao": "O Negroni engarrafado da Draco é marcante e envolvente. Uma releitura secreta do coquetel centenário, de origem italiana, leva Gin Draco London Dry, Bitter e Vermouth artesanal.",
      "preco": 33.9
    },
    {
      "categoria": "Bebidas",
      "nome": "HAWAII SUNSET",
      "descricao": "Vodka, xarope MONIN sabor coco, suco de abacaxi e limão espremido.",
      "preco": 25
    },
    {
      "categoria": "Bebidas",
      "nome": "GINGERBERRY",
      "descricao": "Vodka, xarope MONIN sabor framboesa, xarope MONIN sabor gengibre, água com gás e limão espremido.",
      "preco": 28.5
    },
    {
      "categoria": "Bebidas",
      "nome": "VINHO TINTO EM TAÇA",
      "descricao": "-",
      "preco": 19.8
    },
    {
      "categoria": "Bebidas",
      "nome": "VINHO BRANCO EM TAÇA",
      "descricao": "-",
      "preco": 19.8
    },
    {
      "categoria": "Bebidas",
      "nome": "SPATEN LONK NECK",
      "descricao": "Autêntica cerveja puro malte alemã, de sabor encorpado e amargor equilibrado.",
      "preco": 15.9
    },
    {
      "categoria": "Bebidas",
      "nome": "GIN TROPICAL",
      "descricao": "Gin com xarope de manga picante, lichia e suco de limão, finalizado com água tônica, hortelã e uma rodela de limão. Refrescante e equilibrado entre o cítrico e o adocicado.",
      "preco": 25
    },
    {
      "categoria": "Bebidas",
      "nome": "NEGRONI NAPOLEÃO",
      "descricao": "O Negroni de Napoleão é uma receita perfeita que combina xarope MONIN de pêssego, suco de limão e hortelã, resultando em um drink suave, irresistível e digno do imperador.",
      "preco": 33.9
    },
    {
      "categoria": "Bebidas",
      "nome": "ÁGUA MINERAL COM OU SEM GÁS",
      "descricao": "-",
      "preco": 7.5
    },
    {
      "categoria": "Bebidas",
      "nome": "SUCO JARRA",
      "descricao": "Laranja ou limonada suíça.",
      "preco": 23.5
    },
    {
      "categoria": "Bebidas",
      "nome": "REFRIGERANTE 350ML",
      "descricao": "Coca-Cola, Coca-Cola Zero , Fanta Guaraná, Fanta Guaraná Zero, Fanta Laranja, Sprite e Tônica.",
      "preco": 9
    },
    {
      "categoria": "Bebidas",
      "nome": "SODA ITALIANA",
      "descricao": "Cranberry, limão, pêssego ou maçã verde.",
      "preco": 13.5
    },
    {
      "categoria": "Bebidas",
      "nome": "SUCO COPO",
      "descricao": "Laranja, abacaxi, abacaxi e hortelã, morango, maracujá, limonada suíça e uva.",
      "preco": 12.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CHÁ GELADO",
      "descricao": "Cranberry, limão, pêssego ou maçã verde.",
      "preco": 11.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "CLASSIC BURGER",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, mix de folhas verdes, tomate e maionese especial KHARINA.",
      "preco": 48.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "CLASSIC BURGER BACON",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, bacon, mix de folhas verdes, tomate e maionese especial KHARINA.",
      "preco": 51.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "CHORIPAN KHARINA",
      "descricao": "Pão crocante, linguiça de costela bovina black angus, queijo prato, maionese especial KHARINA e vinagrete.",
      "preco": 47.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "HANDYMAN",
      "descricao": "Pão crocante, 2 hambúrgeres black angus, queijo tipo cheddar derretido, cebola crispy, bacon e maionese especial KHARINA.",
      "preco": 56.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "ROCK BURGER",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, bacon, cebola caramelizada e molho barbecue.",
      "preco": 49.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "HAMBÚGUER VEGETARIANO",
      "descricao": "Pão crocante, hambúrger produzido com a proteína da ervilha, soja e grão de bico, queijo tipo cheddar derretido, mix de folhas verdes, tomate e maionese vegana especial KHARINA.",
      "preco": 49.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE BURGER",
      "descricao": "Pão brioche, hambúrger black angus, queijo prato e maionese especial KHARINA.",
      "preco": 37.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE SALADA",
      "descricao": "Pão brioche, hambúrger black angus, alface crespa, tomate, queijo prato, cebola e maionese especial KHARINA.",
      "preco": 41.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE FRANGO",
      "descricao": "Pão brioche, delicioso frango grelhado, alface crespa, tomate, queijo prato e maionese especial KHARINA.",
      "preco": 38.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE FRANGO CRISPY",
      "descricao": "Pão brioche, delicioso filé de frango empanado com farinha Panko, alface crespa, tomate, queijo prato e maionese de limão com ervas finas.",
      "preco": 44.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE MIGNON",
      "descricao": "Pão brioche, delicioso grelhado de mignon, alface crespa, tomate, queijo prato, cebola e maionese especial KHARINA.",
      "preco": 58.5
    },
    {
      "categoria": "Clássicos",
      "nome": "CLUB KHARINA",
      "descricao": "Suculento filé mignon intercalado com cebola assada até a perfeição, tomate fresco e bacon grelhado. Acompanha arroz, farofa, vinagrete e banana à milanesa.",
      "preco": 59.5
    },
    {
      "categoria": "Clássicos",
      "nome": "CLUB ROCK",
      "descricao": "Delicioso bife de steak black angus KHARINA com molho de mostarda ou de gorgonzola, acompanhado de arroz, feijão e batatas fritas.",
      "preco": 61.5
    },
    {
      "categoria": "Clássicos",
      "nome": "CLUB MIGNON",
      "descricao": "Suculento strogonoff de mignon, acompanhado de arroz branco e a inseparável porção de batatas fritas.",
      "preco": 68.5
    },
    {
      "categoria": "Clássicos",
      "nome": "CLUB CHICKEN",
      "descricao": "Delicioso gnocchi caseiro servido com ragu de costela bovina desfiada e manjericão com lascas de queijo parmesão.",
      "preco": 56.5
    },
    {
      "categoria": "Executivos",
      "nome": "ESPETINHO DE MIGNON",
      "descricao": "Suculento filé mignon intercalado com cebola assada até a perfeição, tomate fresco e bacon grelhado. Acompanha arroz, farofa, vinagrete e banana à milanesa.",
      "preco": 57.5
    },
    {
      "categoria": "Executivos",
      "nome": "STEAK BLACK ANGUS KHARINA",
      "descricao": "Delicioso bife de steak black angus KHARINA com molho de mostarda ou de gorgonzola, acompanhado de arroz, feijão e batatas fritas.",
      "preco": 49.5
    },
    {
      "categoria": "Executivos",
      "nome": "STROGONOFF DE MIGNON",
      "descricao": "Suculento strogonoff de mignon, acompanhado de arroz branco e a inseparável porção de batatas fritas.",
      "preco": 57.5
    },
    {
      "categoria": "Executivos",
      "nome": "GNOCCHI DOS DEUSES",
      "descricao": "Delicioso gnocchi caseiro servido com ragu de costela bovina desfiada e manjericão com lascas de queijo parmesão.",
      "preco": 49.5
    },
    {
      "categoria": "Executivos",
      "nome": "FRANGO À PARMEGIANA",
      "descricao": "Tradicional receita de filé black angus empanado, coberto com queijo prato, parmesão e um especial molho de tomate e por fim, gratinado. Acompanha arroz.",
      "preco": 49.5
    },
    {
      "categoria": "Executivos",
      "nome": "FILET À PARMEGIANA",
      "descricao": "Tradicional receita de filé black angus empanado, coberto com queijo prato, parmesão e um especial molho de tomate e por fim, gratinado. Acompanha arroz.",
      "preco": 57.5
    }
  ],
  "Londrina": [
    {
      "categoria": "Grill",
      "nome": "PICANHA",
      "descricao": "Eleita o melhor prato do mundo pelo Tasteatlas Awards 2023, com nota de 4,75 de 5, a picanha está de volta ao cardápio da melhor steakhouse do Brasil. Suculência e maciez incomparáveis. Aproveite!",
      "preco": 104.9
    },
    {
      "categoria": "Grill",
      "nome": "ENTRECÔTE",
      "descricao": "Também conhecido como Bife Ancho, o Entrecôte é considerado um dos melhores cortes da carne bovina, extremamente saboroso, suculento e macio, tem fibras curtas e macias e um marmoreio incrível.",
      "preco": 94
    },
    {
      "categoria": "Grill",
      "nome": "BIFE DE CHORIZO",
      "descricao": "O Bife de Chorizo é um corte nobre consagrado da Argentina, é uma carne macia e de sabor acentuado. Sua camada de gordura externa mantém a umidade da carne.",
      "preco": 94
    },
    {
      "categoria": "Grill",
      "nome": "MIGNON",
      "descricao": "O filé mignon é caracterizado como a parte bovina mais macia dentre todas as peças. O Filé tem sabor adocicado e menos acentuado. É suculento e possui pouca gordura. Para garantir uma combinação sensacional, sugerimos duas opções de molhos que acompanha o prato: GORGONZOLA ou MOSTARDA.",
      "preco": 84
    },
    {
      "categoria": "Grill",
      "nome": "FRANGO",
      "descricao": "Uma escolha leve e saudável, nosso filé de peito de frango é selecionado com maestria. Desfrute da suculência e sabor incluindo um dos molhos: GORGONZOLA ou MOSTARDA.",
      "preco": 58
    },
    {
      "categoria": "Grill",
      "nome": "TILÁPIA",
      "descricao": "Descubra o prazer do mar em nosso cardápio com o Filé de Tilápia levemente empanada e selada no fio de azeite. Leve, suculento e perfeitamente preparado, este prato é um convite irresistível. Acompanha molho de alcaparras.",
      "preco": 59
    },
    {
      "categoria": "Saladas",
      "nome": "CAPRESE",
      "descricao": "Mix de folhas verdes crocantes acompanhado de muçarela de búfala, tomatinhos cereja, tomates secos e croûtons. Coberto com nosso molho caseiro italiano.",
      "preco": 42.5
    },
    {
      "categoria": "Saladas",
      "nome": "SALMÃO DEFUMADO",
      "descricao": "Refinada seleção de folhas verdes acompanhada por lascas de salmão defumado e molho mostarda e mel.",
      "preco": 46.5
    },
    {
      "categoria": "Saladas",
      "nome": "CAESAR",
      "descricao": "Tradicional mix de folhas verdes acompanhado de croûtons e coberto com parmesão, além do nosso típico molho caesar artesanal.",
      "preco": 38.5
    },
    {
      "categoria": "Saladas",
      "nome": "MANGA",
      "descricao": "Mix de folhas verdes crocantes acompanhado de manga, croûtons e coberto com queijo parmesão e com nosso molho rosé especialmente caseiro.",
      "preco": 38.5
    },
    {
      "categoria": "Feijoada",
      "nome": "FEIJOADA KHARINA",
      "descricao": "Tradicional feijoada completa, acompanhada de arroz branco, farofa, laranja, vinagrete, couve refogada com bacon e o inseparável torresminho.",
      "preco": 59.5
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "PICANHA",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 112
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "RIBEYE / ENTRECÔTE",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 104
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "BIFE DE CHORIZO",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 104
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "MIGNON",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 104
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "T-BONE",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 0
    },
    {
      "categoria": "Massas",
      "nome": "CAMARÃO SICILIANO",
      "descricao": "Camarão selado, servido com penne ao molho cremoso de limão siciliano e vinho chardonnay.",
      "preco": 65.9
    },
    {
      "categoria": "Massas",
      "nome": "GNOCCHI DOS DEUSES",
      "descricao": "Delicioso gnocchi caseiro servido com ragu de costela bovina desfiada e manjericão com lascas de queijo parmesão.",
      "preco": 56.5
    },
    {
      "categoria": "Massas",
      "nome": "SPAGHETTI PRIMAVERA",
      "descricao": "Massa spaghetti com muçarela de búfala, azeitonas pretas, manjericão fresco e molho ao sugo.",
      "preco": 49.5
    },
    {
      "categoria": "Massas",
      "nome": "SPAGHETTI COM SALMÃO",
      "descricao": "Massa spaghetti com molho branco, ervilha fresca, salmão defumado e rúcula.",
      "preco": 49.5
    },
    {
      "categoria": "Kids",
      "nome": "01 - MASSA COM MIGNON KIDS",
      "descricao": "Massa: spaghetti ou penne. Molho: branco ou sugo. Acompanha: queijo ralado.",
      "preco": 33.5
    },
    {
      "categoria": "Kids",
      "nome": "01 - MASSA COM CUBOS DE FRANGO KIDS",
      "descricao": "Massa: spaghetti ou penne. Molho: branco ou sugo. Acompanha: queijo ralado.",
      "preco": 29.5
    },
    {
      "categoria": "Kids",
      "nome": "02 - SANDUBINHAS",
      "descricao": "2 sanduichinhos com hambúrger 100% black angus e queijo, acompanhado de fritas e maionese especial KHARINA.",
      "preco": 31.5
    },
    {
      "categoria": "Kids",
      "nome": "03 - FILÉ DE FRANGO EMPANADO",
      "descricao": "2 unidades, acompanhado de fritas e maionese especial KHARINA.",
      "preco": 26.5
    },
    {
      "categoria": "Kids",
      "nome": "04 - MASSA E MOLHO À SUA ESCOLHA",
      "descricao": "Massa: spaghetti ou penne. Molho: branco ou sugo. Acompanha: queijo ralado.",
      "preco": 23.5
    },
    {
      "categoria": "Kids",
      "nome": "05 - MIGNON KHARINA KIDS",
      "descricao": "Acompanha arroz, feijão e fritas.",
      "preco": 33.5
    },
    {
      "categoria": "Kids",
      "nome": "05 - CUBOS DE FRANGO KHARINA KIDS",
      "descricao": "Acompanha arroz, feijão e fritas.",
      "preco": 29.5
    },
    {
      "categoria": "Kids",
      "nome": "06 - PENNE À BOLONHESA",
      "descricao": "Clássico molho italiano preparado com carne moída de primeira refogada ao molho sugo.",
      "preco": 29.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "BROWNIE COM SORVETE",
      "descricao": "Fatia de bolo de chocolate, cacau e noz-pecã, coberto com calda de chocolate. Escolha o sabor do sorvete: creme, chocolate, morango, flocos ou banana sobre farofa de bolacha.",
      "preco": 35.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "APPLE PIE",
      "descricao": "Incrível torta quente de maçã. Escolha o sabor do sorvete: creme, chocolate, morango, flocos ou banana sobre farofa de bolacha.",
      "preco": 29.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "PETIT GATEAU",
      "descricao": "Bolinho quente de chocolate com recheio cremoso, com calda de chocolate. Escolha o sabor do sorvete: creme, chocolate, morango, flocos ou banana sobre farofa de bolacha.",
      "preco": 35.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "O PUDIM PERFEITO",
      "descricao": "-",
      "preco": 19.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "MINI BRIGADEIRO",
      "descricao": "-",
      "preco": 9.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "KHARINA BLACK COOKIE",
      "descricao": "Taça envolvida com delicioso ganache, oreo e calda de chocolate. Um mix de sabores com sorvete de chocolate, sorvete de creme, chantilly e um biscoito oreo.",
      "preco": 37.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "MILKSHAKE",
      "descricao": "Creme, morango, chocolate, flocos ou banana.",
      "preco": 29.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "BANANA SPLIT",
      "descricao": "3 bolas de sorvete (creme, morango, chocolate, flocos ou banana) + toppings.",
      "preco": 38.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "SUNDAE",
      "descricao": "2 bolas de sorvete (creme, morango, chocolate, flocos ou banana) + toppings.",
      "preco": 29.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "COLEGIAL",
      "descricao": "1 bola de sorvete (creme, morango, chocolate, flocos ou banana) + toppings.",
      "preco": 19.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "TAÇA DE SORVETE",
      "descricao": "1 bola de sorvete (creme, morango, chocolate, flocos ou banana).",
      "preco": 14.5
    },
    {
      "categoria": "Entradas",
      "nome": "POLENTA FRITA",
      "descricao": "Deliciosa polenta frita com parmesão, crocante por fora e macia por dentro. Acompanha delicioso molho tipo cheddar.",
      "preco": 24.5
    },
    {
      "categoria": "Entradas",
      "nome": "MINI PASTÉIS",
      "descricao": "Carne, queijo ou misto. Acompanha: geleia de pimenta.",
      "preco": 29.5
    },
    {
      "categoria": "Entradas",
      "nome": "FRITAS MÉDIA",
      "descricao": "Acompanha: maionese especial KHARINA.",
      "preco": 24.5
    },
    {
      "categoria": "Entradas",
      "nome": "KIBE FRITO",
      "descricao": "Acompanha: molho especial de limão.",
      "preco": 34.5
    },
    {
      "categoria": "Entradas",
      "nome": "CARPACCIO",
      "descricao": "Tradicional carpaccio temperado com um delicioso molho de alcaparras, além de rúcula e queijo parmesão. Acompanha torradas.",
      "preco": 49.5
    },
    {
      "categoria": "Entradas",
      "nome": "CAMARÃO CRISPY",
      "descricao": "Deliciosa porção crocante de camarões empanados com\nfarinha Panko. Acompanha molho rosé levemente picante.",
      "preco": 62.5
    },
    {
      "categoria": "Entradas",
      "nome": "COSTELINHA BARBECUE",
      "descricao": "Deliciosa costelinha suína marinada no molho barbecue servida com batata rústica e salada caesar.",
      "preco": 86.5
    },
    {
      "categoria": "Entradas",
      "nome": "CHICKEN CRISPY",
      "descricao": "Filés de frango empanados, acompanhados de maionese especial KHARINA.",
      "preco": 39.5
    },
    {
      "categoria": "Entradas",
      "nome": "FRITAS BIG",
      "descricao": "Batata frita gratinada com queijo tipo cheddar, parmesão, prato e bacon.",
      "preco": 48.5
    },
    {
      "categoria": "Entradas",
      "nome": "LINGUICINHA",
      "descricao": "Deliciosa linguiça de Costela Bovina Black Angus. Acompanha: farofa, vinagrete, maionese especial KHARINA e torradas.",
      "preco": 64.5
    },
    {
      "categoria": "Entradas",
      "nome": "NACHOS BIG",
      "descricao": "Porção de nachos com carne moída coberta de molho especial de queijo tipo cheddar, sour cream e guacamole.",
      "preco": 67.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CHOPP BRAHMA - CANECA CONGELADA",
      "descricao": "Delicioso chopp Brahma em caneca congelada a -40º.",
      "preco": 14.9
    },
    {
      "categoria": "Happy Hour",
      "nome": "CHOPP BRAHMA - CALDERETA",
      "descricao": "Delicioso chopp Brahma em copo resfriado.",
      "preco": 12.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CAIPIRINHA VODKA",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 25.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CAIPIRINHA CACHAÇA",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 23.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CAIPIRINHA SAQUÊ",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 26.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "MOSCOW MULE",
      "descricao": "Vodka, suco de limão, gengibre e espuma de gengibre.",
      "preco": 33.9
    },
    {
      "categoria": "Happy Hour",
      "nome": "NEGRONI",
      "descricao": "O Negroni engarrafado da Draco é marcante e envolvente. Uma releitura secreta do coquetel centenário, de origem italiana, leva Gin Draco London Dry, Bitter e Vermouth artesanal.",
      "preco": 33.9
    },
    {
      "categoria": "Happy Hour",
      "nome": "HAWAII SUNSET",
      "descricao": "Vodka, xarope MONIN sabor coco, suco de abacaxi e limão espremido.",
      "preco": 25
    },
    {
      "categoria": "Happy Hour",
      "nome": "GINGERBERRY",
      "descricao": "Vodka, xarope MONIN sabor framboesa, xarope MONIN sabor gengibre, água com gás e limão espremido.",
      "preco": 28.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "VINHO TINTO EM TAÇA",
      "descricao": "-",
      "preco": 19.8
    },
    {
      "categoria": "Happy Hour",
      "nome": "VINHO BRANCO EM TAÇA",
      "descricao": "-",
      "preco": 19.8
    },
    {
      "categoria": "Happy Hour",
      "nome": "COSTELINHA BARBECUE",
      "descricao": "Deliciosa costelinha suína marinada no molho barbecue servida  com batata rústica e salada caesar.",
      "preco": 86.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "LINGUICINHA",
      "descricao": "Linguiça de Costela Bovina Black Angus 350g. Acompanha: farofa, vinagrete, maionese especial KHARINA e torradas.",
      "preco": 76.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "NACHOS BIG",
      "descricao": "Porção de nachos com carne moída coberta com molho especial de queijo tipo cheddar, sour cream e guacamole.",
      "preco": 67.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CHICKEN CRISPY",
      "descricao": "Filés de frango empanados acompanhados de maionese especial KHARINA.",
      "preco": 39.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "KIBE FRITO",
      "descricao": "Acompanha delicioso molho especial de limão.",
      "preco": 34.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "MINI PASTÉIS",
      "descricao": "Carne, queijo ou misto. Acompanha deliciosa geleia de pimenta.",
      "preco": 29.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "FRITAS BIG",
      "descricao": "Batata frita gratinada com queijo tipo cheddar, parmesão, prato e bacon.",
      "preco": 48.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CARPACCIO",
      "descricao": "Tradicional carpaccio temperado com molho de alcaparras, além de rúcula e queijo parmesão. Acompanha torradas.",
      "preco": 49.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "HANDYMAN",
      "descricao": "Pão crocante, 2 hambúrgeres black angus, queijo tipo cheddar derretido, cebola crispy, bacon e maionese especial KHARINA.",
      "preco": 56.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "ROCK BURGER",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, bacon, cebola caramelizada e molho barbecue.",
      "preco": 49.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLASSIC BURGER",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, mix de folhas verdes, tomate e maionese especial KHARINA.",
      "preco": 48.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLASSIC BURGER BACON",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, bacon, mix de folhas verdes, tomate e maionese especial KHARINA.",
      "preco": 51.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLUB KHARINA",
      "descricao": "Suculento filé mignon intercalado com cebola assada até a perfeição, tomate fresco e bacon grelhado. Acompanha arroz, farofa, vinagrete e banana à milanesa.",
      "preco": 59.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLUB CHICKEN",
      "descricao": "Delicioso gnocchi caseiro servido com ragu de costela bovina desfiada e manjericão com lascas de queijo parmesão.",
      "preco": 56.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLUB ROCK",
      "descricao": "Delicioso bife de steak black angus KHARINA com molho de mostarda ou de gorgonzola, acompanhado de arroz, feijão e batatas fritas.",
      "preco": 61.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CHOPP BRAHMA - CANECA CONGELADA",
      "descricao": "Delicioso chopp Brahma em caneca congelada a -40º.",
      "preco": 14.9
    },
    {
      "categoria": "Bebidas",
      "nome": "CHOPP BRAHMA - CALDERETA",
      "descricao": "Delicioso chopp Brahma em copo resfriado.",
      "preco": 12.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CAIPIRINHA VODKA",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 25.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CAIPIRINHA CACHAÇA",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 23.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CAIPIRINHA SAQUÊ",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 26.5
    },
    {
      "categoria": "Bebidas",
      "nome": "MOSCOW MULE",
      "descricao": "Vodka, suco de limão, gengibre e espuma de gengibre.",
      "preco": 33.9
    },
    {
      "categoria": "Bebidas",
      "nome": "NEGRONI",
      "descricao": "O Negroni engarrafado da Draco é marcante e envolvente. Uma releitura secreta do coquetel centenário, de origem italiana, leva Gin Draco London Dry, Bitter e Vermouth artesanal.",
      "preco": 33.9
    },
    {
      "categoria": "Bebidas",
      "nome": "HAWAII SUNSET",
      "descricao": "Vodka, xarope MONIN sabor coco, suco de abacaxi e limão espremido.",
      "preco": 25
    },
    {
      "categoria": "Bebidas",
      "nome": "GINGERBERRY",
      "descricao": "Vodka, xarope MONIN sabor framboesa, xarope MONIN sabor gengibre, água com gás e limão espremido.",
      "preco": 28.5
    },
    {
      "categoria": "Bebidas",
      "nome": "VINHO TINTO EM TAÇA",
      "descricao": "-",
      "preco": 19.8
    },
    {
      "categoria": "Bebidas",
      "nome": "VINHO BRANCO EM TAÇA",
      "descricao": "-",
      "preco": 19.8
    },
    {
      "categoria": "Bebidas",
      "nome": "SPATEN LONK NECK",
      "descricao": "Autêntica cerveja puro malte alemã, de sabor encorpado e amargor equilibrado.",
      "preco": 15.9
    },
    {
      "categoria": "Bebidas",
      "nome": "GIN TROPICAL",
      "descricao": "Gin com xarope de manga picante, lichia e suco de limão, finalizado com água tônica, hortelã e uma rodela de limão. Refrescante e equilibrado entre o cítrico e o adocicado.",
      "preco": 25
    },
    {
      "categoria": "Bebidas",
      "nome": "NEGRONI NAPOLEÃO",
      "descricao": "O Negroni de Napoleão é uma receita perfeita que combina xarope MONIN de pêssego, suco de limão e hortelã, resultando em um drink suave, irresistível e digno do imperador.",
      "preco": 33.9
    },
    {
      "categoria": "Bebidas",
      "nome": "ÁGUA MINERAL COM OU SEM GÁS",
      "descricao": "-",
      "preco": 7.5
    },
    {
      "categoria": "Bebidas",
      "nome": "SUCO JARRA",
      "descricao": "Laranja ou limonada suíça.",
      "preco": 23.5
    },
    {
      "categoria": "Bebidas",
      "nome": "REFRIGERANTE 350ML",
      "descricao": "Coca-Cola, Coca-Cola Zero , Fanta Guaraná, Fanta Guaraná Zero, Fanta Laranja, Sprite e Tônica.",
      "preco": 9
    },
    {
      "categoria": "Bebidas",
      "nome": "SODA ITALIANA",
      "descricao": "Cranberry, limão, pêssego ou maçã verde.",
      "preco": 13.5
    },
    {
      "categoria": "Bebidas",
      "nome": "SUCO COPO",
      "descricao": "Laranja, abacaxi, abacaxi e hortelã, morango, maracujá, limonada suíça e uva.",
      "preco": 12.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CHÁ GELADO",
      "descricao": "Cranberry, limão, pêssego ou maçã verde.",
      "preco": 11.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "CLASSIC BURGER",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, mix de folhas verdes, tomate e maionese especial KHARINA.",
      "preco": 48.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "CLASSIC BURGER BACON",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, bacon, mix de folhas verdes, tomate e maionese especial KHARINA.",
      "preco": 51.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "CHORIPAN KHARINA",
      "descricao": "Pão crocante, linguiça de costela bovina black angus, queijo prato, maionese especial KHARINA e vinagrete.",
      "preco": 47.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "HANDYMAN",
      "descricao": "Pão crocante, 2 hambúrgeres black angus, queijo tipo cheddar derretido, cebola crispy, bacon e maionese especial KHARINA.",
      "preco": 56.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "ROCK BURGER",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, bacon, cebola caramelizada e molho barbecue.",
      "preco": 49.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "HAMBÚGUER VEGETARIANO",
      "descricao": "Pão crocante, hambúrger produzido com a proteína da ervilha, soja e grão de bico, queijo tipo cheddar derretido, mix de folhas verdes, tomate e maionese vegana especial KHARINA.",
      "preco": 49.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE BURGER",
      "descricao": "Pão brioche, hambúrger black angus, queijo prato e maionese especial KHARINA.",
      "preco": 37.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE SALADA",
      "descricao": "Pão brioche, hambúrger black angus, alface crespa, tomate, queijo prato, cebola e maionese especial KHARINA.",
      "preco": 41.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE FRANGO",
      "descricao": "Pão brioche, delicioso frango grelhado, alface crespa, tomate, queijo prato e maionese especial KHARINA.",
      "preco": 38.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE FRANGO CRISPY",
      "descricao": "Pão brioche, delicioso filé de frango empanado com farinha Panko, alface crespa, tomate, queijo prato e maionese de limão com ervas finas.",
      "preco": 44.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE MIGNON",
      "descricao": "Pão brioche, delicioso grelhado de mignon, alface crespa, tomate, queijo prato, cebola e maionese especial KHARINA.",
      "preco": 58.5
    },
    {
      "categoria": "Clássicos",
      "nome": "CLUB KHARINA",
      "descricao": "Suculento filé mignon intercalado com cebola assada até a perfeição, tomate fresco e bacon grelhado. Acompanha arroz, farofa, vinagrete e banana à milanesa.",
      "preco": 59.5
    },
    {
      "categoria": "Clássicos",
      "nome": "CLUB ROCK",
      "descricao": "Delicioso bife de steak black angus KHARINA com molho de mostarda ou de gorgonzola, acompanhado de arroz, feijão e batatas fritas.",
      "preco": 61.5
    },
    {
      "categoria": "Clássicos",
      "nome": "CLUB MIGNON",
      "descricao": "Suculento strogonoff de mignon, acompanhado de arroz branco e a inseparável porção de batatas fritas.",
      "preco": 68.5
    },
    {
      "categoria": "Clássicos",
      "nome": "CLUB CHICKEN",
      "descricao": "Delicioso gnocchi caseiro servido com ragu de costela bovina desfiada e manjericão com lascas de queijo parmesão.",
      "preco": 56.5
    },
    {
      "categoria": "Executivos",
      "nome": "ESPETINHO DE MIGNON",
      "descricao": "Suculento filé mignon intercalado com cebola assada até a perfeição, tomate fresco e bacon grelhado. Acompanha arroz, farofa, vinagrete e banana à milanesa.",
      "preco": 42.5
    },
    {
      "categoria": "Executivos",
      "nome": "STEAK BLACK ANGUS KHARINA",
      "descricao": "Delicioso bife de steak black angus KHARINA com molho de mostarda ou de gorgonzola, acompanhado de arroz, feijão e batatas fritas.",
      "preco": 42.5
    },
    {
      "categoria": "Executivos",
      "nome": "STROGONOFF DE MIGNON",
      "descricao": "Suculento strogonoff de mignon, acompanhado de arroz branco e a inseparável porção de batatas fritas.",
      "preco": 42.5
    },
    {
      "categoria": "Executivos",
      "nome": "GNOCCHI DOS DEUSES",
      "descricao": "Delicioso gnocchi caseiro servido com ragu de costela bovina desfiada e manjericão com lascas de queijo parmesão.",
      "preco": 42.5
    },
    {
      "categoria": "Executivos",
      "nome": "FRANGO À PARMEGIANA",
      "descricao": "Tradicional receita de filé black angus empanado, coberto com queijo prato, parmesão e um especial molho de tomate e por fim, gratinado. Acompanha arroz.",
      "preco": 39.5
    },
    {
      "categoria": "Executivos",
      "nome": "FILET À PARMEGIANA",
      "descricao": "Tradicional receita de filé black angus empanado, coberto com queijo prato, parmesão e um especial molho de tomate e por fim, gratinado. Acompanha arroz.",
      "preco": 42.5
    }
  ],
  "São Paulo": [
    {
      "categoria": "Grill",
      "nome": "ENTRECÔTE",
      "descricao": "Também conhecido como Bife Ancho, o Entrecôte é considerado um dos melhores cortes da carne bovina, extremamente saboroso, suculento e macio, tem fibras curtas e macias e um marmoreio incrível.",
      "preco": 94
    },
    {
      "categoria": "Grill",
      "nome": "BIFE DE CHORIZO",
      "descricao": "O Bife de Chorizo é um corte nobre consagrado da Argentina, é uma carne macia e de sabor acentuado. Sua camada de gordura externa mantém a umidade da carne.",
      "preco": 94
    },
    {
      "categoria": "Grill",
      "nome": "MIGNON",
      "descricao": "O filé mignon é caracterizado como a parte bovina mais macia dentre todas as peças. O Filé tem sabor adocicado e menos acentuado. É suculento e possui pouca gordura. Para garantir uma combinação sensacional, sugerimos duas opções de molhos que acompanha o prato: GORGONZOLA ou MOSTARDA.",
      "preco": 84
    },
    {
      "categoria": "Grill",
      "nome": "FRANGO",
      "descricao": "Uma escolha leve e saudável, nosso filé de peito de frango é selecionado com maestria. Desfrute da suculência e sabor incluindo um dos molhos: GORGONZOLA ou MOSTARDA.",
      "preco": 58
    },
    {
      "categoria": "Grill",
      "nome": "TILÁPIA",
      "descricao": "Descubra o prazer do mar em nosso cardápio com o Filé de Tilápia levemente empanada e selada no fio de azeite. Leve, suculento e perfeitamente preparado, este prato é um convite irresistível. Acompanha molho de alcaparras.",
      "preco": 59
    },
    {
      "categoria": "Saladas",
      "nome": "CAPRESE",
      "descricao": "Mix de folhas verdes crocantes acompanhado de muçarela de búfala, tomatinhos cereja, tomates secos e croûtons. Coberto com nosso molho caseiro italiano.",
      "preco": 42.5
    },
    {
      "categoria": "Saladas",
      "nome": "SALMÃO DEFUMADO",
      "descricao": "Refinada seleção de folhas verdes acompanhada por lascas de salmão defumado e molho mostarda e mel.",
      "preco": 46.5
    },
    {
      "categoria": "Saladas",
      "nome": "CAESAR",
      "descricao": "Tradicional mix de folhas verdes acompanhado de croûtons e coberto com parmesão, além do nosso típico molho caesar artesanal.",
      "preco": 38.5
    },
    {
      "categoria": "Saladas",
      "nome": "MANGA",
      "descricao": "Mix de folhas verdes crocantes acompanhado de manga, croûtons e coberto com queijo parmesão e com nosso molho rosé especialmente caseiro.",
      "preco": 38.5
    },
    {
      "categoria": "Feijoada",
      "nome": "FEIJOADA KHARINA",
      "descricao": "Tradicional feijoada completa, acompanhada de arroz branco, farofa, laranja, vinagrete, couve refogada com bacon e o inseparável torresminho.",
      "preco": 59.5
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "RIBEYE / ENTRECÔTE",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 104
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "BIFE DE CHORIZO",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 104
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "MIGNON",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 104
    },
    {
      "categoria": "Churrasco KHARINA",
      "nome": "T-BONE",
      "descricao": "Acompanhamento: Alho Cozido; Cebola Assada; Tomate Assado; Farofa; Arroz Biro-Biro; Maionese de Batata; e Mini Polenta de entrada.",
      "preco": 0
    },
    {
      "categoria": "Massas",
      "nome": "CAMARÃO SICILIANO",
      "descricao": "Camarão selado, servido com penne ao molho cremoso de limão siciliano e vinho chardonnay.",
      "preco": 65.9
    },
    {
      "categoria": "Massas",
      "nome": "GNOCCHI DOS DEUSES",
      "descricao": "Delicioso gnocchi caseiro servido com ragu de costela bovina desfiada e manjericão com lascas de queijo parmesão.",
      "preco": 56.5
    },
    {
      "categoria": "Massas",
      "nome": "SPAGHETTI PRIMAVERA",
      "descricao": "Massa spaghetti com muçarela de búfala, azeitonas pretas, manjericão fresco e molho ao sugo.",
      "preco": 49.5
    },
    {
      "categoria": "Massas",
      "nome": "SPAGHETTI COM SALMÃO",
      "descricao": "Massa spaghetti com molho branco, ervilha fresca, salmão defumado e rúcula.",
      "preco": 49.5
    },
    {
      "categoria": "Kids",
      "nome": "01 - MASSA COM MIGNON KIDS",
      "descricao": "Massa: spaghetti ou penne. Molho: branco ou sugo. Acompanha: queijo ralado.",
      "preco": 33.5
    },
    {
      "categoria": "Kids",
      "nome": "01 - MASSA COM CUBOS DE FRANGO KIDS",
      "descricao": "Massa: spaghetti ou penne. Molho: branco ou sugo. Acompanha: queijo ralado.",
      "preco": 29.5
    },
    {
      "categoria": "Kids",
      "nome": "02 - SANDUBINHAS",
      "descricao": "2 sanduichinhos com hambúrger 100% black angus e queijo, acompanhado de fritas e maionese especial KHARINA.",
      "preco": 31.5
    },
    {
      "categoria": "Kids",
      "nome": "03 - FILÉ DE FRANGO EMPANADO",
      "descricao": "2 unidades, acompanhado de fritas e maionese especial KHARINA.",
      "preco": 26.5
    },
    {
      "categoria": "Kids",
      "nome": "04 - MASSA E MOLHO À SUA ESCOLHA",
      "descricao": "Massa: spaghetti ou penne. Molho: branco ou sugo. Acompanha: queijo ralado.",
      "preco": 23.5
    },
    {
      "categoria": "Kids",
      "nome": "05 - MIGNON KHARINA KIDS",
      "descricao": "Acompanha arroz, feijão e fritas.",
      "preco": 33.5
    },
    {
      "categoria": "Kids",
      "nome": "05 - CUBOS DE FRANGO KHARINA KIDS",
      "descricao": "Acompanha arroz, feijão e fritas.",
      "preco": 29.5
    },
    {
      "categoria": "Kids",
      "nome": "06 - PENNE À BOLONHESA",
      "descricao": "Clássico molho italiano preparado com carne moída de primeira refogada ao molho sugo.",
      "preco": 29.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "BROWNIE COM SORVETE",
      "descricao": "Fatia de bolo de chocolate, cacau e noz-pecã, coberto com calda de chocolate. Escolha o sabor do sorvete: creme, chocolate, morango, flocos ou banana sobre farofa de bolacha.",
      "preco": 35.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "APPLE PIE",
      "descricao": "Incrível torta quente de maçã. Escolha o sabor do sorvete: creme, chocolate, morango, flocos ou banana sobre farofa de bolacha.",
      "preco": 29.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "PETIT GATEAU",
      "descricao": "Bolinho quente de chocolate com recheio cremoso, com calda de chocolate. Escolha o sabor do sorvete: creme, chocolate, morango, flocos ou banana sobre farofa de bolacha.",
      "preco": 35.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "O PUDIM PERFEITO",
      "descricao": "-",
      "preco": 19.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "MILKSHAKE",
      "descricao": "Creme, morango, chocolate, flocos ou banana.",
      "preco": 29.5
    },
    {
      "categoria": "Sobremesas",
      "nome": "TAÇA DE SORVETE",
      "descricao": "1 bola de sorvete (creme, morango, chocolate, flocos ou banana).",
      "preco": 14.5
    },
    {
      "categoria": "Entradas",
      "nome": "POLENTA FRITA",
      "descricao": "Deliciosa polenta frita com parmesão, crocante por fora e macia por dentro. Acompanha delicioso molho tipo cheddar.",
      "preco": 24.5
    },
    {
      "categoria": "Entradas",
      "nome": "MINI PASTÉIS",
      "descricao": "Carne, queijo ou misto. Acompanha: geleia de pimenta.",
      "preco": 29.5
    },
    {
      "categoria": "Entradas",
      "nome": "FRITAS MÉDIA",
      "descricao": "Acompanha: maionese especial KHARINA.",
      "preco": 24.5
    },
    {
      "categoria": "Entradas",
      "nome": "KIBE FRITO",
      "descricao": "Acompanha: molho especial de limão.",
      "preco": 34.5
    },
    {
      "categoria": "Entradas",
      "nome": "CARPACCIO",
      "descricao": "Tradicional carpaccio temperado com um delicioso molho de alcaparras, além de rúcula e queijo parmesão. Acompanha torradas.",
      "preco": 49.5
    },
    {
      "categoria": "Entradas",
      "nome": "CAMARÃO CRISPY",
      "descricao": "Deliciosa porção crocante de camarões empanados com\nfarinha Panko. Acompanha molho rosé levemente picante.",
      "preco": 62.5
    },
    {
      "categoria": "Entradas",
      "nome": "COSTELINHA BARBECUE",
      "descricao": "Deliciosa costelinha suína marinada no molho barbecue servida com batata rústica e salada caesar.",
      "preco": 86.5
    },
    {
      "categoria": "Entradas",
      "nome": "CHICKEN CRISPY",
      "descricao": "Filés de frango empanados, acompanhados de maionese especial KHARINA.",
      "preco": 39.5
    },
    {
      "categoria": "Entradas",
      "nome": "FRITAS BIG",
      "descricao": "Batata frita gratinada com queijo tipo cheddar, parmesão, prato e bacon.",
      "preco": 48.5
    },
    {
      "categoria": "Entradas",
      "nome": "LINGUICINHA",
      "descricao": "Deliciosa linguiça de Costela Bovina Black Angus. Acompanha: farofa, vinagrete, maionese especial KHARINA e torradas.",
      "preco": 64.5
    },
    {
      "categoria": "Entradas",
      "nome": "NACHOS BIG",
      "descricao": "Porção de nachos com carne moída coberta de molho especial de queijo tipo cheddar, sour cream e guacamole.",
      "preco": 67.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CHOPP BRAHMA - CANECA CONGELADA",
      "descricao": "Delicioso chopp Brahma em caneca congelada a -40º.",
      "preco": 14.9
    },
    {
      "categoria": "Happy Hour",
      "nome": "CHOPP BRAHMA - CALDERETA",
      "descricao": "Delicioso chopp Brahma em copo resfriado.",
      "preco": 12.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CAIPIRINHA VODKA",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 25.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CAIPIRINHA CACHAÇA",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 23.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CAIPIRINHA SAQUÊ",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 26.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "MOSCOW MULE",
      "descricao": "Vodka, suco de limão, gengibre e espuma de gengibre.",
      "preco": 33.9
    },
    {
      "categoria": "Happy Hour",
      "nome": "NEGRONI",
      "descricao": "O Negroni engarrafado da Draco é marcante e envolvente. Uma releitura secreta do coquetel centenário, de origem italiana, leva Gin Draco London Dry, Bitter e Vermouth artesanal.",
      "preco": 33.9
    },
    {
      "categoria": "Happy Hour",
      "nome": "HAWAII SUNSET",
      "descricao": "Vodka, xarope MONIN sabor coco, suco de abacaxi e limão espremido.",
      "preco": 25
    },
    {
      "categoria": "Happy Hour",
      "nome": "GINGERBERRY",
      "descricao": "Vodka, xarope MONIN sabor framboesa, xarope MONIN sabor gengibre, água com gás e limão espremido.",
      "preco": 28.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "VINHO TINTO EM TAÇA",
      "descricao": "-",
      "preco": 19.8
    },
    {
      "categoria": "Happy Hour",
      "nome": "VINHO BRANCO EM TAÇA",
      "descricao": "-",
      "preco": 19.8
    },
    {
      "categoria": "Happy Hour",
      "nome": "COSTELINHA BARBECUE",
      "descricao": "Deliciosa costelinha suína marinada no molho barbecue servida  com batata rústica e salada caesar.",
      "preco": 86.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "LINGUICINHA",
      "descricao": "Linguiça de Costela Bovina Black Angus 350g. Acompanha: farofa, vinagrete, maionese especial KHARINA e torradas.",
      "preco": 76.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "NACHOS BIG",
      "descricao": "Porção de nachos com carne moída coberta com molho especial de queijo tipo cheddar, sour cream e guacamole.",
      "preco": 67.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CHICKEN CRISPY",
      "descricao": "Filés de frango empanados acompanhados de maionese especial KHARINA.",
      "preco": 39.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "KIBE FRITO",
      "descricao": "Acompanha delicioso molho especial de limão.",
      "preco": 34.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "MINI PASTÉIS",
      "descricao": "Carne, queijo ou misto. Acompanha deliciosa geleia de pimenta.",
      "preco": 29.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "FRITAS BIG",
      "descricao": "Batata frita gratinada com queijo tipo cheddar, parmesão, prato e bacon.",
      "preco": 48.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CARPACCIO",
      "descricao": "Tradicional carpaccio temperado com molho de alcaparras, além de rúcula e queijo parmesão. Acompanha torradas.",
      "preco": 49.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "HANDYMAN",
      "descricao": "Pão crocante, 2 hambúrgeres black angus, queijo tipo cheddar derretido, cebola crispy, bacon e maionese especial KHARINA.",
      "preco": 56.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "ROCK BURGER",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, bacon, cebola caramelizada e molho barbecue.",
      "preco": 49.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLASSIC BURGER",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, mix de folhas verdes, tomate e maionese especial KHARINA.",
      "preco": 48.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLASSIC BURGER BACON",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, bacon, mix de folhas verdes, tomate e maionese especial KHARINA.",
      "preco": 51.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLUB KHARINA",
      "descricao": "Suculento filé mignon intercalado com cebola assada até a perfeição, tomate fresco e bacon grelhado. Acompanha arroz, farofa, vinagrete e banana à milanesa.",
      "preco": 59.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLUB CHICKEN",
      "descricao": "Delicioso gnocchi caseiro servido com ragu de costela bovina desfiada e manjericão com lascas de queijo parmesão.",
      "preco": 56.5
    },
    {
      "categoria": "Happy Hour",
      "nome": "CLUB ROCK",
      "descricao": "Delicioso bife de steak black angus KHARINA com molho de mostarda ou de gorgonzola, acompanhado de arroz, feijão e batatas fritas.",
      "preco": 61.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CHOPP BRAHMA - CANECA CONGELADA",
      "descricao": "Delicioso chopp Brahma em caneca congelada a -40º.",
      "preco": 14.9
    },
    {
      "categoria": "Bebidas",
      "nome": "CHOPP BRAHMA - CALDERETA",
      "descricao": "Delicioso chopp Brahma em copo resfriado.",
      "preco": 12.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CAIPIRINHA VODKA",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 25.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CAIPIRINHA CACHAÇA",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 23.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CAIPIRINHA SAQUÊ",
      "descricao": "As caipirinhas são preparadas com frutas frescas da estação. Verifique com nossos atendentes as opções do dia.",
      "preco": 26.5
    },
    {
      "categoria": "Bebidas",
      "nome": "MOSCOW MULE",
      "descricao": "Vodka, suco de limão, gengibre e espuma de gengibre.",
      "preco": 33.9
    },
    {
      "categoria": "Bebidas",
      "nome": "NEGRONI",
      "descricao": "O Negroni engarrafado da Draco é marcante e envolvente. Uma releitura secreta do coquetel centenário, de origem italiana, leva Gin Draco London Dry, Bitter e Vermouth artesanal.",
      "preco": 33.9
    },
    {
      "categoria": "Bebidas",
      "nome": "HAWAII SUNSET",
      "descricao": "Vodka, xarope MONIN sabor coco, suco de abacaxi e limão espremido.",
      "preco": 25
    },
    {
      "categoria": "Bebidas",
      "nome": "GINGERBERRY",
      "descricao": "Vodka, xarope MONIN sabor framboesa, xarope MONIN sabor gengibre, água com gás e limão espremido.",
      "preco": 28.5
    },
    {
      "categoria": "Bebidas",
      "nome": "VINHO TINTO EM TAÇA",
      "descricao": "-",
      "preco": 19.8
    },
    {
      "categoria": "Bebidas",
      "nome": "VINHO BRANCO EM TAÇA",
      "descricao": "-",
      "preco": 19.8
    },
    {
      "categoria": "Bebidas",
      "nome": "SPATEN LONK NECK",
      "descricao": "Autêntica cerveja puro malte alemã, de sabor encorpado e amargor equilibrado.",
      "preco": 15.9
    },
    {
      "categoria": "Bebidas",
      "nome": "GIN TROPICAL",
      "descricao": "Gin com xarope de manga picante, lichia e suco de limão, finalizado com água tônica, hortelã e uma rodela de limão. Refrescante e equilibrado entre o cítrico e o adocicado.",
      "preco": 25
    },
    {
      "categoria": "Bebidas",
      "nome": "NEGRONI NAPOLEÃO",
      "descricao": "O Negroni de Napoleão é uma receita perfeita que combina xarope MONIN de pêssego, suco de limão e hortelã, resultando em um drink suave, irresistível e digno do imperador.",
      "preco": 33.9
    },
    {
      "categoria": "Bebidas",
      "nome": "ÁGUA MINERAL COM OU SEM GÁS",
      "descricao": "-",
      "preco": 7.5
    },
    {
      "categoria": "Bebidas",
      "nome": "SUCO JARRA",
      "descricao": "Laranja ou limonada suíça.",
      "preco": 23.5
    },
    {
      "categoria": "Bebidas",
      "nome": "REFRIGERANTE 350ML",
      "descricao": "Coca-Cola, Coca-Cola Zero , Fanta Guaraná, Fanta Guaraná Zero, Fanta Laranja, Sprite e Tônica.",
      "preco": 9
    },
    {
      "categoria": "Bebidas",
      "nome": "SODA ITALIANA",
      "descricao": "Cranberry, limão, pêssego ou maçã verde.",
      "preco": 13.5
    },
    {
      "categoria": "Bebidas",
      "nome": "SUCO COPO",
      "descricao": "Laranja, abacaxi, abacaxi e hortelã, morango, maracujá, limonada suíça e uva.",
      "preco": 12.5
    },
    {
      "categoria": "Bebidas",
      "nome": "CHÁ GELADO",
      "descricao": "Cranberry, limão, pêssego ou maçã verde.",
      "preco": 11.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "CLASSIC BURGER",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, mix de folhas verdes, tomate e maionese especial KHARINA.",
      "preco": 48.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "CLASSIC BURGER BACON",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, bacon, mix de folhas verdes, tomate e maionese especial KHARINA.",
      "preco": 51.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "CHORIPAN KHARINA",
      "descricao": "Pão crocante, linguiça de costela bovina black angus, queijo prato, maionese especial KHARINA e vinagrete.",
      "preco": 47.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "HANDYMAN",
      "descricao": "Pão crocante, 2 hambúrgeres black angus, queijo tipo cheddar derretido, cebola crispy, bacon e maionese especial KHARINA.",
      "preco": 56.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "ROCK BURGER",
      "descricao": "Pão crocante, 1 hambúrger black angus, queijo tipo cheddar derretido, bacon, cebola caramelizada e molho barbecue.",
      "preco": 49.5
    },
    {
      "categoria": "Burger Prime",
      "nome": "HAMBÚGUER VEGETARIANO",
      "descricao": "Pão crocante, hambúrger produzido com a proteína da ervilha, soja e grão de bico, queijo tipo cheddar derretido, mix de folhas verdes, tomate e maionese vegana especial KHARINA.",
      "preco": 49.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE BURGER",
      "descricao": "Pão brioche, hambúrger black angus, queijo prato e maionese especial KHARINA.",
      "preco": 37.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE SALADA",
      "descricao": "Pão brioche, hambúrger black angus, alface crespa, tomate, queijo prato, cebola e maionese especial KHARINA.",
      "preco": 41.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE FRANGO",
      "descricao": "Pão brioche, delicioso frango grelhado, alface crespa, tomate, queijo prato e maionese especial KHARINA.",
      "preco": 38.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE FRANGO CRISPY",
      "descricao": "Pão brioche, delicioso filé de frango empanado com farinha Panko, alface crespa, tomate, queijo prato e maionese de limão com ervas finas.",
      "preco": 44.5
    },
    {
      "categoria": "Burger Tradicional",
      "nome": "CHEESE MIGNON",
      "descricao": "Pão brioche, delicioso grelhado de mignon, alface crespa, tomate, queijo prato, cebola e maionese especial KHARINA.",
      "preco": 58.5
    },
    {
      "categoria": "Clássicos",
      "nome": "CLUB KHARINA",
      "descricao": "Suculento filé mignon intercalado com cebola assada até a perfeição, tomate fresco e bacon grelhado. Acompanha arroz, farofa, vinagrete e banana à milanesa.",
      "preco": 59.5
    },
    {
      "categoria": "Clássicos",
      "nome": "CLUB ROCK",
      "descricao": "Delicioso bife de steak black angus KHARINA com molho de mostarda ou de gorgonzola, acompanhado de arroz, feijão e batatas fritas.",
      "preco": 61.5
    },
    {
      "categoria": "Clássicos",
      "nome": "CLUB MIGNON",
      "descricao": "Suculento strogonoff de mignon, acompanhado de arroz branco e a inseparável porção de batatas fritas.",
      "preco": 68.5
    },
    {
      "categoria": "Clássicos",
      "nome": "CLUB CHICKEN",
      "descricao": "Delicioso gnocchi caseiro servido com ragu de costela bovina desfiada e manjericão com lascas de queijo parmesão.",
      "preco": 56.5
    },
    {
      "categoria": "Executivos",
      "nome": "STEAK BLACK ANGUS KHARINA",
      "descricao": "Delicioso bife de steak black angus KHARINA com molho de mostarda ou de gorgonzola, acompanhado de arroz, feijão e batatas fritas.",
      "preco": 51.5
    },
    {
      "categoria": "Executivos",
      "nome": "GNOCCHI DOS DEUSES",
      "descricao": "Delicioso gnocchi caseiro servido com ragu de costela bovina desfiada e manjericão com lascas de queijo parmesão.",
      "preco": 51.5
    },
    {
      "categoria": "Executivos",
      "nome": "FILET À PARMEGIANA",
      "descricao": "Tradicional receita de filé black angus empanado, coberto com queijo prato, parmesão e um especial molho de tomate e por fim, gratinado. Acompanha arroz.",
      "preco": 59.5
    }
  ]
};

async function main() {
  console.log('Cleaning existing menu items...');
  await prisma.menuItem.deleteMany();

  for (const store of STORES) {
    const items = MENU_DATA[store.name];
    if (!items) {
      console.warn(`No items found for store ${store.name}`);
      continue;
    }

    console.log(`Seeding data for ${store.name} (${items.length} items)...`);

    // Batch create for better performance
    await prisma.menuItem.createMany({
      data: items.map(item => ({
        storeId: store.id,
        nome: item.nome,
        categoria: item.categoria,
        descricao: item.descricao,
        preco: item.preco,
        moeda: 'BRL',
        disponivel: true,
      }))
    });
  }

  console.log('Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
