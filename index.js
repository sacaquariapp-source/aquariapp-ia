require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const {
  listar: listarOfertas,
  criar: criarOferta,
  atualizar: atualizarOferta,
  remover: removerOferta,
} = require('./ofertasStore');

const catalogosStore = require('./catalogosStore');
const whatsappStore = require('./whatsappStore');
const whatsappApi = require('./whatsappApi');
const concursosStore = require('./concursosStore');
const telemetriaStore = require('./telemetriaStore');
const testerStore = require('./testerStore');
const trialStore = require('./trialStore');

const ADMIN_KEY = process.env.ADMIN_KEY || (process.env.NODE_ENV === 'production' ? '' : 'admin123');
if (!ADMIN_KEY) {
  console.error('[FATAL] Defina a variável ADMIN_KEY no .env (obrigatória em produção).');
  process.exit(1);
}

const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_KEY;
const COOKIE_ADMIN = 'aquariapp_admin';
const DURACAO_SESSAO_MS = 30 * 24 * 60 * 60 * 1000;

function assinarAdmin() {
  const expira = Date.now() + DURACAO_SESSAO_MS;
  const payload = `ok.${expira}`;
  const assinatura = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${assinatura}`;
}

function cookieAdminValido(req) {
  try {
    const cabecalho = req.headers.cookie || '';
    for (const parte of cabecalho.split(';')) {
      const idx = parte.trim().indexOf('=');
      if (idx === -1) continue;
      const nome = parte.trim().slice(0, idx).trim();
      if (nome !== COOKIE_ADMIN) continue;
      const token = decodeURIComponent(parte.trim().slice(idx + 1).trim());
      const [valor, expira, assinatura] = token.split('.');
      if (valor !== 'ok') return false;
      const esperado = crypto
        .createHmac('sha256', SESSION_SECRET)
        .update(`ok.${expira}`)
        .digest('hex');
      const a = Buffer.from(esperado);
      const b = Buffer.from(assinatura || '');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
      return Number(expira) > Date.now();
    }
  } catch (e) {
    return false;
  }
  return false;
}

function autenticado(req) {
  const chave = req.get('X-Admin-Key');
  if (chave && chave === ADMIN_KEY) return true;
  return cookieAdminValido(req);
}

const { enriquecerWikipedia } = require('./wikipedia.js');
const { GUIA_REFERENCIA } = require('./guiaReferencia.js');
const {
  enriquecerComFontes,
  comTimeoutEnriquecimento,
  buscarAquarismoPaulista,
  buscarFishipedia,
  buscarChacaraTakeyoshi,
} = require('./fontes.js');

const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
}

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'https:', 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
  })
);

const ORIGENS_EXPLICITAS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function origemPermitida(origin) {
  if (!origin) return true;
  if (ORIGENS_EXPLICITAS.length > 0) {
    return ORIGENS_EXPLICITAS.includes(origin);
  }
  try {
    const host = new URL(origin).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

app.use(
  cors({
    origin(origin, cb) {
      if (origemPermitida(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);

const limiterGeral = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
app.use(limiterGeral);

const limiterIA = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const limiterAdmin = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

app.use(express.json({ limit: '15mb' }));

// --- Upload de imagens para URL pública (usado pelo Google Lens) ---
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '1d' }));

function urlBasePublica(req) {
  return (
    String(process.env.PUBLIC_BASE_URL || '').trim() ||
    `${req.protocol}://${req.get('host')}`
  );
}

function extensaoPorMime(prefixo) {
  if (/png/.test(prefixo)) return 'png';
  if (/gif/.test(prefixo)) return 'gif';
  if (/webp/.test(prefixo)) return 'webp';
  return 'jpg';
}

// Recebe uma imagem (data URL base64) e devolve uma URL pública temporária,
// usada para abrir o Google Lens com a foto. O arquivo fica em public/uploads.
app.post('/upload-imagem', (req, res) => {
  const { imagem } = req.body || {};
  if (!imagem || typeof imagem !== 'string') {
    return res.status(400).json({ erro: 'Envie o campo "imagem" (data URL base64).' });
  }
  const base64 = imagem.includes('base64,') ? imagem.split('base64,')[1] : imagem;
  if (!base64 || base64.length < 100) {
    return res.status(400).json({ erro: 'Imagem inválida ou vazia.' });
  }
  const prefixo = imagem.match(/^data:([^;]+);base64,/)
    ? imagem.match(/^data:([^;]+);base64,/)[1]
    : 'image/jpeg';
  const extensao = extensaoPorMime(prefixo);
  const nome = `lens-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${extensao}`;
  try {
    fs.writeFileSync(path.join(UPLOADS_DIR, nome), Buffer.from(base64, 'base64'));
  } catch (e) {
    console.error('Falha ao salvar imagem para Lens:', e.message);
    return res.status(500).json({ erro: 'Não foi possível salvar a imagem para o Google Lens.' });
  }
  const url = `${urlBasePublica(req).replace(/\/$/, '')}/uploads/${nome}`;
  return res.json({ url });
});

const rotasIA = [
  '/identify',
  '/buscar-nome',
  '/buscar-produto',
  '/validar-foto',
  '/diagnostico',
  '/diagnostico-alga',
  '/diagnostico-micro',
  '/compatibilidade',
  '/sugestoes',
  '/sugestao-aquario',
  '/avaliacao-aquario',
  '/cronograma-alimentar',
  '/alimentos-recomendados',
  '/sugestoes-ajuste',
  '/pergunta',
];
rotasIA.forEach((rota) => app.use(rota, limiterIA));

const rotasAdmin = ['/ofertas', '/catalogos'];
rotasAdmin.forEach((rota) =>
  app.use(rota, (req, res, next) => {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
      return limiterAdmin(req, res, next);
    }
    return next();
  })
);

function normalizarResultado(dados) {
  return {
    provedor: dados.provedor || 'IA',
    confianca: dados.confianca || null,
    tipo: dados.tipo === 'flora' ? 'flora' : 'fauna',
    nomeComum: dados.nomeComum || 'Espécie não catalogada',
    nomeCientifico: dados.nomeCientifico || 'Não identificado',
    familia: dados.familia || '—',
    origem: dados.origem || '—',
    tamanho: dados.tamanho || '—',
    temperatura: dados.temperatura || '—',
    ph: dados.ph || '—',
    dureza: dados.dureza || '—',
    dieta: dados.dieta || '—',
    comportamento: dados.comportamento || '—',
    aquarioMinimo: dados.aquarioMinimo || '—',
    dificuldade: dados.dificuldade || '—',
    iluminacao: dados.iluminacao || '—',
    co2: dados.co2 || '—',
    crescimento: dados.crescimento || '—',
    tipoPlanta: dados.tipoPlanta || '—',
    observacoes: dados.observacoes || '',
    foto: dados.foto || '',
  };
}

const AI_TIMEOUT_MS = 25000;

const PROMPT_VALIDACAO =
  'Você é o verificador de fotos de um aplicativo de aquarismo de água doce. Analise a imagem e responda ' +
  'APENAS com JSON válido no formato {"valida": true} ou {"valida": false, "motivo": "explicação curta em português"}. ' +
  'A foto é VÁLIDA se houver QUALQUER indício de animal ou planta de água doce — peixes, invertebrados ' +
  '(camarões, caramujos, caranguejos, lagostins, hidras, planárias, copépodes), anfíbios aquáticos (axolotes, rãs), ' +
  'insetos e larvas aquáticas (besouros mergulhadores, "tigre d\'água", baratas-d\'água, ninfas), tartarugas de água doce, ' +
  'plantas aquáticas, substrato, decoração, vidro ou um aquário inteiro de água doce. ' +
  'A foto é INVÁLIDA APENAS se NÃO houver nenhum indício de vida aquática de água doce, por exemplo: pessoas, gatos, ' +
  'cachorros, pássaros, animais ou insetos TERRESTRES, plantas terrestres, comidas, paisagens de terra, ' +
  'mar ou água salgada. ' +
  'Em caso de dúvida razoável entre vida aquática de água doce ou outra coisa, prefira valida true para não bloquear uma foto válida.';

const PROMPT_VALIDACAO_AQUARIO =
  'Você é o verificador de fotos de um aplicativo de aquarismo de água doce. Analise a imagem e responda ' +
  'APENAS com JSON válido no formato {"valida": true} ou {"valida": false, "motivo": "explicação curta em português"}. ' +
  'A foto é VÁLIDA se mostrar uma CENA de aquário de água doce, por exemplo: peixes ou outros animais de água doce ' +
  '(invertebrados, anfíbios, insetos/larvas aquáticas), plantas aquáticas, algas crescendo no vidro/substrato/plantas, ' +
  'substrato e decoração de aquário, microorganismos sobre o vidro, ou o aquário inteiro. ' +
  'A foto é INVÁLIDA se não mostrar uma cena de aquário de água doce, por exemplo: pessoas, pets, pássaros, ' +
  'animais ou insetos TERRESTRES, plantas terrestres, comidas, paisagens de terra, mar ou água salgada. ' +
  'Se tiver dúvida, responda valida false.';

const PROMPT_VALIDACAO_CONCURSO =
  'Você é o verificador de fotos de um CONCURSO de aquários de água doce. Analise a imagem e responda ' +
  'APENAS com JSON válido no formato {"valida": true} ou {"valida": false, "motivo": "explicação curta em português"}. ' +
  'A foto é VÁLIDA somente se mostrar o AQUÁRIO INTEIRO em cena — o tanque completo com água, vidro e ambiente ' +
  '(decoração, substrato, plantas e/ou peixes). ' +
  'A foto é INVÁLIDA se: (1) mostrar apenas um peixe ou animal de perto sem o aquário; (2) não houver cena de aquário ' +
  'de água doce; (3) mostrar pessoas, pets, insetos terrestres, plantas terrestres, comidas, mar ou água salgada; ' +
  '(4) a imagem for borrada, escura demais ou recortada sem contexto do aquário. ' +
  'Se tiver dúvida, responda valida false.';

const PROMPT_COMPATIBILIDADE =
  'Você é um especialista em aquarismo de água doce. Avalie se um novo peixe pode ser introduzido com segurança em um aquário. ' +
  'Cruzando: (1) a compatibilidade do novo peixe com CADA peixe já existente no aquário (agressividade, territorialidade, ' +
  'comportamento predatório, diferença de tamanho, hábitos de nadar na mesma região), e (2) a compatibilidade com os parâmetros ' +
  'da água, principalmente pH e temperatura (compare a faixa preferida do novo peixe com as dos peixes existentes e com o pH ' +
  'desejado do aquário). Responda APENAS com JSON válido: {"compativel": true} se for seguro, ou ' +
  '{"compativel": false, "motivo": "explicação breve em português com poucas palavras"} se houver risco. ' +
  'Se não tiver certeza, responda compativel false com o motivo da dúvida.';

const PROMPT_SUGESTOES =
  'Você é um especialista em aquarismo de água doce. O usuário quer sugestões de espécies de peixes (apenas fauna, nada de plantas) ' +
  'que possam ser ADICIONADAS com segurança a um aquário já montado. Considere SEMPRE, nesta ordem de prioridade: ' +
  '1º RISCO ENTRE ESPÉCIES: o novo peixe não pode ter risco de predação, agressão ou territorialidade com NENHUM peixe existente ' +
  '(avaliar comportamento, dieta, diferença de tamanho adulto e hábitos). ' +
  '2º AMBIENTE: o novo peixe deve ser compatível com o tipo do aquário, pH, temperatura e espaço (lotação) informados. ' +
  '3º Espécies que já existem no aquário NÃO devem ser repetidas. ' +
  'Responda APENAS com JSON válido no formato: {"sugestoes":[{"nomeComum":"nome popular","nomeCientifico":"nome científico","motivo":"motivo curto e específico"}]}. ' +
  'Máximo de 5 sugestões. Se a lotação estiver no limite ou não houver boas opções, retorne menos sugestões (ou lista vazia). ' +
  'Não invente espécies inexistentes e use nomes científicos corretos.';

const PROMPT_SUGESTAO_AQUARIO =
  'Você é um especialista em aquarismo de água doce. O usuário está planejando um aquário NOVO e informou: ' +
  '(1) o volume pretendido em litros, (2) o tipo de aquário (Comunitário, Jumbo, Espécie Única ou Hospital) e ' +
  '(3) opcionalmente o tipo de fauna/biótopo desejado (amazônica, água negra, americana, asiática, africana, ' +
  'australiana ou sem preferência) — siga as características do biótopo quando informado. ' +
  'Com base nessas informações, monte uma sugestão completa e equilibrada. Regras OBRIGATÓRIAS: ' +
  '(1) FAUNA: sugira espécies compatíveis entre si (sem predação, sem territorialidade severa, hábitos e dieta compatíveis) ' +
  'e em QUANTIDADE adequada ao volume (regra prática de até ~1 cm de peixe por litro para comunitário; menos para ' +
  'espécies grandes, territoriais ou de água fria). ' +
  'Para "Jumbo" priorize peixes de grande porte e VERIFIQUE se o volume é suficiente (um "Jumbo" exige no mínimo ' +
  '~200-300 L; se o volume informado for menor, avise no campo "agua.nota" que o volume é pequeno para Jumbo e sugira ' +
  'espécies compatíveis com o tamanho real). ' +
  'Para "Espécie Única" sugira APENAS espécies de UM mesmo grupo/padrão (ex.: só ciclídeos, ou só americanos, ou só ' +
  'barbos, ou só bettas, ou só guppies) — pode ser várias espécies do MESMO tipo (ex.: vários ciclídeos africanos), mas ' +
  'nada de misturar grupos diferentes. ' +
  'Para "Hospital" sugira pouca fauna resistente e de fácil manutenção (ex.: neon, rasbora) pensada para peixes que ' +
  'estarão em tratamento/cuidados: aquário simples, sem substrato vivo, fácil de limpar e de observar; pode haver ' +
  'medicamentos básicos na lista de equipamentos. ' +
  '(2) FLORA: sugira plantas aquáticas compatíveis com o tipo e o tamanho do aquário (até 6 espécies), considerando ' +
  'luz e se faz sentido para o tipo (para Hospital, sugira poucas ou nenhuma; para Jumbo priorize plantas de porte ' +
  'maior; para biótopo africano, quase nenhuma). ' +
  '(3) ÁGUA: sugira a faixa de pH ideal para o conjunto (ex.: 6,5 - 7,2) e a temperatura, coerentes com o biótopo/tipo. ' +
  '(4) EQUIPAMENTOS: sugira equipamentos essenciais para o volume e o tipo (filtro e vazão L/h, aquecedor em watts ' +
  'quando fizer sentido, iluminação, bomba/oxigenação, substrato e, se for plantado, CO2 quando necessário). ' +
  'Responda APENAS com JSON válido no formato: ' +
  '{"fauna":[{"nomeComum":"nome popular","nomeCientifico":"nome científico","quantidade":1,"motivo":"por que e em que quantidade"}],' +
  '"flora":[{"nome":"nome da planta","motivo":"por que"}],' +
  '"agua":{"ph":"ex: 6,5 - 7,2","temperatura":"ex: 24 - 28 °C","nota":"explicação curta"},' +
  '"equipamentos":[{"item":"filtro canister","especificacao":"vazão de ~600 L/h","motivo":"explicação curta"}]}. ' +
  'Não invente espécies inexistentes. As quantidades devem ser realistas para o volume informado.';

const PROMPT_AVALIACAO =
  'Você é um consultor experiente de aquarismo de água doce. Analise TODAS as informações do aquário do usuário ' +
  'fornecidas abaixo e responda APENAS com JSON válido no formato: ' +
  '{"resumo":"resumo geral de 2 a 4 frases sobre o estado atual do aquário",' +
  '"pontosFortes":["o que está bem feito","..."],' +
  '"sugestoes":[{"titulo":"dica curta","detalhe":"explicação prática de como melhorar"}],' +
  '"urgencias":[{"titulo":"atenção","detalhe":"o que precisa de ação rápida"]}]}. ' +
  'Regras: ' +
  '(1) resumo deve ser honesto e em português claro. ' +
  '(2) pontosFortes: destaque o que está correto (fauna compatível, lotação adequada, plantado com CO2, etc.). ' +
  '(3) sugestoes: até 6 dicas práticas de melhoria considerando fauna, flora, equipamentos, iluminação, ' +
  'parâmetros, lotação e rotina de manutenção (TPA ~20% a cada 2 semanas). ' +
  '(4) urgencias: liste riscos que exigem ação rápida — lotação acima do ideal (regra de 1 L por cm de peixe), ' +
  'amônia/nitrito altos, pH/temperatura fora da faixa das espécies, incompatibilidade entre espécies, ' +
  'filtragem insuficiente, uso de produto tóxico para a fauna. Se não houver urgência, retorne lista vazia. ' +
  '(5) Use regras de compatibilidade e os parâmetros ideais das espécies. Não invente problemas que os dados não suportam.';

const PROMPT_PERGUNTA =
  'Você é um consultor de aquarismo de água doce. O usuário fará uma pergunta curta e objetiva. ' +
  'Classifique se a pergunta TEM RELAÇÃO com aquarismo de água doce (peixes, plantas aquáticas, parâmetros da água ' +
  'como pH/amônia/nitrito, algas, doenças, equipamentos e filtragem, manutenção e TPA, alimentação, CO2, iluminação, ' +
  'montagem, lotação, compatibilidade, ciclo do aquário, quarentena, etc.). ' +
  'Responda APENAS com JSON válido: ' +
  'Se NÃO tiver relação, responda {"apropriada": false}. ' +
  'Se tiver relação, responda {"apropriada": true, "resposta": "resposta curta, direta e objetiva em português"}. ' +
  'Regras: ' +
  '(1) Seja conservador ao julgar: qualquer pergunta minimamente ligada a aquário, peixes ou plantas de água doce é apropriada. ' +
  '(2) Não invente informações; se não souber, diga isso de forma breve. ' +
  '(3) A resposta deve ter no máximo 2 a 3 frases curtas (~180 caracteres).';


const PROMPT_SISTEMA =
  'Você é um especialista em aquarismo. Identifique o animal ou planta aquática da foto e responda APENAS com JSON válido no seguinte formato: ' +
  '{"tipo":"fauna ou flora","confianca":0 a 100,"nomeComum":"nome popular em português","nomeCientifico":"nome científico","familia":"família",' +
  '"origem":"origem geográfica","tamanho":"ex: até 5 cm","temperatura":"ex: 23 - 27 °C","ph":"ex: 5,5 - 6,5","dureza":"ex: 5 - 12 °dH",' +
  '"dieta":"tipo de alimentação","comportamento":"comportamento","aquarioMinimo":"ex: 40 L","dificuldade":"fácil/médio/avançado",' +
  '"iluminacao":"baixa/média/alta","co2":"opcional/recomendado/necessário","crescimento":"lento/médio/rápido","tipoPlanta":"tipo de planta (se flora)",' +
  '"observacoes":"curiosidades e dicas de manutenção"}. ' +
  'COBERTURA: além de peixes e plantas, identifique TAMBÉM animais de água doce como invertebrados (camarões, caramujos, ' +
  'caranguejos, lagostins, hidras, planárias, copépodes), anfíbios (axolotes, rãs), insetos e larvas aquáticas — por exemplo ' +
  '"tigre d\'água" (larva de besouro mergulhador / Dytiscidae), baratas-d\'água, ninfas — e tartarugas de água doce. ' +
  'REGRAS DE PRECISÃO: (1) Cuidado com espécies visualmente parecidas — analise detalhes como forma do corpo e da cabeça, ' +
  'nadadeiras, padrão e cor, região da cauda, e prefira sempre o nome popular e científico CORRETOS. Exemplos: ' +
  '"Ramirezi" (Mikrogeophagus ramirezi, corpo compacto e colorido com pintas azuis brilhantes e aleta dorsal com raios altos) é DIFERENTE de ' +
  '"Apistogramma" (ex.: Apistogramma cacatuoides, mais alongado e com padrão de listras); Neon (Paracheirodon innesi) tem faixa vermelha só na metade, ' +
  'Cardinal (Paracheirodon axelrodi) tem faixa vermelha no corpo inteiro. ' +
  '(2) Se for claramente um animal ou planta aquática mas você não tiver certeza da espécie exata, retorne a espécie MAIS PROVÁVEL ' +
  'com confianca baixa (ex.: 40-55) em vez de "desconhecido". ' +
  '(3) Somente retorne tipo "invalido" se a foto não for um animal/planta aquática (aquário, lago, rio, mar), com um campo "motivo" curto. ' +
  'Retorne tipo "desconhecido" apenas se a foto for aquática mas sem nenhum ser identificável.';

const PROMPT_BUSCA_NOME =
  'Você é um especialista em aquarismo de água doce. O usuário digitou o nome de uma espécie de peixe ou planta aquática e ' +
  'quer a ficha técnica. Responda APENAS com JSON válido no seguinte formato: ' +
  '{"tipo":"fauna ou flora","confianca":null,"nomeComum":"nome popular em português","nomeCientifico":"nome científico","familia":"família",' +
  '"origem":"origem geográfica","tamanho":"ex: até 5 cm","temperatura":"ex: 23 - 27 °C","ph":"ex: 5,5 - 6,5","dureza":"ex: 5 - 12 °dH",' +
  '"dieta":"tipo de alimentação","comportamento":"comportamento","aquarioMinimo":"ex: 40 L","dificuldade":"fácil/médio/avançado",' +
  '"iluminacao":"baixa/média/alta","co2":"opcional/recomendado/necessário","crescimento":"lento/médio/rápido","tipoPlanta":"tipo de planta (se flora)",' +
  '"observacoes":"curiosidades e dicas de manutenção"}. Se o nome não corresponder a uma espécie aquática conhecida de água doce, ' +
  'responda apenas {"tipo":"desconhecido","motivo":"explicação curta"}. Não invente espécies: se não tiver certeza, retorne desconhecido.';

const PROMPT_BUSCA_PRODUTO =
  'Você é um especialista em rações e alimentos para peixes ornamentais e aquários de água doce. ' +
  'O usuário digitou o nome de um PRODUTO ALIMENTAR (ração, floco, grânulo, pellet, tablete, alimento liofilizado, etc.) ' +
  'e quer a ficha técnica do produto. Responda APENAS com JSON válido no seguinte formato: ' +
  '{"encontrado":true,"marca":"marca do produto","nome":"nome comercial","tipo":"formato (flocos, grânulos, pellets, etc.)",' +
  '"indicacao":"para quais peixes/espécies o produto é indicado",' +
  '"principios":"princípios ativos e ingredientes principais (ex: proteínas de origem animal/vegetal, espirulina, alho, astaxantina)",' +
  '"uso":"como e com que frequência oferecer (dose diária, duração em minutos, etc.)",' +
  '"observacoes":"dicas e observações relevantes"}. ' +
  'Se o termo não corresponder a um produto alimentar conhecido para peixes ornamentais, ' +
  'responda apenas {"encontrado":false,"motivo":"explicação curta"}. ' +
  'Não invente produtos: se não tiver certeza, retorne encontrado:false.';

class FotoInvalidaError extends Error {
  constructor(motivo) {
    super(motivo || 'A foto não parece ser de um animal ou planta aquática.');
    this.name = 'FotoInvalidaError';
    this.motivo = this.message;
  }
}

function semChaves() {
  const presentes = [];
  if (process.env.OPENAI_API_KEY) presentes.push('OpenAI');
  if (process.env.GEMINI_API_KEY) presentes.push('Gemini');
  if (process.env.PLANTNET_API_KEY) presentes.push('PlantNet');
  return presentes;
}

function semChavesValidacao() {
  const presentes = [];
  if (process.env.OPENAI_API_KEY) presentes.push('OpenAI');
  if (process.env.GEMINI_API_KEY) presentes.push('Gemini');
  return presentes;
}

// Palavras que indicam que uma página da Wikipedia é do ambiente de aquarismo.
// Usadas para priorizar a imagem de referência (evita personagens/filmes etc.).
const PALAVRAS_AQUARISMO = [
  'peixe', 'peixes', 'fish', 'fishes', 'aquário', 'aquario', 'aquarium', 'aquarismo',
  'ictio', 'doença', 'doenca', 'doenças', 'doencas', 'disease', 'parasita', 'fungo',
  'nadadeira', 'barbatana', 'branquia', 'infecção', 'infeccao', 'bactéria', 'bacteria',
  'ovelha', 'ciclídeo', 'ciclídeo', 'ciclideos', 'cichlid', 'tanque', 'laguna',
  'águas', 'aguas', 'espécie', 'especie', 'sintoma', 'sintomas', 'symptom',
];

function pontuarPaginaAquarismo(pagina, termo) {
  const alvo = String(
    [pagina.title, pagina.extract, pagina.description].filter(Boolean).join(' ')
  )
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const t = String(termo || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  let score = 0;
  // Match do termo no título vale muito.
  if (pagina.title && String(pagina.title).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(t)) score += 10;
  for (const p of PALAVRAS_AQUARISMO) {
    if (alvo.includes(p)) score += 2;
  }
  // Penaliza personagens/filmes/jogos (Popeye, e.g.).
  const personagem = /(popeye|personagem|filme|desenho|animado|série|serie|cartoon|game|jogo|marinheiro|matroska)/i.test(alvo);
  if (personagem) score -= 8;
  return score;
}

async function buscarImagemWikipedia(nome) {
  const termoBase = String(nome || '').trim();
  if (termoBase.length < 2) return '';
  // Tenta o termo original e, se nada aquarista for achado, variantes com contexto.
  const termos = [
    termoBase,
    `${termoBase} peixe`,
    `${termoBase} peixes aquário`,
    `${termoBase} aquário`,
    `${termoBase} doença peixes`,
  ];
  for (const termo of termos) {
    const achou = await buscarImagemWikipediaPorTermo(termo);
    if (achou) return achou;
  }
  return '';
}

async function buscarImagemWikipediaPorTermo(termo) {
  for (const idioma of ['pt', 'en']) {
    try {
      const url =
        `https://${idioma}.wikipedia.org/w/api.php?action=query&generator=search` +
        `&gsrsearch=${encodeURIComponent(termo)}&gsrlimit=10&prop=pageimages|extracts` +
        `&exintro&explaintext&piprop=name|original&format=json&origin=*`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const json = await res.json();
      const pages = (json.query && json.query.pages) || {};
      const lista = Object.values(pages);
      if (lista.length === 0) continue;

      // Escolhe a página mais relevante para o aquarismo.
      const ordenadas = lista
        .map((p) => ({ p, score: pontuarPaginaAquarismo(p, termo) }))
        .sort((a, b) => b.score - a.score);

      // Pega a primeira página com foto real (raster), evitando mapas/vetores.
      for (const { p } of ordenadas) {
        if (p.score <= 0) continue;
        if (p.pageimage && imagemReferenciaAceitavel('', p.pageimage)) {
          const enc = encodeURIComponent(String(p.pageimage).replace(/ /g, '_'));
          return `https://${idioma}.wikipedia.org/wiki/Special:FilePath/${enc}?width=480`;
        }
        if (p.original && p.original.source && imagemReferenciaAceitavel(p.original.source, '')) {
          return p.original.source;
        }
      }
    } catch (e) {
      console.warn(`[buscarImagemWikipedia ${idioma}]`, e.message);
    }
  }
  return '';
}

// Só aceita fotos reais: evita vetores (SVG) e imagens de mapa de distribuição.
function imagemReferenciaAceitavel(url, nomeArquivo) {
  const s = (String(url || '') + ' ' + String(nomeArquivo || '')).toLowerCase();
  if (/\.svg(?:$|[?#])/.test(s)) return false;
  if (/mapa?[-_.]?\.(?:jpe?g|png|gif|webp)(?:$|[?#])/.test(s)) return false;
  if (/\.(?:jpe?g|png|gif|webp)(?:$|[?#])/.test(s)) return true;
  return true;
}

async function comFoto(r) {
  const enriquecido = await comTimeoutEnriquecimento(r);
  if (!enriquecido.foto) {
    enriquecido.foto = await buscarImagemWikipedia(enriquecido.nomeCientifico || enriquecido.nomeComum || '');
  }
  return enriquecido;
}

// Gemini/OpenAI às vezes devolvem texto antes/depois do JSON mesmo com
// responseMimeType/json_object. Extrai o objeto JSON de forma robusta.
function extrairJSON(conteudo) {
  const s = String(conteudo || '').trim();
  if (!s) throw new Error('resposta vazia');
  try {
    return JSON.parse(s);
  } catch (e) {
    const ini = s.indexOf('{');
    const fim = s.lastIndexOf('}');
    if (ini !== -1 && fim > ini) {
      const fatia = s.slice(ini, fim + 1);
      try {
        return JSON.parse(fatia);
      } catch (e2) {
        throw new Error(`resposta não é JSON válido: ${s.slice(0, 200)}`);
      }
    }
    throw new Error(`resposta não é JSON válido: ${s.slice(0, 200)}`);
  }
}

async function viaOpenAI(imagem) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      max_tokens: 1200,
      messages: [
        {
          role: 'system',
          content: PROMPT_SISTEMA,
        },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: imagem } }],
        },
      ],
    }),
  });

  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error(`OpenAI (HTTP ${res.status}): ${texto.slice(0, 300)}`);
  }
  const json = await res.json();
  const conteudo = json.choices?.[0]?.message?.content;
  if (!conteudo) throw new Error('OpenAI: resposta vazia');
  const dados = extrairJSON(conteudo);
  if (dados.tipo === 'invalido') throw new FotoInvalidaError(dados.motivo);
  if (dados.tipo === 'desconhecido') throw new Error('OpenAI: não reconheceu a imagem');
  return normalizarResultado({ provedor: 'OpenAI', ...dados });
}

async function viaGemini(base64, mime, textoExtra, sistemaPrompt) {
  const modelo = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const system = sistemaPrompt || PROMPT_SISTEMA;
  const parts = [];
  if (base64) {
    parts.push({ inline_data: { mime_type: mime, data: base64 } });
    parts.push({ text: textoExtra || 'Identifique a espécie da foto e preencha o JSON.' });
  } else {
    parts.push({ text: textoExtra || 'Identifique a espécie citada e preencha o JSON.' });
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts,
          },
        ],
        systemInstruction: { parts: [{ text: system }] },
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 1200,
        },
      }),
    }
  );
  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error(`Gemini (HTTP ${res.status}): ${texto.slice(0, 300)}`);
  }
  const json = await res.json();
  const conteudo = json.candidates?.[0]?.content?.parts
    ?.map((p) => p.text || '')
    .join('');
  if (!conteudo) throw new Error('Gemini: resposta vazia');
  const dados = extrairJSON(conteudo);
  if (dados.tipo === 'invalido') throw new FotoInvalidaError(dados.motivo);
  if (dados.tipo === 'desconhecido') throw new Error('Gemini: não reconheceu a imagem');
  return normalizarResultado({ provedor: 'Gemini', ...dados });
}

async function validarFotoGemini(base64, mime, prompt) {
  const modelo = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inline_data: { mime_type: mime, data: base64 } },
              { text: 'Valide esta foto.' },
            ],
          },
        ],
        systemInstruction: { parts: [{ text: prompt || PROMPT_VALIDACAO }] },
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 200,
        },
      }),
    }
  );
  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error(`Gemini validação (HTTP ${res.status}): ${texto.slice(0, 300)}`);
  }
  const json = await res.json();
  const conteudo = json.candidates?.[0]?.content?.parts
    ?.map((p) => p.text || '')
    .join('');
  if (!conteudo) throw new Error('Gemini validação: resposta vazia');
  const dados = extrairJSON(conteudo);
  return { valida: !!dados.valida, motivo: dados.motivo || '' };
}

async function validarFotoOpenAI(dataUrl, prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: prompt || PROMPT_VALIDACAO,
        },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: dataUrl } }],
        },
      ],
    }),
  });
  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error(`OpenAI validação (HTTP ${res.status}): ${texto.slice(0, 300)}`);
  }
  const json = await res.json();
  const conteudo = json.choices?.[0]?.message?.content;
  if (!conteudo) throw new Error('OpenAI validação: resposta vazia');
  const dados = extrairJSON(conteudo);
  return { valida: !!dados.valida, motivo: dados.motivo || '' };
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    servico: 'AquarIApp Identificador',
    chaves: semChaves(),
    fontes: {
      Fishipedia: true,
      AquarismoPaulista: true,
      ChacaraTakeyoshi: true,
      Wikipedia: true,
      GuiaSeuNovoAquario: true,
    },
  });
});

app.post('/identify', async (req, res) => {
  const { imagem } = req.body || {};
  if (!imagem || typeof imagem !== 'string') {
    return res.status(400).json({ erro: 'Envie o campo "imagem" (data URL base64) no corpo da requisição.' });
  }

  const base64 = imagem.includes('base64,') ? imagem.split('base64,')[1] : imagem;
  const prefixo = imagem.match(/^data:([^;]+);base64,/) ? imagem.match(/^data:([^;]+);base64,/)[1] : 'image/jpeg';
  const dataUrl = `data:${prefixo};base64,${base64}`;
  const erros = [];
  const errosValidacao = [];

  console.log(`[identify] mime=${prefixo} | base64 length=${base64 ? base64.length : 0}`);

  // Validação de conteúdo (mesma de /diagnostico): rejeita fotos que não sejam
  // de peixes/plantas aquáticas antes de gastar créditos de visão na identificação.
  {
    let valida = false;
    let motivo = '';
    const provedoresValidacao = semChavesValidacao();
    if (provedoresValidacao.length > 0) {
      if (process.env.GEMINI_API_KEY) {
        try {
          const r = await validarFotoGemini(base64, prefixo);
          valida = r.valida;
          motivo = r.motivo || '';
        } catch (e) {
          console.error('Falha Gemini (validação /identify):', e.message);
          errosValidacao.push(`Gemini: ${e.message}`);
        }
      }
      if (!valida && process.env.OPENAI_API_KEY) {
        try {
          const r = await validarFotoOpenAI(dataUrl);
          valida = r.valida;
          motivo = r.motivo || '';
        } catch (e) {
          console.error('Falha OpenAI (validação /identify):', e.message);
          errosValidacao.push(`OpenAI: ${e.message}`);
        }
      }

      if (!valida) {
        if (errosValidacao.length > 0 && errosValidacao.length === provedoresValidacao.length) {
          return res.status(502).json({
            erro: `Não foi possível validar a foto.\n\n${errosValidacao.join('\n')}`,
          });
        }
        return res.status(422).json({
          codigo: 'foto_invalida',
          erro: motivo || 'A foto não parece ser de um peixe ou planta aquática.',
        });
      }
    }
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const r = await viaGemini(base64, prefixo);
      return res.json(await comFoto(r));
    } catch (e) {
      console.error('Falha Gemini:', e.message);
      if (e instanceof FotoInvalidaError) {
        erros.push(`Gemini (foto inválida): ${e.message}`);
      } else {
        erros.push(`Gemini: ${e.message}`);
      }
    }
  }
  if (process.env.PLANTNET_API_KEY) {
    try {
      const r = await viaPlantNet(base64, prefixo);
      const enr = await comFoto(r);
      return res.json({ ...enr, opcoes: r.opcoes || [] });
    } catch (e) {
      console.error('Falha PlantNet:', e.message);
      erros.push(`PlantNet: ${e.message}`);
    }
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await viaOpenAI(dataUrl);
      return res.json(await comFoto(r));
    } catch (e) {
      console.error('Falha OpenAI:', e.message);
      if (e instanceof FotoInvalidaError) {
        erros.push(`OpenAI (foto inválida): ${e.message}`);
      } else {
        erros.push(`OpenAI: ${e.message}`);
      }
    }
  }

  const motivosInvalidos = erros.filter((e) => e.includes('foto inválida'));
  if (motivosInvalidos.length > 0 && motivosInvalidos.length === erros.length) {
    return res.status(422).json({ codigo: 'foto_invalida', erro: motivosInvalidos[0] });
  }

  const configuradas = semChaves().join(', ');
  return res.status(502).json({
    erro: configuradas
      ? `Nenhum provedor conseguiu identificar.\n\n${erros.join('\n')}`
      : 'Nenhuma chave configurada no servidor (.env).',
  });
});

app.post('/buscar-nome', async (req, res) => {
  const { nome } = req.body || {};
  const termo = String(nome || '').trim();
  if (termo.length < 2) {
    return res.status(400).json({ erro: 'Envie o campo "nome" (mínimo 2 caracteres).' });
  }

  const erros = [];

  if (process.env.GEMINI_API_KEY) {
    try {
      const r = await viaGemini(null, null, `Busque a ficha técnica do aquarismo para: ${termo}.`, PROMPT_BUSCA_NOME);
      const enriquecido = await comFoto(r);
      return res.json({ ...enriquecido, nomeBuscado: termo });
    } catch (e) {
      console.error('Falha Gemini (busca por nome):', e.message);
      erros.push(`Gemini: ${e.message}`);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await viaIAVision({
        imagem: null,
        systemPrompt: PROMPT_BUSCA_NOME,
        userText: `Busque a ficha técnica do aquarismo para: ${termo}.`,
      });
      const enriquecido = await comFoto(r);
      return res.json({ ...enriquecido, nomeBuscado: termo });
    } catch (e) {
      console.error('Falha OpenAI (busca por nome):', e.message);
      erros.push(`OpenAI: ${e.message}`);
    }
  }

  try {
    const r = await enriquecerWikipedia(termo);
    if (r) {
      const enriquecido = await comFoto(r);
      return res.json({ ...enriquecido, nomeBuscado: termo });
    }
  } catch (e) {
    console.error('Falha Wikipedia (busca por nome):', e.message);
    erros.push(`Wikipedia: ${e.message}`);
  }

  const fontesDiretas = [
    { nome: 'Aquarismo Paulista', fn: () => buscarAquarismoPaulista(termo) },
    { nome: 'Fishipedia', fn: () => buscarFishipedia(termo) },
    { nome: 'Chácara Takeyoshi', fn: () => buscarChacaraTakeyoshi(termo) },
  ];
  for (const fonte of fontesDiretas) {
    try {
      const r = await fonte.fn();
      if (r) {
        if (!r.foto) r.foto = await buscarImagemWikipedia(termo);
        return res.json({ ...r, nomeBuscado: termo });
      }
    } catch (e) {
      console.error(`Falha ${fonte.nome} (busca por nome):`, e.message);
      erros.push(`${fonte.nome}: ${e.message}`);
    }
  }

  return res.status(502).json({
    erro: `Nenhuma informação encontrada para "${termo}".\n\n${erros.join('\n')}`,
  });
});

app.post('/buscar-produto', async (req, res) => {
  const { marca, nome, tipo } = req.body || {};
  const termo = [marca, nome, tipo].filter(Boolean).join(' ').trim();
  if (termo.length < 2) {
    return res.status(400).json({ erro: 'Envie os campos "marca", "nome" e/ou "tipo" do produto.' });
  }

  const erros = [];
  const systemPrompt = PROMPT_BUSCA_PRODUTO;
  const userText = `Busque a ficha técnica do produto alimentar para aquário: ${termo}.`;

  if (process.env.GEMINI_API_KEY) {
    try {
      const r = await viaGemini(null, null, userText, systemPrompt);
      if (r && r.encontrado) {
        return res.json({
          ...r,
          marca: r.marca || marca || '',
          nome: r.nome || nome || '',
          tipo: r.tipo || tipo || '',
          nomeBuscado: termo,
          provedor: r.provedor || 'Gemini',
        });
      }
      erros.push(`Gemini: ${r && r.motivo ? r.motivo : 'não encontrou o produto'}`);
    } catch (e) {
      console.error('Falha Gemini (busca de produto):', e.message);
      erros.push(`Gemini: ${e.message}`);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await viaIAVision({ imagem: null, systemPrompt, userText });
      if (r && r.encontrado) {
        return res.json({
          ...r,
          marca: r.marca || marca || '',
          nome: r.nome || nome || '',
          tipo: r.tipo || tipo || '',
          nomeBuscado: termo,
          provedor: r.provedor || 'OpenAI',
        });
      }
      erros.push(`OpenAI: ${r && r.motivo ? r.motivo : 'não encontrou o produto'}`);
    } catch (e) {
      console.error('Falha OpenAI (busca de produto):', e.message);
      erros.push(`OpenAI: ${e.message}`);
    }
  }

  const configuradas = semChaves().join(', ');
  return res.status(502).json({
    erro: configuradas
      ? `Nenhum provedor conseguiu buscar a especificação.\n\n${erros.join('\n')}`
      : 'Nenhuma chave configurada no servidor (.env).',
  });
});

app.post('/validar-foto', async (req, res) => {
  const { imagem } = req.body || {};
  if (!imagem || typeof imagem !== 'string') {
    return res.status(400).json({ erro: 'Envie o campo "imagem" (data URL base64) no corpo da requisição.' });
  }

  const base64 = imagem.includes('base64,') ? imagem.split('base64,')[1] : imagem;
  const prefixo = imagem.match(/^data:([^;]+);base64,/) ? imagem.match(/^data:([^;]+);base64,/)[1] : 'image/jpeg';
  const dataUrl = `data:${prefixo};base64,${base64}`;
  const erros = [];

  console.log(`[validar-foto] mime=${prefixo} | base64 length=${base64 ? base64.length : 0}`);

  if (process.env.GEMINI_API_KEY) {
    try {
      return res.json(await validarFotoGemini(base64, prefixo));
    } catch (e) {
      console.error('Falha Gemini (validação):', e.message);
      erros.push(`Gemini: ${e.message}`);
    }
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      return res.json(await validarFotoOpenAI(dataUrl));
    } catch (e) {
      console.error('Falha OpenAI (validação):', e.message);
      erros.push(`OpenAI: ${e.message}`);
    }
  }

  const configuradas = semChaves().join(', ');
  return res.status(502).json({
    erro: configuradas
      ? `Nenhum provedor conseguiu validar a foto.\n\n${erros.join('\n')}`
      : 'Nenhuma chave configurada no servidor (.env).',
  });
});

app.post('/diagnostico', async (req, res) => {
  const { imagem, estoque, descricao, faunaPresente } = req.body || {};
  const temImagem = !!imagem && typeof imagem === 'string';
  const temDescricao = typeof descricao === 'string' && descricao.trim().length > 0;
  if (!temImagem && !temDescricao) {
    return res.status(400).json({
      erro: 'Envie ao menos uma foto (imagem) ou uma descrição do que você observa no peixe.',
    });
  }

  const base64 = temImagem && imagem.includes('base64,') ? imagem.split('base64,')[1] : temImagem ? imagem : '';
  const prefixo = temImagem && imagem.match(/^data:([^;]+);base64,/) ? imagem.match(/^data:([^;]+);base64,/)[1] : 'image/jpeg';
  const dataUrl = temImagem ? `data:${prefixo};base64,${base64}` : '';
  const errosValidacao = [];

  console.log(`[diagnostico] mime=${prefixo} | base64 length=${base64 ? base64.length : 0} | descricao=${temDescricao ? descricao.trim().length : 0}`);

  if (temImagem) {
    let valida = false;
    let motivo = '';
    const provedoresValidacao = semChavesValidacao();
    if (provedoresValidacao.length > 0) {
      if (process.env.GEMINI_API_KEY) {
        try {
          const r = await validarFotoGemini(base64, prefixo);
          valida = r.valida;
          motivo = r.motivo || '';
        } catch (e) {
          console.error('Falha Gemini (validação):', e.message);
          errosValidacao.push(`Gemini: ${e.message}`);
        }
      }
      if (!valida && process.env.OPENAI_API_KEY) {
        try {
          const r = await validarFotoOpenAI(dataUrl);
          valida = r.valida;
          motivo = r.motivo || '';
        } catch (e) {
          console.error('Falha OpenAI (validação):', e.message);
          errosValidacao.push(`OpenAI: ${e.message}`);
        }
      }

      if (!valida) {
        if (errosValidacao.length > 0 && errosValidacao.length === provedoresValidacao.length) {
          return res.status(502).json({
            erro: `Não foi possível validar a foto.\n\n${errosValidacao.join('\n')}`,
          });
        }
        return res.status(422).json({
          codigo: 'foto_invalida',
          erro: motivo || 'A foto não parece ser de um peixe de água doce ou de um aquário.',
        });
      }
    }
  }

  const medicamentosEstoque = (estoque || []).filter((i) => i.categoria === 'medicamentos');
  const temInvertebradoFauna = !!(faunaPresente && faunaPresente.temInvertebrado);
  const temAxoloteFauna = !!(faunaPresente && faunaPresente.temAxolote);

  const calcularAvisoFauna = (medicamentosComEstoque) => {
    const sensiveis = (medicamentosComEstoque || []).filter((m) =>
      /malaquita|malachite|cobre|copper/.test(
        String(m.nome || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      )
    );
    if (sensiveis.length === 0) return '';
    if (!temInvertebradoFauna && !temAxoloteFauna) return '';
    const alvos = [];
    if (temInvertebradoFauna) alvos.push('caramujos e camarões (invertebrados)');
    if (temAxoloteFauna) alvos.push('axolotes');
    return (
      `⚠️ ATENÇÃO À FAUNA: o tratamento usa ${sensiveis.map((m) => m.nome).join(', ')}. ` +
      `Esse produto é tóxico para ${alvos.join(' e ')}. ` +
      `Antes de tratar, retire ${temInvertebradoFauna ? 'os invertebrados' : 'o axolote'} do aquário ` +
      `(ou faça o tratamento em um aquário/quarentenário separado) para não prejudicar esses animais.`
    );
  };

  try {
    const dados = await diagnosticarComIA(temImagem ? imagem : null, medicamentosEstoque, temDescricao ? descricao : '', { temInvertebradoFauna, temAxoloteFauna });

    let doencaFinal = dados.doenca || '';
    const naoIdentificado = !doencaFinal || doencaFinal === 'não identificado';
    if (naoIdentificado && temDescricao) {
      const local = diagnosticarPorDescricao(descricao);
      if (local) {
        const medicamentos = local.medicamentos.map((med) => {
          const nomeMed = String(med).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const noEstoque = medicamentosEstoque.some((m) => {
            const nomeM = String(m.nome || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            return nomeMed.includes(nomeM) || nomeM.includes(nomeMed) || String(m.nome || '').toLowerCase() === String(med).toLowerCase();
          });
          return { nome: med, noEstoque };
        });
        return res.json({
          doenca: local.nome,
          confianca: 'média',
          evidencia: `Identificado pela descrição: "${descricao.trim()}".`,
          sintomas: local.sintomas,
          causa: local.causa,
          tratamento: local.tratamento,
          dicas: 'Confira os sinais com atenção; se puder, envie também uma foto para maior precisão.',
          medicamentos,
          avisoFauna: calcularAvisoFauna(medicamentos),
          foto: await buscarImagemWikipedia(local.nome),
        });
      }
    }

    if (naoIdentificado) {
      return res.status(422).json({
        codigo: 'sem_diagnostico',
        erro: 'Não foi possível identificar uma doença clara. Descreva melhor o que você vê ou envie uma foto mais próxima do peixe.',
      });
    }
    const medicamentosRecomendados = Array.isArray(dados.medicamentos) ? dados.medicamentos : [];
    const comEstoque = medicamentosRecomendados.map((med) => {
      const nomeMed = String(med).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const noEstoque = medicamentosEstoque.some((m) => {
        const nomeM = String(m.nome || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        return nomeMed.includes(nomeM) || nomeM.includes(nomeMed) || String(m.nome || '').toLowerCase() === String(med).toLowerCase();
      });
      return { nome: med, noEstoque };
    });
    return res.json({
      doenca: doencaFinal,
      confianca: dados.confianca || 'média',
      evidencia: dados.evidencia || '',
      sintomas: dados.sintomas || '',
      causa: dados.causa || '',
      tratamento: dados.tratamento || '',
      dicas: dados.dicas || '',
      medicamentos: comEstoque,
      avisoFauna: calcularAvisoFauna(comEstoque),
      foto: await buscarImagemWikipedia(doencaFinal),
    });
  } catch (e) {
    console.error('Falha no diagnóstico:', e.message);
    return res.status(502).json({ erro: e.message });
  }
});

app.post('/diagnostico-alga', async (req, res) => {
  const { imagem, descricao } = req.body || {};
  const temImagem = !!imagem && typeof imagem === 'string';
  const temDescricao = typeof descricao === 'string' && descricao.trim().length > 0;
  if (!temImagem && !temDescricao) {
    return res.status(400).json({
      erro: 'Envie ao menos uma foto (imagem) ou uma descrição do que você observa no aquário.',
    });
  }

  const base64 = temImagem && imagem.includes('base64,') ? imagem.split('base64,')[1] : temImagem ? imagem : '';
  const prefixo = temImagem && imagem.match(/^data:([^;]+);base64,/) ? imagem.match(/^data:([^;]+);base64,/)[1] : 'image/jpeg';
  const dataUrl = temImagem ? `data:${prefixo};base64,${base64}` : '';
  const errosValidacao = [];

  console.log(`[diagnostico-alga] mime=${prefixo} | base64 length=${base64 ? base64.length : 0} | descricao=${temDescricao ? descricao.trim().length : 0}`);

  if (temImagem) {
    const { valida, motivo, falhouTudo } = await validarCenaAquario({ base64, prefixo, dataUrl, errosValidacao });
    if (!valida) {
      if (falhouTudo) {
        return res.status(502).json({ erro: `Não foi possível validar a foto.\n\n${errosValidacao.join('\n')}` });
      }
      return res.status(422).json({
        codigo: 'foto_invalida',
        erro: motivo || 'A foto não parece ser de uma cena de aquário de água doce.',
      });
    }
  }

  const userText = temDescricao
    ? `Descrição do usuário sobre o que observa: "${descricao.trim()}". Analise e identifique a alga, cruzando com o catálogo.`
    : 'Analise a foto e identifique a alga do aquário de água doce, cruzando com o catálogo.';

  try {
    const dados = await viaIAVision({
      imagem: temImagem ? imagem : null,
      systemPrompt: promptAlgasComCatalogo(),
      userText,
    });
    if (!dados.alga || dados.alga === 'não identificado') {
      return res.status(422).json({
        codigo: 'sem_diagnostico',
        erro: 'Não foi possível identificar uma alga clara. Descreva melhor ou envie uma foto mais próxima.',
      });
    }
    return res.json({
      alga: dados.alga,
      confianca: dados.confianca || 'média',
      sintomas: dados.sintomas || '',
      causa: dados.causa || '',
      tratamento: dados.tratamento || '',
      dicas: dados.dicas || '',
      foto: await buscarImagemWikipedia(dados.alga),
    });
  } catch (e) {
    console.error('Falha no diagnóstico de alga:', e.message);
    return res.status(502).json({ erro: e.message });
  }
});

app.post('/diagnostico-micro', async (req, res) => {
  const { imagem, descricao } = req.body || {};
  const temImagem = !!imagem && typeof imagem === 'string';
  const temDescricao = typeof descricao === 'string' && descricao.trim().length > 0;
  if (!temImagem && !temDescricao) {
    return res.status(400).json({ erro: 'Envie ao menos uma foto (imagem) ou uma descrição do que você observa.' });
  }

  let base64 = '';
  let prefixo = 'image/jpeg';
  let dataUrl = '';
  const errosValidacao = [];

  if (temImagem) {
    base64 = imagem.includes('base64,') ? imagem.split('base64,')[1] : imagem;
    prefixo = imagem.match(/^data:([^;]+);base64,/) ? imagem.match(/^data:([^;]+);base64,/)[1] : 'image/jpeg';
    dataUrl = `data:${prefixo};base64,${base64}`;
    console.log(`[diagnostico-micro] mime=${prefixo} | base64 length=${base64 ? base64.length : 0} | descricao=${descricao ? descricao.length : 0}`);

    const { valida, motivo, falhouTudo } = await validarCenaAquario({ base64, prefixo, dataUrl, errosValidacao });
    if (!valida) {
      if (falhouTudo) {
        return res.status(502).json({ erro: `Não foi possível validar a foto.\n\n${errosValidacao.join('\n')}` });
      }
      return res.status(422).json({
        codigo: 'foto_invalida',
        erro: motivo || 'A foto não parece ser de uma cena de aquário de água doce.',
      });
    }
  } else {
    console.log(`[diagnostico-micro] descricao=${descricao ? descricao.length : 0}`);
  }

  const userText = temDescricao
    ? `Descrição do usuário sobre o que observa no aquário: "${descricao.trim()}". Analise e identifique o microorganismo, cruzando com o catálogo.`
    : 'Analise a foto e identifique o microorganismo do aquário de água doce, cruzando com o catálogo.';

  try {
    const dados = await viaIAVision({
      imagem: temImagem ? imagem : null,
      systemPrompt: promptMicroComCatalogo(),
      userText,
    });
    if (!dados.organismo || dados.organismo === 'não identificado') {
      return res.status(422).json({
        codigo: 'sem_diagnostico',
        erro: 'Não foi possível identificar o microorganismo com as informações fornecidas. Descreva melhor ou envie uma foto mais próxima.',
      });
    }
    return res.json({
      organismo: dados.organismo,
      confianca: dados.confianca || 'média',
      descricao: dados.descricao || '',
      classificacao: dados.classificacao || '',
      acao: dados.acao || '',
      tratamento: dados.tratamento || '',
      dicas: dados.dicas || '',
      foto: await buscarImagemWikipedia(dados.organismo),
    });
  } catch (e) {
    console.error('Falha na análise de microorganismo:', e.message);
    return res.status(502).json({ erro: e.message });
  }
});

app.post('/compatibilidade', async (req, res) => {
  const { novoPeixe, faunaExistente, phDesejavel, parametrosAgua } = req.body || {};

  if (!novoPeixe || !novoPeixe.nomeCientifico) {
    return res.status(400).json({ erro: 'Envie o campo "novoPeixe" com nomeCientifico/nomeComum.' });
  }

  const baseDoNovo =
    `Novo peixe: ${novoPeixe.nomeComum || ''} (${novoPeixe.nomeCientifico}). ` +
    (novoPeixe.temperatura ? `Temperatura: ${novoPeixe.temperatura}. ` : '') +
    (novoPeixe.ph ? `pH: ${novoPeixe.ph}. ` : '');

  const textoFauna = (faunaExistente || [])
    .map((f, i) => {
      const qtd = f.quantidade ? ` (${f.quantidade}x)` : '';
      let linha = `${i + 1}. ${f.nomeComum || f.nome || ''} (${f.nomeCientifico || '?'})${qtd}`;
      if (f.temperatura) linha += ` | Temp: ${f.temperatura}`;
      if (f.ph) linha += ` | pH: ${f.ph}`;
      return linha;
    })
    .join('; ');

  const textoAgua =
    (phDesejavel ? `pH desejado do aquário: ${phDesejavel}. ` : '') +
    (parametrosAgua?.ph ? `pH medido: ${parametrosAgua.ph}. ` : '') +
    (parametrosAgua?.temperatura ? `Temperatura medida: ${parametrosAgua.temperatura} °C. ` : '');

  const pergunta =
    `${baseDoNovo}\nPeixes já existentes no aquário: ${textoFauna || 'nenhum'}\nParâmetros da água: ${textoAgua || 'não informados'}` +
    `\nAvalie se ${novoPeixe.nomeComum || novoPeixe.nomeCientifico} pode ser adicionado a este aquário.`;

  const erros = [];
  console.log(`[compatibilidade] novo=${novoPeixe.nomeCientifico} | fauna=${(faunaExistente || []).length}`);

  if (process.env.GEMINI_API_KEY) {
    try {
      const modelo = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
      const resIA = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(AI_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: pergunta }] }],
            systemInstruction: { parts: [{ text: PROMPT_COMPATIBILIDADE }] },
            generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 300 },
          }),
        }
      );
      if (!resIA.ok) {
        const texto = await resIA.text().catch(() => '');
        throw new Error(`Gemini compatibilidade (HTTP ${resIA.status}): ${texto.slice(0, 300)}`);
      }
      const json = await resIA.json();
      const conteudo = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
      if (!conteudo) throw new Error('Gemini compatibilidade: resposta vazia');
      const dados = JSON.parse(conteudo);
      return res.json({ compativel: !!dados.compativel, motivo: dados.motivo || '' });
    } catch (e) {
      console.error('Falha Gemini (compatibilidade):', e.message);
      erros.push(`Gemini: ${e.message}`);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const resIA = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          max_tokens: 300,
          messages: [
            { role: 'system', content: PROMPT_COMPATIBILIDADE },
            { role: 'user', content: pergunta },
          ],
        }),
      });
      if (!resIA.ok) {
        const texto = await resIA.text().catch(() => '');
        throw new Error(`OpenAI compatibilidade (HTTP ${resIA.status}): ${texto.slice(0, 300)}`);
      }
      const json = await resIA.json();
      const conteudo = json.choices?.[0]?.message?.content;
      if (!conteudo) throw new Error('OpenAI compatibilidade: resposta vazia');
      const dados = JSON.parse(conteudo);
      return res.json({ compativel: !!dados.compativel, motivo: dados.motivo || '' });
    } catch (e) {
      console.error('Falha OpenAI (compatibilidade):', e.message);
      erros.push(`OpenAI: ${e.message}`);
    }
  }

  const configuradas = semChaves().join(', ');
  return res.status(502).json({
    erro: configuradas
      ? `Nenhum provedor conseguiu avaliar a compatibilidade.\n\n${erros.join('\n')}`
      : 'Nenhuma chave configurada no servidor (.env).',
  });
});

app.post('/sugestoes', async (req, res) => {
  const { aquario, faunaExistente, parametrosAgua, phDesejavel, litros } = req.body || {};

  if (!aquario && !faunaExistente) {
    return res.status(400).json({ erro: 'Envie os dados do aquário ("aquario" ou "faunaExistente").' });
  }

  const infoAquario = aquario || {};
  const infoFauna = faunaExistente || [];

  const descricaoAquario =
    `Tipo do aquário: ${infoAquario.tipo || 'não informado'}. ` +
    `Capacidade: ${litros ? `${litros} L` : infoAquario.litros ? `${infoAquario.litros} L` : 'não informada'}. ` +
    `pH desejável: ${phDesejavel || infoAquario.phDesejavel || 'não informado'}. ` +
    `Aquário plantado: ${infoAquario.ehPlantado || 'não informado'}.`;

  const textoFauna = infoFauna
    .map((f, i) => {
      const qtd = f.quantidade ? ` (${f.quantidade}x)` : '';
      let linha = `${i + 1}. ${f.nomeComum || f.nome || ''} (${f.nomeCientifico || '?'})${qtd}`;
      if (f.temperatura) linha += ` | Temp: ${f.temperatura}`;
      if (f.ph) linha += ` | pH: ${f.ph}`;
      if (f.tamanho) linha += ` | Tam adulto: ${f.tamanho}`;
      if (f.comportamento) linha += ` | Comportamento: ${f.comportamento}`;
      if (f.dieta) linha += ` | Dieta: ${f.dieta}`;
      return linha;
    })
    .join('; ');

  const textoAgua =
    (parametrosAgua?.ph ? `pH medido: ${parametrosAgua.ph}. ` : '') +
    (parametrosAgua?.temperatura ? `Temperatura medida: ${parametrosAgua.temperatura} °C. ` : '');

  const pergunta =
    `${descricaoAquario}\n` +
    `Peixes já existentes no aquário: ${textoFauna || 'nenhum'}\n` +
    `Parâmetros da água: ${textoAgua || 'não informados'}\n` +
    'Sugira até 5 espécies de peixes de água doce compatíveis com a fauna existente e com o ambiente deste aquário.';

  const erros = [];
  console.log(`[sugestoes] fauna=${infoFauna.length} | litros=${litros || infoAquario.litros || '?'}`);

  if (process.env.GEMINI_API_KEY) {
    try {
      const modelo = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
      const resIA = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(AI_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: pergunta }] }],
            systemInstruction: { parts: [{ text: promptSugestoesComGuia() }] },
            generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 400 },
          }),
        }
      );
      if (!resIA.ok) {
        const texto = await resIA.text().catch(() => '');
        throw new Error(`Gemini sugestões (HTTP ${resIA.status}): ${texto.slice(0, 300)}`);
      }
      const json = await resIA.json();
      const conteudo = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
      if (!conteudo) throw new Error('Gemini sugestões: resposta vazia');
      const dados = JSON.parse(conteudo);
      const lista = (dados.sugestoes || []).slice(0, 5);
      return res.json({ sugestoes: lista });
    } catch (e) {
      console.error('Falha Gemini (sugestoes):', e.message);
      erros.push(`Gemini: ${e.message}`);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const resIA = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          max_tokens: 400,
          messages: [
            { role: 'system', content: promptSugestoesComGuia() },
            { role: 'user', content: pergunta },
          ],
        }),
      });
      if (!resIA.ok) {
        const texto = await resIA.text().catch(() => '');
        throw new Error(`OpenAI sugestões (HTTP ${resIA.status}): ${texto.slice(0, 300)}`);
      }
      const json = await resIA.json();
      const conteudo = json.choices?.[0]?.message?.content;
      if (!conteudo) throw new Error('OpenAI sugestões: resposta vazia');
      const dados = JSON.parse(conteudo);
      const lista = (dados.sugestoes || []).slice(0, 5);
      return res.json({ sugestoes: lista });
    } catch (e) {
      console.error('Falha OpenAI (sugestoes):', e.message);
      erros.push(`OpenAI: ${e.message}`);
    }
  }

  const configuradas = semChaves().join(', ');
  return res.status(502).json({
    erro: configuradas
      ? `Nenhum provedor conseguiu gerar sugestões.\n\n${erros.join('\n')}`
      : 'Nenhuma chave configurada no servidor (.env).',
  });
});

app.post('/sugestao-aquario', async (req, res) => {
  const { litros, tipo, tipoFauna } = req.body || {};
  const volume = parseFloat(String(litros || '').replace(',', '.'));
  if (!volume || volume <= 0) {
    return res.status(400).json({ erro: 'Informe o volume pretendido em litros.' });
  }
  const tiposValidos = ['Comunitário', 'Jumbo', 'Espécie Única', 'Hospital'];
  const tipoAquario = tiposValidos.includes(tipo) ? tipo : 'Comunitário';

  // Biótopos de água doce: orientação para a IA escolher a fauna correta.
  const BIOTOPOS = {
    amazonica:
      'Amazônico: água ácida e muito mole, temperatura quente, rica em troncos. ' +
      'Fauna típica: discos, acarás-bandeira, neons, coridoras, cascudos. ' +
      'Flora: Echinodorus (amazonenses) e Vallisneria.',
    'agua-negra':
      'Água negra (blackwater, afluentes do Rio Negro): água muito escura (cor de chá) por taninos de folhas e troncos, iluminação muito baixa. ' +
      'Fauna típica: neons, tetras e ciclídeos anões (Apistogramma).',
    americana:
      'Americana (rios de correnteza e lagos da América Central): água alcalina e dura, decoração de rochas e poucos troncos. ' +
      'Fauna típica: ciclídeos de médio e grande porte (Jack Dempsey, boca de fogo) e vivíparos (guppys, plati, molinésias).',
    asiatica:
      'Asiática (rios e pântanos do Sudeste Asiático): água levemente ácida a neutra, fluxo lento ou estagnado, vegetação abundante. ' +
      'Fauna típica: bettas, gouramis, rasboras e danios. ' +
      'Flora: Cryptocorynes, higrófilas e samambaias de Java. ' +
      '(Há também a variação de correnteza/hillstream: água fria, muito oxigenada, correnteza forte; cobrinhas kuhli e peixes-ventosa.)',
    africana:
      'Africana (grandes lagos do Rift — Malawi, Tanganyika e Victoria): água muito alcalina e muito dura, decoração de rochas empilhadas, quase sem troncos. ' +
      'Fauna típica: ciclídeos africanos coloridos e territoriais (mbunas do Malawi). ' +
      'Flora: quase inexistente (apenas Anúbias resistentes). ' +
      '(Rios do oeste africano: água ácida a neutra, troncos e vegetação; kribensis e peixes-elefante.)',
    australiana:
      'Australiana/Papua Nova Guiné: água neutra a levemente alcalina, vegetação esparsa, boa iluminação. ' +
      'Fauna típica: peixes-arco-íris (rainbowfish).',
    primitiva:
      'Peixes primitivos (fósseis vivos): espécies que preservam características morfológicas de milhões de anos, ' +
      'como escamas ganoides pesadas ou respiração aérea. Ex.: Polypterus (bichir), Aruanã (Osteoglossum bicirrhosum), ' +
      'Peixe-Corda (Erpetoichthys calabaricus) e Lepisosteus (peixe-gator/gar). ' +
      'São peixes de fundo ou superfície, muito resistentes, mas exigem aquários GRANDES (300 L+), totalmente TAMPADOS ' +
      '(são saltadores/rastejadores natos), filtragem potente (Sump ou Canister superdimensionado — geram muita amônia) e ' +
      'decoração segura (troncos lisos, areia fina, sem rochas pontiagudas).',
    exotica:
      'Peixes exóticos (formatos e comportamentos incomuns): espécies com anatomia fora do padrão. ' +
      'Ex.: Peixe-Faca-Palhaço (Chitala ornata, nada para trás com a nadadeira anal), Datnoid/Peixe-Tigre (listras pretas, ' +
      'boca retrátil agressiva), Peixe-Elefante (Gnathonemus petersii, com tromba elétrica, areia fina no fundo) e ' +
      'Peixe-Borboleta Africano (Pantodon buchholzi, habita a superfície, pode ficar em ~100 L). ' +
      'Exigem atenção ao tamanho adulto, tampas (saltadores) e substrato adequado.',
    nanofauna:
      'Nano aquário (5 a 40 L): ecossistema miniaturizado, fauna MINIMALISTA e de baixa carga orgânica. ' +
      'Invertebrados: camarões ornamentais (Neocaridinas Red Cherry) e caramujos pequenos (Planorbis). ' +
      'Peixes solitários: 1 Betta ou Peixe-Paraíso (acima de 20 L). Micro-cardumes (5-6): Tetras Neon, Rasboras Nano, ' +
      'Guppys Endler ou limpa-vidros (a partir de 30 L). Flora de baixo porte: musgos (Java, Christmas), Anubias Nana, ' +
      'Bucephalandras e plantas de carpete (Elenocharis). Destaque: estabilidade difícil (pouca diluição), evaporação rápida; ' +
      'use equipamentos compactos e reposição com água deionizada/destilada.',
    invertebrados:
      'Invertebrados e outros animais exóticos: alternativa fora dos peixes tradicionais. ' +
      'Ex.: Mini Arraia de Rio (Gastromyzon — peixe comedor de algas de corredeiras com formato achatado que imita arraia), ' +
      'Camarão Sossego/Filtrador (Atya gabonensis — grande, azulado, sem garras, filtra partículas com leques nas patas) e ' +
      'Ampulárias Gigantes (moluscos ativos, ajudam na limpeza e "escalam" os vidros). ' +
      'Oriente a fauna para invertebrados (camarões, caramujos, moluscos) e peixes pequenos e pacíficos compatíveis.',
  };

  const biotopoTexto = BIOTOPOS[tipoFauna]
    ? `\nTipo de fauna / biótopo: ${BIOTOPOS[tipoFauna]}`
    : '';

  const pergunta =
    `Volume pretendido: ${volume} L.\nTipo de aquário: ${tipoAquario}.` +
    biotopoTexto +
    `\nMonte a sugestão completa de fauna, flora, água e equipamentos para este aquário novo.`;

  console.log(`[sugestao-aquario] litros=${volume} | tipo=${tipoAquario} | fauna=${tipoFauna || 'sem'}`);

  try {
    const dados = await viaIAVision({
      imagem: null,
      systemPrompt: PROMPT_SUGESTAO_AQUARIO,
      userText: pergunta,
    });
    return res.json({
      litros: volume,
      tipo: tipoAquario,
      tipoFauna: tipoFauna || 'sem',
      fauna: Array.isArray(dados.fauna) ? dados.fauna : [],
      flora: Array.isArray(dados.flora) ? dados.flora : [],
      agua: dados.agua || {},
      equipamentos: Array.isArray(dados.equipamentos) ? dados.equipamentos : [],
    });
  } catch (e) {
    console.error('Falha na sugestão de aquário:', e.message);
    return res.status(502).json({ erro: e.message });
  }
});

app.post('/avaliacao-aquario', async (req, res) => {
  const { aquario, fauna, flora, lotacao, tech, qualidade, estoque } = req.body || {};
  if (!aquario) {
    return res.status(400).json({ erro: 'Envie os dados do aquário.' });
  }

  const dims = aquario.comp && aquario.larg && aquario.alt
    ? `${aquario.comp} x ${aquario.larg} x ${aquario.alt} cm`
    : '';
  const listaObjeto = (obj) => (obj ? Object.keys(obj).filter((k) => obj[k]).join(', ') : '');
  const textoAquario =
    `Nome: ${aquario.nome || ''}. Tipo: ${aquario.tipo || ''}. Formato: ${aquario.formato || ''}. ` +
    `Capacidade: ${aquario.litros ? `${aquario.litros} L` : 'não informada'}. ${dims ? `Dimensões: ${dims}.` : ''} ` +
    `pH desejável: ${aquario.phDesejavel || 'não informado'}. Plantado: ${aquario.ehPlantado || 'não'}. ` +
    `CO2: ${aquario.usaCO2 || 'não informado'}.`;
  const textoFiltros =
    `Filtragem: ${listaObjeto(aquario.filtros) || 'não informado'}. Componentes: ${listaObjeto(aquario.componentes) || 'não informado'}. ` +
    `Filtragem UV: ${aquario.filtragemUV || 'não'}. Vazão da bomba: ${aquario.vazaoBomba ? `${aquario.vazaoBomba} L/h` : 'não informada'}. ` +
    `Última limpeza do filtro: ${aquario.dataLimpezaFiltro || 'não informada'}. Manutenção do filtro: ${aquario.manutencaoFiltro || 'não informada'}.`;
  const textoAmbiente =
    `Substrato: ${listaObjeto(aquario.substratos) || 'não informado'}. Ambiente/decoração: ${listaObjeto(aquario.ambiente) || 'não informado'}. ` +
    `Aquecimento: ${aquario.aquecimento || 'não'}. Resfriamento: ${aquario.resfriamento || 'não'}. Aeração: ${listaObjeto(aquario.aeracao) || 'não informada'}.`;
  const textoIlum =
    `Iluminação: ${listaObjeto(aquario.iluminacao) || 'não informada'}. Timer: ${aquario.possuiTimer || 'não'}. ` +
    `Luz solar direta: ${aquario.luzSolar || 'não'}. Horas de luz/dia: ${aquario.horasLuz ? `${aquario.horasLuz} h` : 'não informado'}.`;
  const textoRotina =
    `Reposição de água: ${aquario.reposicaoAgua || 'não informada'}. Frequência de TPA: ${aquario.frequenciaTPA || 'não informada'}. ` +
    `Última TPA: ${aquario.dataUltimaTPA || 'não informada'}. Volume de TPA: ${aquario.volumeTPA || 'não informado'}.`;

  const textoFauna = (fauna || [])
    .map((f, i) => {
      const qtd = f.quantidade ? ` (${f.quantidade}x)` : '';
      let linha = `${i + 1}. ${f.nomeComum || f.nome}${qtd} (${f.nomeCientifico || '?'})`;
      if (f.tamanho) linha += ` | Tam: ${f.tamanho}`;
      if (f.temperatura) linha += ` | Temp: ${f.temperatura}`;
      if (f.ph) linha += ` | pH: ${f.ph}`;
      if (f.dieta) linha += ` | Dieta: ${f.dieta}`;
      if (f.comportamento) linha += ` | Comportamento: ${f.comportamento}`;
      return linha;
    })
    .join('; ');

  const textoFlora = (flora || [])
    .map((f) => `${f.nomeComum || f.nome}${f.quantidade ? ` (${f.quantidade}x)` : ''}`)
    .join('; ');

  const textoLotacao = lotacao
    ? `Lotação: ${lotacao.percentual != null ? `${lotacao.percentual}%` : 'não calculada'} (status: ${lotacao.status || '?'}), ${lotacao.totalCm != null ? `${lotacao.totalCm} cm` : '?'} de peixes em ${lotacao.litros ? `${lotacao.litros} L` : '?'}.`
    : '';
  const textoTech = tech
    ? `Exigência das plantas (tech): ${tech.rotulo || tech.nivel || '?'}.`
    : '';
  const textoQualidade = qualidade
    ? `Qualidade da água: ${qualidade.descricao || qualidade.nivel || 'sem dados'}.${qualidade.alertas && qualidade.alertas.length ? ` Alertas: ${qualidade.alertas.join('; ')}.` : ''}`
    : '';
  const textoEstoque = (estoque || [])
    .slice(0, 25)
    .map((i) => `${i.nome || ''} (${i.marca || ''}, ${i.categoria || ''})`)
    .filter(Boolean)
    .join('; ');

  const pergunta =
    `${textoAquario}\n${textoFiltros}\n${textoAmbiente}\n${textoIlum}\n${textoRotina}\n` +
    `Fauna: ${textoFauna || 'nenhuma cadastrada'}\nFlora: ${textoFlora || 'nenhuma cadastrada'}\n` +
    `${textoLotacao}\n${textoTech}\n${textoQualidade}\nEstoque: ${textoEstoque || 'nenhum'}\n\n` +
    'Avalie este aquário e entregue o resumo com dicas de como ele pode ser melhor.';

  console.log(`[avaliacao-aquario] fauna=${(fauna || []).length} | flora=${(flora || []).length} | estoque=${(estoque || []).length}`);

  try {
    const dados = await viaIAVision({
      imagem: null,
      systemPrompt: PROMPT_AVALIACAO,
      userText: pergunta,
    });
    return res.json({
      resumo: dados.resumo || '',
      pontosFortes: Array.isArray(dados.pontosFortes) ? dados.pontosFortes : [],
      sugestoes: Array.isArray(dados.sugestoes) ? dados.sugestoes : [],
      urgencias: Array.isArray(dados.urgencias) ? dados.urgencias : [],
    });
  } catch (e) {
    console.error('Falha na avaliação:', e.message);
    return res.status(502).json({ erro: e.message });
  }
});

const PROMPT_CRONOGRAMA =
  'Você é um especialista em aquarismo de água doce. O usuário tem um aquário JÁ ESTABELECIDO (já ciclado e habitado) ' +
  'com uma composição de peixes (fauna) e plantas (flora), e um estoque de produtos que contém apenas as rações ' +
  '(alimentos) e fertilizantes que ele possui de verdade. Monte um CRONOGRAMA ALIMENTAR e de fertilização para a semana. ' +
  'IMPORTANTE: como o aquário já existe e está estabilizado, NÃO inclua jejum inicial (dieta em branco nos primeiros dias). ' +
  'Jejum só deve ser usado em dias específicos se fizer sentido real para a saúde das espécies. ' +
  'Regras OBRIGATÓRIAS: ' +
  '(1) AVALIE A ADEQUAÇÃO DAS RAÇÕES: cada ração do estoque traz especificações técnicas do fabricante (tipo, indicação, ' +
  'princípios ativos, forma de uso). Verifique se a ração é compatível com a dieta, o porte e a boca da fauna. ' +
  'Exemplos de incompatibilidade: ração onívora/flocos finos NÃO serve para um axolote carnívoro; ração herbívora não serve ' +
  'para peixes carnívoros; grânulos grandes não servem para peixes de boca pequena. Use SOMENTE rações do estoque que sejam ' +
  'ADEQUADAS à fauna. ' +
  '(2) SE NENHUMA ração do estoque for adequada à fauna (ou todas forem incompatíveis), NÃO invente nem force o uso delas: ' +
  'deixe "alimentacao" null nos dias, ative alerta.temAlerta explicando claramente por que as rações atuais não servem para ' +
  'aquela fauna, e preencha "sugestoes" com até 3 alimentos adequados (baseado no conhecimento técnico e nas especificações ' +
  'típicas dos fabricantes), cada um com nome, marca, tipo, indicação e o motivo da escolha. ' +
  '(3) NO MÁXIMO UMA alimentação por dia. ' +
  '(4) A quantidade deve considerar o número de peixes de cada espécie e o porte do aquário. ' +
  '(5) Fertilizantes: use SOMENTE os do estoque e apenas se o aquário tiver plantas (flora) e for plantado. ' +
  'Calcule a dose conforme a capacidade em litros do aquário e a quantidade de plantas, e distribua os ' +
  'fertilizantes em dias específicos da semana, sem conflitar com o que já foi agendado. ' +
  '(6) SEGURANÇA DA FAUNA (obrigatório): alguns fertilizantes são bons para as plantas mas TÓXICOS para certos animais. ' +
  'NUNCA sugira fertilizantes com glutaraldeído/carbono líquido (ex.: Excel, EasyCarbo, produtos com "carbono líquido") ' +
  'se a fauna tiver AXOLOTE ou INVERTEBRADOS (camarões, caramujos, lagostas, lagostins, siris/caranguejos). ' +
  'NUNCA sugira fertilizantes com COBRE se houver invertebrados na fauna. ' +
  'Se a flora indicaria esses produtos mas a fauna é sensível, NÃO os use: deixe de fora, ative ' +
  'alerta.temAlerta explicando o motivo (fauna sensível) e mencione isso no resumo. ' +
  'Responda APENAS com JSON válido no formato: ' +
  '{"dias":[{"dia":"Segunda-feira","jejum":false,"alimentacao":"nome exato da ração do estoque (ou null)","quantidade":"ex: 1 pitada","observacoes":"breve dica"},...],' +
  '"fertilizantes":[{"produto":"nome exato do fertilizante do estoque","dose":"ex: 2,5 mL","frequencia":"ex: 2x por semana","dias":["Terça-feira","Sexta-feira"],"observacoes":"breve dica"}],' +
  '"resumo":"resumo curto da estratégia",' +
  '"alerta":{"temAlerta":false,"titulo":"","mensagem":""},' +
  '"sugestoes":[{"nome":"nome do alimento","marca":"marca","tipo":"tipo","indicacao":"indicação do produto","motivo":"por que é adequado para a fauna"}]}. ' +
  'Os campos "dias" devem conter exatamente 7 itens, de Segunda-feira a Domingo. ' +
  'Se houver rações adequadas no estoque, preencha os dias normalmente e deixe alerta.temAlerta false e sugestoes como lista vazia. ' +
  'Se não houver ração adequada, deixe alimentacao null nos dias, ative alerta.temAlerta e preencha sugestoes. ' +
  'Se não houver fertilizante ou plantas, deixe fertilizantes como lista vazia. ' +
  'TPA (troca parcial de água): se o usuário informar um dia fixo de TPA ("tpaDia"), aquele dia deve ser ' +
  'obrigatoriamente de JEJUM (jejum true) com observacoes mencionando "TPA" — nada de ração nesse dia, ' +
  'para evitar estresse durante a troca de água.';

function montarResultadoCronograma(dados) {
  return {
    dias: Array.isArray(dados.dias) ? dados.dias : [],
    fertilizantes: Array.isArray(dados.fertilizantes) ? dados.fertilizantes : [],
    resumo: dados.resumo || '',
    alerta:
      dados.alerta && typeof dados.alerta === 'object'
        ? {
            temAlerta: !!dados.alerta.temAlerta,
            titulo: dados.alerta.titulo || '',
            mensagem: dados.alerta.mensagem || '',
          }
        : { temAlerta: false, titulo: '', mensagem: '' },
    sugestoes: Array.isArray(dados.sugestoes) ? dados.sugestoes : [],
  };
}

const PROMPT_DIAGNOSTICO =
  'Você é um ictiopatologista (especialista em doenças de peixes de água doce). Analise a foto de um peixe ' +
  'de água doce (e a descrição do usuário, se houver) e identifique a doença MAIS PROVÁVEL entre as comuns ' +
  'em aquarismo. ' +
  'Regras OBRIGATÓRIAS: ' +
  '(1) Se a imagem contém um peixe (mesmo borrado, pequeno, parcial ou em ângulo), SEMPRE retorne a doença ' +
  'mais provável, mesmo que sua certeza seja baixa (use "confianca":"baixa" e explique os sinais em "evidencia"). ' +
  '(2) Compare os sinais visíveis (pontos brancos como sal, veludo dourado, algodão, nadadeiras desfiadas, ' +
  'barriga inchada/escamas pinadas, olhos saltados, buracos na cabeça, coluna curvada, parasitas visíveis, ' +
  'cores apagadas, posição na água) com o catálogo abaixo e escolha a MELHOR correspondência. ' +
  '(3) Use doenca "não identificado" APENAS se não houver peixe nenhum na imagem ou se não existir sinal ' +
  'algum de doença que permita raciocinar uma hipótese. ' +
  '(4) "evidencia" deve listar os sinais visíveis que você observou na foto/descrição. ' +
  'Responda APENAS com JSON válido no formato: ' +
  '{"doenca":"nome da doença mais provável","confianca":"alta/média/baixa","evidencia":"sinais visíveis na foto",' +
  '"sintomas":"descrição dos sintomas","causa":"causa provável","tratamento":"passo a passo do tratamento recomendado",' +
  '"medicamentos":["nome genérico do remédio 1","nome genérico do remédio 2"],' +
  '"dicas":"cuidados adicionais (quarentena, TPA, temperatura, sal)"}. ' +
  'Não invente doenças raras: priorize as mais comuns em aquário de água doce.';

const CATALOGO_DOENCAS = [
  { nome: 'Ictio (Ponto Branco/Ich)', sinonimos: 'ponto branco, ictioftiriase, white spot', sintomas: 'pontos brancos como sal pelo corpo', causa: 'Ichthyophthirius multifiliis', tratamento: 'elevar temperatura a 28-30 °C, verde de malaquita + azul de metileno, sal 1-3 g/L (evitar em peixes de pele nua)', medicamentos: ['verde de malaquita', 'azul de metileno'] },
  { nome: 'Oodínio (Veludo)', sinonimos: 'veludo, gold dust, ferrugem, velvet', sintomas: 'camada dourada aveludada, nadadeiras coladas', causa: 'Piscinoodinium pillulare', tratamento: 'medicamento com cobre ou verde de malaquita no escuro', medicamentos: ['verde de malaquita', 'sulfato de cobre'] },
  { nome: 'Fungo (Saprolegnia)', sinonimos: 'algodão, cotonete, saprolegnia', sintomas: 'tufos brancos de algodão na pele/boca', causa: 'Saprolegnia sobre ferimentos', tratamento: 'banho de sal grosso e antifúngico', medicamentos: ['verde de malaquita', 'azul de metileno'] },
  { nome: 'Podridão de Nadadeiras (Fin Rot)', sinonimos: 'cauda desfiada, fin rot', sintomas: 'nadadeiras esbranquiçadas e desfiadas', causa: 'Aeromonas/Pseudomonas', tratamento: 'TPA, filtragem e antibacteriano', medicamentos: ['nitrofurazona', 'oxitetraciclina'] },
  { nome: 'Hidropisia (Dropsy)', sinonimos: 'barriga inchada, escamas pinadas, pinecone', sintomas: 'abdômen distendido e escamas eriçadas', causa: 'infecção bacteriana interna', tratamento: 'isolar, TPA, antibacteriano e banho de sal amargo', medicamentos: ['oxitetraciclina', 'sal de aquário', 'sal amargo'] },
  { nome: 'Pop-eye (Olho Saltado)', sinonimos: 'exoftalmia, olho inchado', sintomas: 'olhos saltados da órbita', causa: 'bactéria, trauma ou gás', tratamento: 'TPA e antibacteriano', medicamentos: ['antibiótico de amplo espectro'] },
  { nome: 'Buracos na Cabeça (Hexamita)', sinonimos: 'hole in the head, craters', sintomas: 'buracos na cabeça e linha lateral', causa: 'Spironucleus (Hexamita)', tratamento: 'metronidazol e melhora da dieta', medicamentos: ['metronidazol'] },
  { nome: 'Tuberculose de Peixes', sinonimos: 'coluna curvada, mycobacterium', sintomas: 'coluna curvada e emagrecimento', causa: 'Mycobacterium spp.', tratamento: 'difícil; quarentena e antibiótico', medicamentos: ['kanamicina'] },
  { nome: 'Parasitas Externos (Piolho/Verme-Âncora)', sinonimos: 'argulus, lernaea, piolho de peixe', sintomas: 'parasitas visíveis e feridas', causa: 'Argulus/Lernaea', tratamento: 'remoção manual + antiparasitário', medicamentos: ['triclorfon', 'praziquantel'] },
  { nome: 'Problema de Bexiga Natatória', sinonimos: 'cabeça para baixo, afundando', sintomas: 'peixe sem equilíbrio na natação', causa: 'superalimentação/constipação', tratamento: 'jejum 2-3 dias, ervilha e banho de sal amargo', medicamentos: ['sal amargo', 'ervilha'] },
  { nome: 'Constipação (Prisão de Ventre)', sinonimos: 'prisao de ventre, constipado, sem fezes', sintomas: 'ventre inchado e fezes não eliminadas', causa: 'superalimentação e dieta seca', tratamento: 'jejum 2-3 dias, ervilha e banho de sal amargo (sulfato de magnésio) para estimular a evacuação', medicamentos: ['sal amargo', 'ervilha'] },
  { nome: 'Estresse/Letargia/Perda de Cor', sinonimos: 'apatia, desbotado, natas', sintomas: 'peixe parado e sem cor', causa: 'má qualidade da água', tratamento: 'água limpa, TPA, estabilidade', medicamentos: [] },
];

const CATALOGO_ALGAS = [
  { nome: 'Alga Marrom (Diatomáceas)', sinonimos: 'diatomácea, poeira marrom, brown algae', aspecto: 'poeira marrom nas superfícies, comum na ciclagem', causa: 'silicato e baixa luz', tratamento: 'desaparece com a estabilização; aumentar luz e adicionar otocinclus/caramujos', dicas: 'sifonar e usar água com baixo silicato' },
  { nome: 'Alga Peteca / Barba Negra (BBA)', sinonimos: 'peteca, barba negra, black beard algae', aspecto: 'tufos escuros rígidos nas bordas de folhas e troncos', causa: 'CO2 instável, matéria orgânica, circulação baixa', tratamento: 'carbono líquido (glutaraldeído) ou água oxigenada 10 vol com seringa, filtros desligados 10 min', dicas: 'comedor de algas siamês ajuda; estabilizar CO2' },
  { nome: 'Algas Verdes Filamentosas', sinonimos: 'hair algae, fios verdes', aspecto: 'fios verdes enroscados em plantas/decoração', causa: 'excesso de ferro/nitrato e luz longa', tratamento: 'remoção manual com escova, luz 6-7h/dia e TPAs', dicas: 'camarões amano comem essa alga' },
  { nome: 'Cianobactéria (Alga Verde-Azulada)', sinonimos: 'cianobactéria, BGA, gosma, slime', aspecto: 'película verde-azulada viscosa com cheiro de mofo', causa: 'pouca circulação e N:P desequilibrado', tratamento: 'sifonar, apagão total 3-4 dias; eritromicina em casos severos', dicas: 'melhorar circulação e reequilibrar nitrato/fosfato' },
];

const CATALOGO_MICRO = [
  { nome: 'Copépodes (Microcrustáceos)', sinonimos: 'pontinhos brancos, pulguinhas', aspecto: 'pontos brancos minúsculos saltitando no vidro', classificacao: 'benéfico', tratamento: 'nenhum; sinal de biologia saudável', dicas: 'servem de alimento vivo' },
  { nome: 'Planárias (Vermes Chatos)', sinonimos: 'planária, flatworm', aspecto: 'vermes achatados com cabeça triangular e olhos', classificacao: 'perigo para ovos e filhotes de camarão', tratamento: 'reduzir alimentação e usar armadilha ou extrato de betel (No-Planaria)', dicas: 'não fazer mal a peixes adultos' },
  { nome: 'Nematoides e Oligoquetas (Vermes de Vidro)', sinonimos: 'vermes finos, vermes de vidro', aspecto: 'vermes brancos finos ondulando no vidro/água', classificacao: 'inofensivo', tratamento: 'sifonar o fundo e reduzir ração', dicas: 'aparecem com excesso de matéria orgânica' },
  { nome: 'Hidras de Água Doce', sinonimos: 'hydra, mini-anêmonas', aspecto: 'mini-anêmonas transparentes com tentáculos', classificacao: 'perigo para alevinos e micro-camarões', tratamento: 'reduzir náuplios, caramujos pomácea ajudam; vermífugo específico', dicas: 'células urticantes nos tentáculos' },
];

function formatarCatalogoDoencas() {
  return CATALOGO_DOENCAS.map(
    (d) => `- ${d.nome} (${d.sinonimos}): ${d.sintomas}. Causa: ${d.causa}. Tratamento: ${d.tratamento}.`
  ).join('\n');
}

function formatarCatalogoAlgas() {
  return CATALOGO_ALGAS.map(
    (a) => `- ${a.nome} (${a.sinonimos}): aspecto ${a.aspecto}. Causa: ${a.causa}. Tratamento: ${a.tratamento}.`
  ).join('\n');
}

function formatarCatalogoMicro() {
  return CATALOGO_MICRO.map(
    (m) => `- ${m.nome} (${m.sinonimos}): aspecto ${m.aspecto}. Classificação: ${m.classificacao}. Ação: ${m.tratamento}.`
  ).join('\n');
}

function promptDiagnosticoComCatalogo() {
  return PROMPT_DIAGNOSTICO + '\n\nCruze a foto com ESTE catálogo de doenças comuns e priorize a que mais se encaixar:\n' + formatarCatalogoDoencas() + '\n\nReferência de boas práticas:\n' + GUIA_REFERENCIA;
}

function promptCronogramaComGuia() {
  return PROMPT_CRONOGRAMA + '\n\nReferência de boas práticas (manual Alcon):\n' + GUIA_REFERENCIA;
}

function promptSugestoesComGuia() {
  return PROMPT_SUGESTOES + '\n\nReferência de boas práticas (manual Alcon):\n' + GUIA_REFERENCIA;
}

const PROMPT_ALGAS =
  'Você é um especialista em aquarismo de água doce (aquascaping). Analise a foto de uma alga presente em um aquário ' +
  'de água doce e identifique entre as mais comuns. Responda APENAS com JSON válido no formato: ' +
  '{"alga":"nome da alga mais provável","confianca":"alta/média/baixa","sintomas":"como ela aparece (aspecto visual)",' +
  '"causa":"causa provável","tratamento":"passo a passo do tratamento recomendado","dicas":"cuidados de prevenção"}. ' +
  'Se a foto não mostrar uma alga claramente, responda alga igual a "não identificado" com sintomas vazios.';

const PROMPT_MICRO =
  'Você é um especialista em aquários de água doce. Analise o que o usuário observou (descrição em texto e/ou foto) e ' +
  'identifique o microorganismo ou verme mais provável entre os comuns em aquários. Responda APENAS com JSON válido no formato: ' +
  '{"organismo":"nome do organismo mais provável","confianca":"alta/média/baixa","descricao":"como ele se apresenta",' +
  '"classificacao":"benéfico / inofensivo / atenção / perigo","acao":"explicação do que ele faz e se precisa agir",' +
  '"tratamento":"medida recomendada","dicas":"cuidados de prevenção"}. ' +
  'Se a informação for insuficiente, responda organismo igual a "não identificado" com descricao vazia.';

function promptAlgasComCatalogo() {
  return PROMPT_ALGAS + '\n\nCruze a foto com ESTE catálogo de algas comuns:\n' + formatarCatalogoAlgas();
}

function promptMicroComCatalogo() {
  return PROMPT_MICRO + '\n\nCruze com ESTE catálogo de microorganismos comuns:\n' + formatarCatalogoMicro();
}

const PALAVRAS_INVERTEBRADOS = [
  'camarao', 'camarão', 'camaroes', 'caramujo', 'caramujos', 'lagosta', 'lagostas',
  'lagostim', 'lagostins', 'siri', 'siris', 'caranguejo', 'caranguejos',
  'ampularia', 'ampulária', 'neritina', 'planorbis', 'ramshorn', 'assassino',
  'amano', 'cherry', 'red cherry', 'neocaridina', 'caridina', 'crayfish',
  'pomacea', 'invertebrado', 'invertebrados', 'crab', 'crabes', 'geosesarma',
];

const PALAVRAS_AXOLOTE = ['axolote', 'axolotl', 'ambystoma', 'salamandra'];

function detectarFaunaSensivel(fauna) {
  const nomes = (fauna || [])
    .map((f) => `${f.nomeComum || ''} ${f.nome || ''} ${f.nomeCientifico || ''}`)
    .join(' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const temInvertebrado = PALAVRAS_INVERTEBRADOS.some((p) => nomes.includes(p));
  const temAxolote = PALAVRAS_AXOLOTE.some((p) => nomes.includes(p));
  return { temInvertebrado, temAxolote };
}

function produtoTemComposto(item, tipo) {
  const texto = `${item.nome || ''} ${item.tipo || ''} ${item.principios || item.princípios || ''} ${item.indicacao || ''} ${item.uso || ''}`;
  const n = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (tipo === 'carbon') {
    return (
      /(^|\s)(carbon|carbono)(\s|$)/.test(n) ||
      /\bglutaraldeido\b/.test(n) ||
      /\beasy\s*carbo\b/.test(n) ||
      /\beasycarbo\b/.test(n) ||
      /\bbiotope\s*carbon\b/.test(n) ||
      /\bexcel\b/.test(n)
    );
  }
  if (tipo === 'cobre') {
    return /\bsulfato de cobre\b/.test(n) || /\bcobre\b/.test(n) || /\bcopper\b/.test(n);
  }
  return false;
}

function filtrarCronogramaSeguro(resultado, fertilizantesEstoque, fauna) {
  if (!resultado) return resultado;
  const { temInvertebrado, temAxolote } = detectarFaunaSensivel(fauna);
  if (!temInvertebrado && !temAxolote) return resultado;

  const fertilizantes = Array.isArray(resultado.fertilizantes) ? resultado.fertilizantes : [];
  const removidos = [];
  const seguros = [];
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  for (const fert of fertilizantes) {
    const itemEstoque = (fertilizantesEstoque || []).find(
      (f) => norm(f.nome) === norm(fert.produto) || norm(fert.produto).includes(norm(f.nome)) || norm(f.nome).includes(norm(fert.produto))
    );
    const nomeProduto = itemEstoque || fert;
    const ehCarbon = produtoTemComposto(nomeProduto, 'carbon');
    const ehCobre = produtoTemComposto(nomeProduto, 'cobre');

    if ((ehCarbon && (temAxolote || temInvertebrado)) || (ehCobre && temInvertebrado)) {
      removidos.push(`${fert.produto}${ehCarbon ? ' (carbono líquido/glutaraldeído)' : ' (cobre)'}`);
    } else {
      seguros.push(fert);
    }
  }

  if (removidos.length === 0) return resultado;

  const motivoBase = temInvertebrado && temAxolote
    ? 'há axolote e invertebrados na fauna'
    : temAxolote
    ? 'há axolote na fauna'
    : 'há invertebrados (camarões, caramujos, lagostas, siris) na fauna';

  const mensagem = `Produto(s) removido(s) por segurança da fauna: ${removidos.join(', ')}. Como ${motivoBase}, esse produto é tóxico e foi retirado do cronograma.`;

  return {
    ...resultado,
    fertilizantes: seguros,
    alerta: {
      temAlerta: true,
      titulo: '⚠️ Fertilizante removido por segurança',
      mensagem,
    },
    resumo: `${resultado.resumo || ''} (${mensagem})`,
  };
}

function diagnosticarPorDescricao(descricao) {
  const t = String(descricao || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  for (const d of CATALOGO_DOENCAS) {
    const sinonimos = String(d.sinonimos || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (sinonimos.some((s) => t.includes(s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')))) {
      return d;
    }
  }
  return null;
}

async function diagnosticarComIA(imagem, estoqueMedicamentos, descricao, faunaSensivel) {
  const erros = [];
  const textoMedicamentos =
    (estoqueMedicamentos || []).length > 0
      ? estoqueMedicamentos.map((m, i) => `${i + 1}. ${m.nome} (${m.marca})`).join('; ')
      : 'nenhum';
  const textoDescricao = descricao
    ? `\nDescrição do usuário sobre o que observa no peixe: "${descricao.trim()}".`
    : '';
  const textoFaunaSensivel =
    faunaSensivel && (faunaSensivel.temInvertebradoFauna || faunaSensivel.temAxoloteFauna)
      ? `\nFauna sensível presente nos aquários do usuário: ${faunaSensivel.temInvertebradoFauna ? 'invertebrados (caramujos, camarões, lagostas, siris)' : ''}${faunaSensivel.temInvertebradoFauna && faunaSensivel.temAxoloteFauna ? ' e ' : ''}${faunaSensivel.temAxoloteFauna ? 'axolote(s)' : ''}. Se o tratamento indicado usar verde de malaquita ou cobre, oriente SEMPRE a retirada dos invertebrados/axolote do aquário antes de tratar.`
      : '';
  const userText = `Medicamentos disponíveis no estoque do usuário: ${textoMedicamentos}.${textoDescricao}${textoFaunaSensivel} Analise a foto (se houver) e diagnostique, comparando os sinais com o catálogo.`;

  if (process.env.GEMINI_API_KEY) {
    try {
      const base64 = imagem && imagem.includes('base64,') ? imagem.split('base64,')[1] : imagem;
      const prefixo = imagem && imagem.match(/^data:([^;]+);base64,/) ? imagem.match(/^data:([^;]+);base64,/)[1] : 'image/jpeg';
      const parts = [];
      if (base64) parts.push({ inline_data: { mime_type: prefixo, data: base64 } });
      parts.push({ text: userText });
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-3.5-flash'}:generateContent`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(AI_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts,
              },
            ],
            systemInstruction: { parts: [{ text: promptDiagnosticoComCatalogo() }] },
            generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 800 },
          }),
        }
      );
      if (!res.ok) {
        const texto = await res.text().catch(() => '');
        throw new Error(`Gemini diagnóstico (HTTP ${res.status}): ${texto.slice(0, 300)}`);
      }
      const json = await res.json();
      const conteudo = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
      if (!conteudo) throw new Error('Gemini diagnóstico: resposta vazia');
      return JSON.parse(conteudo);
    } catch (e) {
      console.error('Falha Gemini (diagnóstico):', e.message);
      erros.push(`Gemini: ${e.message}`);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const content = [];
      if (imagem) content.push({ type: 'image_url', image_url: { url: imagem } });
      content.push({ type: 'text', text: userText });
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          max_tokens: 800,
          messages: [
            { role: 'system', content: promptDiagnosticoComCatalogo() },
            { role: 'user', content },
          ],
        }),
      });
      if (!res.ok) {
        const texto = await res.text().catch(() => '');
        throw new Error(`OpenAI diagnóstico (HTTP ${res.status}): ${texto.slice(0, 300)}`);
      }
      const json = await res.json();
      const conteudo = json.choices?.[0]?.message?.content;
      if (!conteudo) throw new Error('OpenAI diagnóstico: resposta vazia');
      return JSON.parse(conteudo);
    } catch (e) {
      console.error('Falha OpenAI (diagnóstico):', e.message);
      erros.push(`OpenAI: ${e.message}`);
    }
  }

  const configuradas = semChaves().join(', ');
  throw new Error(
    configuradas
      ? `Nenhum provedor conseguiu diagnosticar.\n\n${erros.join('\n')}`
      : 'Nenhuma chave configurada no servidor (.env).'
  );
}

async function viaIAVision({ imagem, systemPrompt, userText }) {
  const erros = [];
  const base64 = imagem && imagem.includes('base64,') ? imagem.split('base64,')[1] : imagem || null;
  const prefixo = imagem
    ? imagem.match(/^data:([^;]+);base64,/)
      ? imagem.match(/^data:([^;]+);base64,/)[1]
      : 'image/jpeg'
    : null;
  const dataUrl = base64 && prefixo ? `data:${prefixo};base64,${base64}` : null;

  if (process.env.GEMINI_API_KEY) {
    try {
      const modelo = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
      const parts = [];
      if (base64 && prefixo) parts.push({ inline_data: { mime_type: prefixo, data: base64 } });
      parts.push({ text: userText });
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(AI_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 800 },
          }),
        }
      );
      if (!res.ok) {
        const texto = await res.text().catch(() => '');
        throw new Error(`Gemini (HTTP ${res.status}): ${texto.slice(0, 300)}`);
      }
      const json = await res.json();
      const conteudo = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
      if (!conteudo) throw new Error('Gemini: resposta vazia');
      return JSON.parse(conteudo);
    } catch (e) {
      console.error('Falha Gemini (visão):', e.message);
      erros.push(`Gemini: ${e.message}`);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const content = [];
      if (dataUrl) content.push({ type: 'image_url', image_url: { url: dataUrl } });
      content.push({ type: 'text', text: userText });
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          max_tokens: 800,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content },
          ],
        }),
      });
      if (!res.ok) {
        const texto = await res.text().catch(() => '');
        throw new Error(`OpenAI (HTTP ${res.status}): ${texto.slice(0, 300)}`);
      }
      const json = await res.json();
      const conteudo = json.choices?.[0]?.message?.content;
      if (!conteudo) throw new Error('OpenAI: resposta vazia');
      return JSON.parse(conteudo);
    } catch (e) {
      console.error('Falha OpenAI (visão):', e.message);
      erros.push(`OpenAI: ${e.message}`);
    }
  }

  const configuradas = semChaves().join(', ');
  throw new Error(
    configuradas
      ? `Nenhum provedor conseguiu analisar.\n\n${erros.join('\n')}`
      : 'Nenhuma chave configurada no servidor (.env).'
  );
}

async function validarCenaAquario({ base64, prefixo, dataUrl, errosValidacao }) {
  let valida = false;
  let motivo = '';
  const provedores = semChavesValidacao();
  if (provedores.length === 0) return { valida: true, motivo: '' };

  if (process.env.GEMINI_API_KEY) {
    try {
      const r = await validarFotoGemini(base64, prefixo, PROMPT_VALIDACAO_AQUARIO);
      valida = r.valida;
      motivo = r.motivo || '';
    } catch (e) {
      console.error('Falha Gemini (validação):', e.message);
      errosValidacao.push(`Gemini: ${e.message}`);
    }
  }
  if (!valida && process.env.OPENAI_API_KEY) {
    try {
      const r = await validarFotoOpenAI(dataUrl, PROMPT_VALIDACAO_AQUARIO);
      valida = r.valida;
      motivo = r.motivo || '';
    } catch (e) {
      console.error('Falha OpenAI (validação):', e.message);
      errosValidacao.push(`OpenAI: ${e.message}`);
    }
  }
  return { valida, motivo, falhouTudo: errosValidacao.length > 0 && errosValidacao.length === provedores.length };
}

async function gerarCronogramaComIA(pergunta) {
  const erros = [];

  if (process.env.GEMINI_API_KEY) {
    try {
      const modelo = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
      const resIA = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(AI_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': process.env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: pergunta }] }],
            systemInstruction: { parts: [{ text: promptCronogramaComGuia() }] },
            generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1200 },
          }),
        }
      );
      if (!resIA.ok) {
        const texto = await resIA.text().catch(() => '');
        throw new Error(`Gemini cronograma (HTTP ${resIA.status}): ${texto.slice(0, 300)}`);
      }
      const json = await resIA.json();
      const conteudo = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
      if (!conteudo) throw new Error('Gemini cronograma: resposta vazia');
      const dados = JSON.parse(conteudo);
      return montarResultadoCronograma(dados);
    } catch (e) {
      console.error('Falha Gemini (cronograma):', e.message);
      erros.push(`Gemini: ${e.message}`);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const resIA = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          max_tokens: 1200,
          messages: [
            { role: 'system', content: promptCronogramaComGuia() },
            { role: 'user', content: pergunta },
          ],
        }),
      });
      if (!resIA.ok) {
        const texto = await resIA.text().catch(() => '');
        throw new Error(`OpenAI cronograma (HTTP ${resIA.status}): ${texto.slice(0, 300)}`);
      }
      const json = await resIA.json();
      const conteudo = json.choices?.[0]?.message?.content;
      if (!conteudo) throw new Error('OpenAI cronograma: resposta vazia');
      const dados = JSON.parse(conteudo);
      return montarResultadoCronograma(dados);
    } catch (e) {
      console.error('Falha OpenAI (cronograma):', e.message);
      erros.push(`OpenAI: ${e.message}`);
    }
  }

  const configuradas = semChaves().join(', ');
  throw new Error(
    configuradas
      ? `Nenhum provedor conseguiu montar o cronograma.\n\n${erros.join('\n')}`
      : 'Nenhuma chave configurada no servidor (.env).'
  );
}

app.post('/cronograma-alimentar', async (req, res) => {
  const { aquario, fauna, flora, estoque, tpaDia } = req.body || {};

  if ((!fauna || fauna.length === 0) && !aquario) {
    return res.status(400).json({
      erro: 'O aquário não tem fauna. Adicione peixes à composição para montar o cronograma alimentar.',
    });
  }
  if (!fauna || fauna.length === 0) {
    return res.status(400).json({
      erro: 'O aquário não tem fauna. Adicione peixes à composição para montar o cronograma alimentar.',
    });
  }

  const infoAquario = aquario || {};
  const litros = infoAquario.litros || '';
  const alimentos = (estoque || []).filter((i) => i.categoria === 'alimentos');
  const fertilizantes = (estoque || []).filter((i) => i.categoria === 'fertilizantes');

  const descricaoAquario =
    `Nome: ${infoAquario.nome || 'Aquário'}. ` +
    `Tipo: ${infoAquario.tipo || 'não informado'}. ` +
    `Capacidade: ${litros ? `${litros} L` : 'não informada'}. ` +
    `Plantado: ${infoAquario.ehPlantado || 'não informado'}. ` +
    `CO2: ${infoAquario.usaCO2 || 'não informado'}.`;

  const textoFauna = (fauna || [])
    .map((f, i) => {
      const qtd = f.quantidade ? ` (${f.quantidade}x)` : '';
      return `${i + 1}. ${f.nomeComum || f.nome || 'Peixe'}${qtd}` +
        (f.nomeCientifico ? ` | Nome científico: ${f.nomeCientifico}` : '') +
        (f.dieta ? ` | Dieta: ${f.dieta}` : '');
    })
    .join('; ');

  const textoFlora = (flora || [])
    .map((f, i) => {
      const qtd = f.quantidade ? ` (${f.quantidade}x)` : '';
      return `${i + 1}. ${f.nomeComum || f.nome || 'Planta'}${qtd}`;
    })
    .join('; ');

  const textoAlimentos = alimentos
    .map((a, i) => {
      const qtd = a.quantidade ? ` (${a.quantidade} un)` : '';
      const specs = [
        a.tipo ? `Tipo: ${a.tipo}` : '',
        a.indicacao ? `Indicação do fabricante: ${a.indicacao}` : '',
        a.principios ? `Princípios ativos: ${a.principios}` : '',
        a.uso ? `Modo de uso: ${a.uso}` : '',
      ]
        .filter(Boolean)
        .join(' | ');
      return `${i + 1}. ${a.nome} (${a.marca})${qtd}${specs ? ` | ${specs}` : ''}`;
    })
    .join('; ');

  const textoFertilizantes = fertilizantes
    .map((f, i) => {
      const qtd = f.quantidade ? ` (${f.quantidade} un)` : '';
      return `${i + 1}. ${f.nome} (${f.marca})${qtd} | Tipo: ${f.tipo || '?'}`;
    })
    .join('; ');

  const temFlora = (flora || []).length > 0;
  const tpaValida = tpaDia && /^(Segunda-feira|Terça-feira|Quarta-feira|Quinta-feira|Sexta-feira|Sábado|Domingo)$/.test(tpaDia)
    ? tpaDia
    : '';

  const pergunta =
    `${descricaoAquario}\n` +
    `Peixes no aquário: ${textoFauna || 'nenhum'}\n` +
    `Plantas no aquário: ${textoFlora || 'nenhuma'}\n` +
    `Rações disponíveis no estoque: ${textoAlimentos || 'nenhuma'}\n` +
    `Fertilizantes disponíveis no estoque: ${temFlora ? (textoFertilizantes || 'nenhum') : 'não se aplica (aquário sem plantas)'}\n` +
    (tpaValida ? `TPA fixa na semana: ${tpaValida} (neste dia o peixe deve ficar em jejum).\n` : '') +
    'Monte o cronograma semanal de alimentação (e fertilização, apenas se houver plantas) usando APENAS esses produtos.';

  console.log(
    `[cronograma-alimentar] fauna=${(fauna || []).length} | flora=${(flora || []).length} | alimentos=${alimentos.length} | fert=${fertilizantes.length} | tpa=${tpaValida || 'não'}`
  );

  try {
    const resultado = await gerarCronogramaComIA(pergunta);
    return res.json(filtrarCronogramaSeguro(resultado, fertilizantes, fauna));
  } catch (e) {
    return res.status(502).json({ erro: e.message });
  }
});

async function enriquecerComWikipedia(resultado) {
  try {
    const nome = resultado.nomeCientifico || resultado.nomeComum;
    if (!nome || nome.includes('—') || nome === 'Não identificado') return resultado;
    const dados = await enriquecerWikipedia(nome);
    if (!dados) return resultado;
    return {
      ...resultado,
      nomeComum: resultado.nomeComum !== 'Planta identificada' ? resultado.nomeComum : dados.nomeComum || resultado.nomeComum,
      familia: resultado.familia && resultado.familia !== '—' ? resultado.familia : dados.familia || resultado.familia,
      origem: resultado.origem && resultado.origem !== '—' ? resultado.origem : dados.origem || resultado.origem,
      tamanho: resultado.tamanho && resultado.tamanho !== '—' ? resultado.tamanho : dados.tamanho || resultado.tamanho,
      observacoes: dados.observacoes || resultado.observacoes,
      foto: resultado.foto || dados.foto || '',
      urlWikipedia: dados.urlWikipedia || '',
    };
  } catch (e) {
    console.error('Falha ao enriquecer com Wikipedia:', e.message);
    return resultado;
  }
}

async function viaPlantNet(base64, mime) {
  const buffer = Buffer.from(base64, 'base64');
  const extensao = mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : 'jpg';
  const boundary = `----aquariapp${Date.now()}`;
  const bodyParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="organs"\r\n\r\nauto\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="foto.${extensao}"\r\nContent-Type: ${mime}\r\n\r\n`,
  ];
  const body = Buffer.concat([
    Buffer.from(bodyParts[0], 'utf8'),
    Buffer.from(bodyParts[1], 'utf8'),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  const res = await fetch(
    `https://my-api.plantnet.org/v2/identify/all?api-key=${encodeURIComponent(process.env.PLANTNET_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    }
  );
  if (!res.ok) {
    const corpo = await res.text().catch(() => '');
    console.error('PlantNet HTTP', res.status, '| corpo:', corpo.slice(0, 400));
    throw new Error(`PlantNet (HTTP ${res.status}): ${corpo.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.results || json.results.length === 0) throw new Error('PlantNet: nenhum resultado');
  const melhores = json.results.slice(0, 5);

  const montar = (item) => {
    const score = Math.round((item.score || 0) * 100);
    const nomeCientifico =
      item.species?.scientificNameWithoutAuthor || item.species?.scientificName || '';
    const sinonimos = item.species?.commonNames || [];
    const familia = item.species?.family?.scientificName || '—';
    return normalizarResultado({
      provedor: 'PlantNet',
      confianca: score,
      tipo: 'flora',
      nomeComum: sinonimos[0] || 'Planta identificada',
      nomeCientifico,
      familia,
      observacoes: `Confiança de ${score}% segundo a base do PlantNet.`,
    });
  };

  const principal = await enriquecerComWikipedia(montar(melhores[0]));
  const opcoes = (
    await Promise.all(
      melhores.slice(1).map((item) => {
        const o = montar(item);
        if (o.nomeCientifico === principal.nomeCientifico) return null;
        return enriquecerComWikipedia(o);
      })
    )
  ).filter(Boolean);
  return { ...principal, opcoes };
}

function exigirAdmin(req, res) {
  if (autenticado(req)) return true;
  res.status(401).json({ erro: 'Chave de administração inválida.' });
  return false;
}

app.get('/ofertas', (req, res) => {
  const todas = listarOfertas();
  res.json(todas.filter((o) => o.ativo !== false));
});

app.get('/ofertas/todas', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  res.json(listarOfertas());
});

app.post('/ofertas', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const dados = req.body || {};
  if (!dados.tipo || !dados.titulo || !dados.lojista) {
    return res.status(400).json({
      erro: 'Campos obrigatórios: tipo, titulo e lojista.',
    });
  }
  res.status(201).json(criarOferta(dados));
});

app.put('/ofertas/:id', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const atualizada = atualizarOferta(req.params.id, req.body || {});
  if (!atualizada) return res.status(404).json({ erro: 'Oferta não encontrada.' });
  res.json(atualizada);
});

app.delete('/ofertas/:id', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const removida = removerOferta(req.params.id);
  if (!removida) return res.status(404).json({ erro: 'Oferta não encontrada.' });
  res.json({ ok: true });
});

// ============================ CONCURSOS ============================

const CONCURSOS_UPLOADS_DIR = path.join(__dirname, 'public', 'concursos');
if (!fs.existsSync(CONCURSOS_UPLOADS_DIR)) {
  fs.mkdirSync(CONCURSOS_UPLOADS_DIR, { recursive: true });
}
// Estado público: se o admin não ativou, retorna null (a seção não aparece no app).
app.get('/concursos', (req, res) => {
  const config = concursosStore.obterConfig();
  if (!config || config.ativo !== true) {
    return res.json({ ativo: false, config: null });
  }
  const agora = Date.now();
  let fase =
    agora < config.inscricaoDe
      ? 'aguarda_inscricao'
      : agora >= config.inscricaoDe && (!config.inscricaoAte || agora < config.inscricaoAte)
      ? 'inscricoes'
      : agora < config.votacaoDe
      ? 'aguarda_votacao'
      : config.votacaoAte && agora >= config.votacaoAte
      ? 'encerrado'
      : 'votacao';
  // Vencedor declarado → concurso "finalizado": todos veem o anúncio do vencedor.
  const ganhador = concursosStore.obterGanhador();
  if (ganhador) fase = 'finalizado';
  // Link de votação: usa o configurado ou gera automaticamente.
  const linkBase = `${urlBasePublica(req).replace(/\/$/, '')}/concurso/votacao`;
  const linkVotacao = String(config.linkVotacao || '').trim() || linkBase;
  // Na votação só aparecem inscrições APROVADAS pelo admin.
  const inscricoes = concursosStore
    .listarInscricoes()
    .filter((i) => i.status === 'aprovado')
    .map((i) => ({
      id: i.id,
      nome: i.nome || '',
      apelido: i.apelido || '',
      foto: i.foto || '',
      votos: i.votos || 0,
      // Link público da enquete com a foto do participante em destaque.
      linkVoto: `${linkBase}?votar=${i.id}`,
    }));
  // Status do dispositivo que está consultando (para o app mostrar "inscrito").
  const dispositivoId = String((req.query && req.query.dispositivoId) || '').trim();
  const meuStatus = dispositivoId ? concursosStore.statusDeDispositivo(dispositivoId) : null;
  res.json({
    ativo: true,
    config: {
      categoria: config.categoria || '',
      regra: config.regra || '',
      premio: config.premio || '',
      patrocinador: config.patrocinador || '',
      url: config.url || '',
      inscricaoDe: config.inscricaoDe || 0,
      inscricaoAte: config.inscricaoAte || 0,
      votacaoDe: config.votacaoDe || 0,
      votacaoAte: config.votacaoAte || 0,
      linkVotacao,
      ganhadorDeclarado: !!config.ganhadorDeclarado,
    },
    fase,
    inscricoes,
    meuStatus,
    ganhador: ganhador
      ? {
          inscricaoId: ganhador.inscricaoId,
          nome: ganhador.inscricao.nome || '',
          apelido: ganhador.inscricao.apelido || '',
          foto: ganhador.inscricao.foto || '',
          votos: ganhador.inscricao.votos || 0,
          premio: config.premio || '',
          declaradoEm: ganhador.declaradoEm || 0,
        }
      : null,
  });
});

// Serve as fotos das inscrições (e a página de votação). Registrado depois
// das rotas JSON para que GET /concursos (exato) caia na rota e os arquivos
// /concursos/<arquivo> sejam servidos da pasta pública.
app.use('/concursos', express.static(CONCURSOS_UPLOADS_DIR, { maxAge: '1d' }));

// Config + inscrições completas (painel do admin).
app.get('/concursos/admin', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  res.json({
    config: concursosStore.obterConfig(),
    inscricoes: concursosStore.listarInscricoes(),
    ganhador: concursosStore.obterGanhador(),
    historico: concursosStore.obterHistorico(),
  });
});

app.put('/concursos/config', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const c = req.body || {};
  const config = {
    ativo: c.ativo !== false,
    categoria: String(c.categoria || '').trim(),
    regra: String(c.regra || '').trim(),
    premio: String(c.premio || '').trim(),
    patrocinador: String(c.patrocinador || '').trim(),
    url: String(c.url || '').trim(),
    inscricaoDe: Number(c.inscricaoDe) || 0,
    inscricaoAte: Number(c.inscricaoAte) || 0,
    votacaoDe: Number(c.votacaoDe) || 0,
    votacaoAte: Number(c.votacaoAte) || 0,
    linkVotacao: String(c.linkVotacao || '').trim(),
    ganhadorDeclarado: !!c.ganhadorDeclarado,
  };
  concursosStore.salvarConfig(config);
  res.json({ ok: true, config });
});

// Envio de inscrição com foto. A foto é validada (só aquários de água doce) e
// exige confirmação de propriedade. A inscrição entra como "pendente" e só
// participa da votação depois que o admin aprovar.
app.post('/concursos/inscricao', async (req, res) => {
  const config = concursosStore.obterConfig();
  if (!config || config.ativo !== true) {
    return res.status(400).json({ erro: 'O concurso não está ativo.' });
  }
  const agora = Date.now();
  if (agora < config.inscricaoDe || (config.inscricaoAte && agora > config.inscricaoAte)) {
    return res.status(400).json({ erro: 'As inscrições não estão abertas neste momento.' });
  }
  const { imagem, nome, apelido, consentimento, dispositivoId } = req.body || {};
  if (!imagem || typeof imagem !== 'string') {
    return res.status(400).json({ erro: 'Envie a foto do aquário (imagem).' });
  }
  if (!String(nome || '').trim()) {
    return res.status(400).json({ erro: 'Informe o nome do participante.' });
  }
  if (consentimento !== true) {
    return res.status(400).json({
      codigo: 'CONSENTIMENTO_OBRIGATORIO',
      erro: 'Confirme que a foto enviada é de um aquário de sua propriedade.',
    });
  }
  // Uma inscrição por dispositivo. Se a anterior foi REJEITADA e ainda está no
  // período de inscrições, o usuário pode reenviar outra foto (substitui a antiga
  // e volta para "em avaliação").
  const dispositivoNorm = String(dispositivoId || '').trim();
  const inscricaoAnterior =
    concursosStore.listarInscricoes().find((i) => String(i.dispositivoId || '') === dispositivoNorm) || null;
  if (inscricaoAnterior && inscricaoAnterior.status !== 'rejeitado') {
    return res.status(400).json({ erro: 'JÁ_INSCRITO', motivo: 'Este dispositivo já enviou uma foto para o concurso.' });
  }

  const base64 = imagem.includes('base64,') ? imagem.split('base64,')[1] : imagem;
  const prefixo = imagem.match(/^data:([^;]+);base64,/) ? imagem.match(/^data:([^;]+);base64,/)[1] : 'image/jpeg';
  const dataUrl = `data:${prefixo};base64,${base64}`;

  // Validação: só fotos do AQUÁRIO INTEIRO (concurso). Os provedores de IA rodam
  // em paralelo para responder rápido — se qualquer um aprovar, a foto passa.
  const provedores = semChavesValidacao();
  let valida = false;
  let motivo = '';
  if (provedores.length > 0) {
    const tentativas = [];
    if (process.env.GEMINI_API_KEY) tentativas.push(validarFotoGemini(base64, prefixo, PROMPT_VALIDACAO_CONCURSO));
    if (process.env.OPENAI_API_KEY) tentativas.push(validarFotoOpenAI(dataUrl, PROMPT_VALIDACAO_CONCURSO));
    const resultados = await Promise.allSettled(tentativas);
    for (const r of resultados) {
      if (r.status === 'fulfilled') {
        if (r.value.valida) {
          valida = true;
          break;
        }
        if (!motivo) motivo = r.value.motivo || '';
      } else {
        console.error('Falha validação (concurso):', r.reason?.message);
      }
    }
    if (!valida) {
      return res.status(422).json({
        codigo: 'foto_invalida',
        erro: motivo || 'A foto precisa mostrar o aquário inteiro em cena, não apenas um peixe.',
      });
    }
  }

  const extensao = extensaoPorMime(prefixo);
  const nomeArquivo = `concurso-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${extensao}`;
  try {
    fs.writeFileSync(path.join(CONCURSOS_UPLOADS_DIR, nomeArquivo), Buffer.from(base64, 'base64'));
  } catch (e) {
    console.error('Falha ao salvar foto do concurso:', e.message);
    return res.status(500).json({ erro: 'Não foi possível salvar a foto.' });
  }
  const fotoUrl = `${urlBasePublica(req).replace(/\/$/, '')}/concursos/${nomeArquivo}`;

  const nomeParticipante = String(nome).trim();
  let inscricao;
  if (inscricaoAnterior) {
    // Reenvio: apaga a foto antiga, grava a nova e volta para "em avaliação".
    const arquivoAntigo = String(inscricaoAnterior.foto || '').split('/').pop();
    if (arquivoAntigo && /^concurso-.*\.\w+$/.test(arquivoAntigo)) {
      try {
        fs.unlinkSync(path.join(CONCURSOS_UPLOADS_DIR, arquivoAntigo));
      } catch (e) {
        console.warn('Falha ao remover foto antiga do concurso:', e.message);
      }
    }
    inscricao = concursosStore.atualizarInscricao(inscricaoAnterior.id, {
      foto: fotoUrl,
      status: 'pendente',
      criadoEm: Date.now(),
      motivo: '',
      rejeitadoEm: 0,
    });
  } else {
    inscricao = concursosStore.criarInscricao({
      nome: nomeParticipante,
      apelido: String(apelido || '').trim() || nomeParticipante,
      dispositivoId: dispositivoNorm,
      foto: fotoUrl,
      consentimento: true,
      status: 'pendente',
    });
  }
  res.status(201).json({ ok: true, inscricao: { id: inscricao.id, foto: inscricao.foto, status: 'pendente' } });
});

// Votação: 1 voto por dispositivo.
app.post('/concursos/votar', (req, res) => {
  const config = concursosStore.obterConfig();
  if (!config || config.ativo !== true) {
    return res.status(400).json({ erro: 'O concurso não está ativo.' });
  }
  const agora = Date.now();
  if (agora < config.votacaoDe || (config.votacaoAte && agora > config.votacaoAte)) {
    return res.status(400).json({ erro: 'A votação não está aberta neste momento.' });
  }
  const { inscricaoId, dispositivoId } = req.body || {};
  if (!inscricaoId || !dispositivoId) {
    return res.status(400).json({ erro: 'Informe a inscrição e o dispositivo.' });
  }
  const r = concursosStore.registrarVoto(inscricaoId, dispositivoId);
  if (!r.ok) {
    return res.status(400).json({ erro: r.motivo, jaVotou: !!r.jaVotou });
  }
  res.json({ ok: true });
});

// Admin aprova o ganhador.
app.post('/concursos/ganhador', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const { inscricaoId } = req.body || {};
  const g = concursosStore.definirGanhador(inscricaoId);
  if (!g) return res.status(404).json({ erro: 'Inscrição não encontrada.' });
  res.json({ ok: true, ganhador: g });
});

// Admin encerra o concurso: apaga as fotos e guarda apenas a memória da
// categoria + vencedor. Tudo volta ao normal para os usuários (banner some).
app.post('/concursos/encerrar', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const config = concursosStore.obterConfig() || {};
  const inscricoes = concursosStore.listarInscricoes();
  const ganhador = concursosStore.obterGanhador();
  for (const i of inscricoes) {
    const arquivo = String(i.foto || '').split('/').pop();
    if (arquivo && /^concurso-.*\.\w+$/.test(arquivo)) {
      try {
        fs.unlinkSync(path.join(CONCURSOS_UPLOADS_DIR, arquivo));
      } catch (e) {
        console.warn('Falha ao apagar foto ao encerrar concurso:', e.message);
      }
    }
  }
  const historico = concursosStore.encerrarConcurso({
    categoria: config.categoria || '',
    premio: config.premio || '',
    encerradoEm: Date.now(),
    ganhador: ganhador
      ? {
          nome: ganhador.inscricao.nome || '',
          apelido: ganhador.inscricao.apelido || '',
          votos: ganhador.inscricao.votos || 0,
          premio: config.premio || '',
        }
      : null,
  });
  res.json({ ok: true, historico });
});

// Lê a foto da inscrição (arquivo em CONCURSOS_UPLOADS_DIR) e a devolve como
// data URL. Isso deixa a página de exportação auto-contida (funciona até com o
// CSP do helmet, que só permite img-src 'self' data: https:).
function fotoParaDataUrl(url) {
  if (!url) return '';
  const arquivo = String(url).split('/').pop();
  if (!arquivo || !/^concurso-.*\.\w+$/.test(arquivo)) return url;
  try {
    const buf = fs.readFileSync(path.join(CONCURSOS_UPLOADS_DIR, arquivo));
    const mime = /\.png$/i.test(arquivo)
      ? 'image/png'
      : /\.webp$/i.test(arquivo)
      ? 'image/webp'
      : /\.gif$/i.test(arquivo)
      ? 'image/gif'
      : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn('Falha ao ler foto para exportação:', e.message);
    return url;
  }
}

// Registro das fotos aprovadas para a votação (exportação). Abre uma página
// com todas as fotos aprovadas (nome + votos), pronta para imprimir/salvar.
app.get('/concursos/admin/exportar-votacao', (req, res) => {
  const chave = req.get('X-Admin-Key') || String((req.query && req.query.chave) || '');
  if (!chave || chave !== ADMIN_KEY) {
    return res.status(401).send('Chave de administração inválida.');
  }
  const config = concursosStore.obterConfig() || {};
  const ganhador = concursosStore.obterGanhador();
  const inscricoes = concursosStore
    .listarInscricoes()
    .filter((i) => i.status === 'aprovado')
    .sort((a, b) => (b.votos || 0) - (a.votos || 0));
  const cards = inscricoes
    .map((i) => {
      const src = i.foto ? fotoParaDataUrl(i.foto) : '';
      return `
      <div class="card">
        ${src ? `<img src="${src}" alt="Foto do participante" />` : ''}
        <div class="card-body">
          <p class="card-name">${(i.nome || '').replace(/</g, '&lt;')}${i.apelido && i.apelido !== i.nome ? ` <span class="apelido">@${(i.apelido || '').replace(/</g, '&lt;')}</span>` : ''}</p>
          <p class="card-votos">${i.votos || 0} votos</p>
        </div>
      </div>`;
    })
    .join('');
  const ganhadorHtml = ganhador
    ? `
      <div class="ganhador">
        <div class="ganhador-titulo">🏆 VENCEDOR</div>
        ${fotoParaDataUrl(ganhador.inscricao.foto) ? `<img src="${fotoParaDataUrl(ganhador.inscricao.foto)}" alt="Vencedor" />` : ''}
        <div class="ganhador-nome">${(ganhador.inscricao.nome || '').replace(/</g, '&lt;')}</div>
        <div class="ganhador-votos">${ganhador.inscricao.votos || 0} votos</div>
      </div>`
    : '';
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Registro de Votação — ${(config.categoria || 'Concurso').replace(/</g, '&lt;')}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font-family: system-ui, sans-serif; background: #f4f7fb; color: #10243d; }
  .topo { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  h1 { font-size: 20px; margin: 0; }
  .sub { color: #5b7a99; font-size: 13px; margin: 2px 0 0; }
  .acoes { display: flex; gap: 8px; }
  button { background: #0b2e4f; color: #fff; border: none; border-radius: 8px; padding: 9px 16px; font-weight: 800; cursor: pointer; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .card { background: #fff; border: 1px solid #c7d9ea; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(16,36,61,0.08); }
  .card img { width: 100%; height: 160px; object-fit: cover; display: block; }
  .card-body { padding: 8px 10px; }
  .card-name { margin: 0; font-weight: 800; font-size: 14px; }
  .apelido { color: #0b2e4f; font-weight: 700; font-size: 12px; }
  .card-votos { margin: 2px 0 0; color: #5b7a99; font-size: 12px; }
  .ganhador { background: #fff7e6; border: 2px solid #FFC857; border-radius: 12px; padding: 14px; text-align: center; margin-bottom: 14px; }
  .ganhador-titulo { font-weight: 900; color: #d98324; }
  .ganhador img { max-width: 320px; width: 100%; border-radius: 10px; margin: 8px 0; }
  .ganhador-nome { font-size: 20px; font-weight: 900; }
  .ganhador-votos { color: #5b7a99; font-size: 13px; }
  .vazio { color: #5b7a99; font-size: 13px; }
  @media print { .acoes { display: none; } button { display: none; } body { background: #fff; } }
</style>
</head>
<body>
  <div class="topo">
    <div>
      <h1>📸 Registro de Votação — ${(config.categoria || 'Concurso').replace(/</g, '&lt;')}</h1>
      <p class="sub">${config.premio ? `Prêmio: ${(config.premio || '').replace(/</g, '&lt;')}` : ''} · Emitido em ${new Date().toLocaleString('pt-BR')}</p>
    </div>
    <div class="acoes"><button onclick="window.print()">🖨️ Imprimir / Salvar PDF</button></div>
  </div>
  ${ganhadorHtml}
  <h2>Fotos aprovadas (${inscricoes.length})</h2>
  ${inscricoes.length === 0 ? '<p class="vazio">Nenhuma foto aprovada.</p>' : `<div class="grid">${cards}</div>`}
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ============ MODERAÇÃO DE INSCRIÇÕES (admin) ============
// O admin revisa cada inscrição antes da votação. Só inscrições "aprovadas"
// aparecem no app e no link público de votação.

// Aprova uma inscrição (está dentro das regras → participa da votação).
app.post('/concursos/aprovar', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const { inscricaoId } = req.body || {};
  const inscricao = concursosStore.atualizarInscricao(inscricaoId, { status: 'aprovado' });
  if (!inscricao) return res.status(404).json({ erro: 'Inscrição não encontrada.' });
  res.json({ ok: true, inscricao });
});

// Rejeita uma inscrição (não segue as regras → não aparece na votação).
// O motivo é gravado e enviado ao participante pelo app.
app.post('/concursos/rejeitar', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const { inscricaoId, motivo } = req.body || {};
  const inscricao = concursosStore.atualizarInscricao(inscricaoId, {
    status: 'rejeitado',
    motivo: String(motivo || '').trim(),
    rejeitadoEm: Date.now(),
  });
  if (!inscricao) return res.status(404).json({ erro: 'Inscrição não encontrada.' });
  res.json({ ok: true, inscricao });
});

// Remove por completo uma inscrição (ex.: conteúdo impróprio).
app.delete('/concursos/inscricao/:id', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const removido = concursosStore.removerInscricao(req.params.id);
  if (!removido) return res.status(404).json({ erro: 'Inscrição não encontrada.' });
  res.json({ ok: true });
});

// ============================ FIM CONCURSOS ============================

// ============================ TELEMETRIA ============================

// Recebe um evento de uso de seção (ex.: usuário abriu o Identificador).
app.post('/telemetria/secao', (req, res) => {
  const { secao } = req.body || {};
  const nome = String(secao || '').trim();
  if (!nome) return res.status(400).json({ erro: 'Envie o campo "secao".' });
  telemetriaStore.registrarSecao(nome.slice(0, 60));
  res.json({ ok: true });
});

// Recebe o perfil de um aquário cadastrado/atualizado (para estatísticas).
app.post('/telemetria/aquario', (req, res) => {
  const { aquario } = req.body || {};
  if (!aquario || typeof aquario !== 'object') {
    return res.status(400).json({ erro: 'Envie o campo "aquario".' });
  }
  telemetriaStore.registrarPerfilAquario(aquario);
  res.json({ ok: true });
});

// Resumo estatístico (painel do admin).
app.get('/telemetria/admin', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  res.json(telemetriaStore.resumo());
});

// ============================ FIM TELEMETRIA ============================

// Página pública de votação (funciona sem o app instalado). O admin divulga o
// link, e pessoas de fora podem votar (1 voto por dispositivo via localStorage).
app.get('/concurso/votacao', (req, res) => {
  const config = concursosStore.obterConfig();
  if (!config || config.ativo !== true) {
    return res.status(404).send('Nenhum concurso ativo.');
  }
  const arquivo = path.join(__dirname, 'public', 'concursos', 'votacao.html');
  const baseApi = urlBasePublica(req);
  const html = fs
    .readFileSync(arquivo, 'utf8')
    .replace('window.AQUARIAPP_API ||', `window.AQUARIAPP_API = ${JSON.stringify(baseApi)}; window.AQUARIAPP_API ||`);
  res.type('html').send(html);
});

const CATALOGOS_DIR = path.join(__dirname, 'catalogos');

function lerCatalogo(nome) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CATALOGOS_DIR, `${nome}.json`), 'utf8'));
  } catch (e) {
    return null;
  }
}

app.get('/catalogos', (req, res) => {
  const manifest = {};
  for (const nome of catalogosStore.NOMES) {
    const arquivo = path.join(CATALOGOS_DIR, `${nome}.json`);
    try {
      const st = fs.statSync(arquivo);
      const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
      manifest[nome] = {
        versao: st.mtimeMs,
        tamanho: Array.isArray(dados) ? dados.length : 0,
      };
    } catch (e) {
      manifest[nome] = { versao: 0, tamanho: 0 };
    }
  }
  res.json(manifest);
});

app.get('/catalogos/:nome', (req, res) => {
  if (!catalogosStore.NOMES.includes(req.params.nome)) {
    return res.status(404).json({ erro: 'Catálogo não encontrado.' });
  }
  const dados = lerCatalogo(req.params.nome);
  if (!dados) return res.status(404).json({ erro: 'Catálogo não encontrado.' });
  res.json(dados);
});

app.post('/catalogos/:nome/item', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const { nome } = req.params;
  if (!catalogosStore.NOMES.includes(nome)) {
    return res.status(404).json({ erro: 'Catálogo não encontrado.' });
  }
  const item = req.body || {};
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return res.status(400).json({ erro: 'Envie o item a adicionar.' });
  }
  res.status(201).json(catalogosStore.adicionar(nome, item));
});

app.put('/catalogos/:nome/item/:chave', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const { nome, chave } = req.params;
  if (!catalogosStore.NOMES.includes(nome)) {
    return res.status(404).json({ erro: 'Catálogo não encontrado.' });
  }
  const atualizado = catalogosStore.atualizar(nome, chave, req.body || {});
  if (!atualizado) return res.status(404).json({ erro: 'Item não encontrado.' });
  res.json(atualizado);
});

app.delete('/catalogos/:nome/item/:chave', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const { nome, chave } = req.params;
  if (!catalogosStore.NOMES.includes(nome)) {
    return res.status(404).json({ erro: 'Catálogo não encontrado.' });
  }
  const removido = catalogosStore.remover(nome, chave);
  if (!removido) return res.status(404).json({ erro: 'Item não encontrado.' });
  res.json({ ok: true });
});

function normalizarTelefone(t) {
  return String(t || '').replace(/[^0-9]/g, '');
}

function papelPorPlano(premium) {
  return premium ? 'admin' : 'membro';
}

// Sincroniza a presença do usuário no grupo conforme o plano. Chamado pelo app
// quando o usuário entra na comunidade ou quando o plano muda (free <-> premium).
// Em modo simulado, apenas registra no store local. Com provedor configurado,
// adiciona o número ao grupo e promove/rebaixa o papel.
app.post('/whatsapp/sincronizar', async (req, res) => {
  const { telefone, premium } = req.body || {};
  const numero = normalizarTelefone(telefone);
  if (numero.length < 10) {
    return res.status(400).json({ erro: 'Envie o campo "telefone" com o número (DDD + número).' });
  }

  const ehPremium = premium === true || premium === 'true';
  const papel = papelPorPlano(ehPremium);

  const membro = whatsappStore.upsert({
    telefone: numero,
    plano: ehPremium ? 'premium' : 'free',
    papel,
    grupo: process.env.WHATSAPP_GROUP_ID || '',
    status: 'ativo',
    atualizadoEm: Date.now(),
  });

  try {
    const api = await whatsappApi.sincronizarMembro({
      telefone: numero,
      premium: ehPremium,
      grupo: membro.grupo,
    });
    return res.json({
      ok: true,
      modo: api.modo,
      papel,
      membro: {
        telefone: numero,
        plano: membro.plano,
        papel: membro.papel,
        desde: membro.criadoEm,
      },
    });
  } catch (e) {
    console.error('Falha ao sincronizar membro no WhatsApp:', e.message);
    return res.status(502).json({
      erro: `Não foi possível sincronizar com o grupo.\n\n${e.message}`,
    });
  }
});

// Remove o usuário do grupo (saída voluntária pelo app ou expulsão).
app.post('/whatsapp/sair', async (req, res) => {
  const { telefone } = req.body || {};
  const numero = normalizarTelefone(telefone);
  if (numero.length < 10) {
    return res.status(400).json({ erro: 'Envie o campo "telefone".' });
  }

  const existente = whatsappStore.buscar(numero);
  if (!existente) {
    return res.json({ ok: true, removido: false, motivo: 'nao_membro' });
  }

  try {
    const api = await whatsappApi.removerMembro(numero, existente.grupo);
    whatsappStore.remover(numero);
    return res.json({ ok: true, removido: true, modo: api.modo });
  } catch (e) {
    console.error('Falha ao remover membro do WhatsApp:', e.message);
    return res.status(502).json({ erro: `Não foi possível remover do grupo.\n\n${e.message}` });
  }
});

// Estado da integração (modo simulado vs configurado) e lista de membros.
app.get('/whatsapp/status', (req, res) => {
  res.json({
    configurado: whatsappApi.configurado(),
    modo: whatsappApi.configurado() ? 'real' : 'simulado',
    grupoId: process.env.WHATSAPP_GROUP_ID || '',
    totalMembros: whatsappStore.listar().length,
  });
});

app.get('/whatsapp/membros', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  res.json(whatsappStore.listar());
});

app.delete('/whatsapp/membros/:telefone', async (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const numero = normalizarTelefone(req.params.telefone);
  const existente = whatsappStore.buscar(numero);
  if (!existente) return res.status(404).json({ erro: 'Membro não encontrado.' });

  try {
    const api = await whatsappApi.removerMembro(numero, existente.grupo);
    whatsappStore.remover(numero);
    res.json({ ok: true, modo: api.modo });
  } catch (e) {
    console.error('Falha ao remover membro (admin):', e.message);
    res.status(502).json({ erro: `Não foi possível remover do grupo.\n\n${e.message}` });
  }
});

app.post('/pergunta', async (req, res) => {
  const { pergunta } = req.body || {};
  const texto = String(pergunta || '').trim();
  if (texto.length < 4) {
    return res.status(400).json({ erro: 'Escreva uma pergunta (mínimo 4 caracteres).' });
  }
  if (texto.length > 1000) {
    return res.status(400).json({ erro: 'A pergunta deve ter no máximo 1000 caracteres.' });
  }

  try {
    const dados = await viaIAVision({
      imagem: null,
      systemPrompt: PROMPT_PERGUNTA,
      userText: texto,
    });
    if (dados && dados.apropriada === true && dados.resposta) {
      return res.json({ apropriada: true, resposta: String(dados.resposta) });
    }
    return res.json({
      apropriada: false,
      resposta:
        'Essa pergunta não é relacionada ao aquarismo de água doce. Aqui podemos falar sobre peixes, plantas, ' +
        'parâmetros da água, equipamentos e manutenção de aquários.',
    });
  } catch (e) {
    console.error('Falha ao responder pergunta:', e.message);
    return res.status(502).json({ erro: e.message });
  }
});

app.post('/admin/login', (req, res) => {
  const { chave } = req.body || {};
  if (!chave || chave !== ADMIN_KEY) {
    return res.status(401).json({ erro: 'Chave inválida.' });
  }
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_ADMIN}=${assinarAdmin()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
      DURACAO_SESSAO_MS / 1000
    )}`
  );
  res.json({ ok: true });
});

app.post('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_ADMIN}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/admin/status', (req, res) => {
  if (autenticado(req)) return res.json({ autenticado: true });
  res.status(401).json({ autenticado: false });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.get('/admin-catalogos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'catalogos.html'));
});

app.get('/admin-ofertas', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'ofertas.html'));
});

// ============================ TESTER (limite de testadores) ============================
// O app consulta esta rota no boot (ambiente tester) para validar o acesso:
//  - acesso ILIMITADO (quem recebeu o link entra; não há limite de vagas);
//  - expira em testerStore.EXPIRA_EM (30/09/2026) mesmo que esqueçam de tirar o link do ar.

// ============================ ALIMENTOS RECOMENDADOS ============================
// Recomenda alimentos da fauna cadastrada, usando IA com fallback local.
const PROMPT_ALIMENTOS_RECOMENDADOS =
  'Você é um especialista em rações e alimentos para peixes ornamentais e aquários de água doce. ' +
  'O usuário informou a fauna do aquário. Recomende até 4 produtos de alimentação adequados para essa fauna. ' +
  'Responda APENAS com JSON válido no formato: ' +
  '{"recomendacoes":[{"marca":"marca do produto","nome":"nome comercial","tipo":"formato (flocos, grânulos, pellets, etc.)",' +
  '"indicacao":"para quais peixes/espécies o produto é indicado","motivo":"motivo curto e específico da recomendação"}]}. ' +
  'Se a fauna estiver vazia, responda {"recomendacoes":[]}. Não invente produtos inexistentes.';

function recomendacoesAlimentosLocais(fauna) {
  const produtos = catalogosStore.listar('produtos');
  const alimentos = (produtos || []).filter((p) => (p.categoria || '') === 'alimentos');
  const dietas = String(
    (fauna || [])
      .map((f) => `${f.dieta || ''} ${f.nomeComum || f.nome || ''}`.trim())
      .filter(Boolean)
      .join(' ')
  )
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!alimentos.length) return [];
  const vistos = new Set();
  const recomendacoes = alimentos
    .map((p) => {
      const alvo = `${p.nome || ''} ${p.marca || ''} ${p.tipo || ''} ${p.indicacao || ''} ${(p.palavrasChave || []).join(' ')}`
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      let score = 0;
      for (const token of dietas.split(/\s+/).filter((t) => t.length >= 4)) {
        if (alvo.includes(token)) score += 1;
      }
      if (dietas.includes('carnivor') && alvo.includes('carnivor')) score += 3;
      if (dietas.includes('herbivor') && (alvo.includes('herbivor') || alvo.includes('espirulina'))) score += 3;
      if (dietas.includes('onivor') && alvo.includes('comunitario')) score += 2;
      return { p, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.p);
  for (const p of recomendacoes) {
    const chave = `${p.marca || ''}-${p.nome || ''}`.toLowerCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);
  }
  const unicas = recomendacoes.filter((p) => {
    const chave = `${p.marca || ''}-${p.nome || ''}`.toLowerCase();
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
  return unicas.slice(0, 4).map((p) => ({
    marca: p.marca || '',
    nome: p.nome || '',
    tipo: p.tipo || '',
    indicacao: p.indicacao || '',
    motivo: p.indicacao ? `Adequado para a dieta da fauna: ${p.indicacao}.` : 'Alimento de rotina adequado para peixes de aquário comunitário.',
  }));
}

app.post('/alimentos-recomendados', async (req, res) => {
  const { fauna } = req.body || {};
  try {
    const lista = (fauna || []).map((f) => `${f.nomeComum || f.nome || 'peixe'} (${f.dieta || 'dieta não informada'})`).join(', ');
    const userText = lista
      ? `Fauna do aquário: ${lista}. Recomende alimentos adequados.`
      : 'A fauna está vazia. Recomende alimentos de rotina para aquário comunitário.';
    const dados = await viaIAVision({
      imagem: null,
      systemPrompt: PROMPT_ALIMENTOS_RECOMENDADOS,
      userText,
    });
    if (dados && Array.isArray(dados.recomendacoes)) {
      return res.json({
        recomendacoes: dados.recomendacoes.slice(0, 6),
        provedor: dados.provedor || 'IA',
      });
    }
  } catch (e) {
    console.error('Falha ao recomendar alimentos (IA):', e.message);
  }
  const recomendacoes = recomendacoesAlimentosLocais(fauna);
  return res.json({ recomendacoes, provedor: 'local', offline: true });
});

// ============================ SUGESTÕES DE AJUSTE ============================
// Sugestões de ajuste de parâmetros da água em alerta/perigo, com IA + fallback local.
const PROMPT_SUGESTOES_AJUSTE =
  'Você é um consultor de aquarismo de água doce. O usuário está com parâmetros da água em alerta ou perigo ' +
  'e precisa de sugestões práticas de ajuste. Analise os parâmetros e a situação e responda APENAS com JSON válido: ' +
  '{"resposta":"sugestões claras e práticas em português, com passos de correção, em até 6 frases"}. ' +
  'Priorize medidas seguras: TPAs parciais, ajustes graduais (máx. 1-2 °C/dia), condicionadores, redução de ração, ' +
  'verificação do filtro biológico, etc. Se os parâmetros informados estiverem todos OK, sugira apenas manter a rotina.';

app.post('/sugestoes-ajuste', async (req, res) => {
  const corpo = req.body || {};
  try {
    const texto = JSON.stringify(corpo);
    const userText = `Parâmetros/situação do aquário: ${texto}. Sugira ajustes.`;
    const dados = await viaIAVision({
      imagem: null,
      systemPrompt: PROMPT_SUGESTOES_AJUSTE,
      userText,
    });
    if (dados && typeof dados.resposta === 'string' && dados.resposta.trim()) {
      return res.json({ resposta: String(dados.resposta) });
    }
  } catch (e) {
    console.error('Falha ao gerar sugestões de ajuste (IA):', e.message);
  }
  const alertas = (corpo.alertas || []).map((a) => String(a.campo || a.titulo || '').toLowerCase());
  const resumo = String(corpo.resumo || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tem = (palavra) => alertas.includes(palavra) || resumo.includes(palavra);
  const linhas = [];
  if (tem('temperatura')) linhas.push('Temperatura fora da faixa: ajuste o aquecedor (~1W por litro) e mude a temperatura aos poucos (máx. 1-2 °C por dia).');
  if (tem('ph')) linhas.push('pH fora do ideal: evite variações bruscas. Troncos e folhas baixam o pH; rochas calcárias elevam. Ajuste aos poucos.');
  if (tem('amonia') || tem('amônia')) linhas.push('Amônia acima de 0: faça TPA de 20-30%, reduza a alimentação, use condicionador e confira o filtro biológico.');
  if (tem('nitrito')) linhas.push('Nitrito alto: ciclo incompleto. Reduza a ração, faça TPAs e adicione bactérias benéficas.');
  if (tem('nitrato')) linhas.push('Nitrato alto: TPAs regulares, menos ração e plantas ajudam a consumir o excesso.');
  if (tem('kh') || tem('dureza em carbonatos')) linhas.push('KH fora da faixa: use tampão de KH próprio e ajuste aos poucos para não estressar os peixes.');
  if (tem('gh') || tem('dureza geral')) linhas.push('GH fora da faixa: eleve com sais próprios ou reduza com água de osmose, sempre gradualmente.');
  if (linhas.length === 0) linhas.push('Revise as medições e repita o teste em 24-48h. Mantenha TPAs regulares e alimentação moderada.');
  return res.json({
    resposta: `Sugestões rápidas para ajustar a água:\n\n${linhas.map((l) => `• ${l}`).join('\n')}\n\nMeça novamente em 24-48h para acompanhar a melhora.`,
    _offline: true,
  });
});

// ============================ TRIAL (teste freemium) ============================
// Guarda anti-reinstalação do teste freemium: reserva o teste por dispositivo.
app.post('/trial', (req, res) => {
  const { dispositivoId } = req.body || {};
  const r = trialStore.reservar(dispositivoId);
  res.json(r);
});

app.get('/trial/todas', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  res.json(trialStore.listar());
});

app.delete('/trial/:dispositivoId', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const removido = trialStore.remover(req.params.dispositivoId);
  if (!removido) return res.status(404).json({ erro: 'Dispositivo não encontrado.' });
  res.json({ ok: true });
});

// ============================ TESTER (limite de testadores) ============================
// O app consulta esta rota no boot (ambiente tester) para validar o acesso:
//  - acesso ILIMITADO (quem recebeu o link entra; não há limite de vagas);
//  - expira em testerStore.EXPIRA_EM (30/09/2026) mesmo que esqueçam de tirar o link do ar.

app.post('/tester/validar', (req, res) => {
  const { dispositivoId } = req.body || {};
  const r = testerStore.validar(dispositivoId);
  if (!r.ok) {
    return res.status(403).json({ ok: false, codigo: r.codigo, motivo: r.motivo });
  }
  res.json({ ok: true, limite: 'ilimitado' });
});

app.get('/tester/admin', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const e = testerStore.listar();
  res.json({
    limite: e.limite,
    expiraEm: e.expiraEm,
    usados: e.dispositivos.length,
    dispositivos: e.dispositivos.map((d) => ({ id: d.id, registradoEm: d.registradoEm })),
  });
});

app.delete('/tester/admin/:dispositivoId', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const removido = testerStore.remover(req.params.dispositivoId);
  if (!removido) return res.status(404).json({ erro: 'Dispositivo não encontrado.' });
  res.json({ ok: true });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[AquarIApp Server] rodando em http://localhost:${PORT}`);
    console.log(`Chaves detectadas: ${semChaves().join(', ') || 'nenhuma — preencha o .env'}`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
    console.log(`  Ofertas:    /admin-ofertas`);
    console.log(`  Catálogos:  /admin-catalogos`);
  });
}
module.exports = { app, viaGemini, viaPlantNet, viaOpenAI, validarFotoGemini, validarFotoOpenAI, filtrarCronogramaSeguro, detectarFaunaSensivel };
