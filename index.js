require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const fsApp = require('fs');
const pathApp = require('path');
const TESTER_APP_DIR = pathApp.join(__dirname, 'tester-app');
const TESTER_INDEX = pathApp.join(TESTER_APP_DIR, 'index.html');
const TEM_TESTER_APP = (() => { try { return fsApp.existsSync(TESTER_INDEX); } catch (e) { return false; } })();

// Kill-switch do app dos testadores (REVERSÍVEL). A SPA de testes só é servida
// quando a env SERVIR_TESTER=1 estiver definida no ambiente. Padrão = DESLIGADO:
// a raiz '/' responde apenas o JSON de status (API) e não entrega o app tester.
// Para religar o teste, basta definir SERVIR_TESTER=1 no painel (redeploy automático).
const SERVIR_TESTER = process.env.SERVIR_TESTER === '1';
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
const iaUsoStore = require('./iaUsoStore');
const pushStore = require('./pushStore');
const testerStore = require('./testerStore');
const feedbackStore = require('./feedbackStore');
const cacheStore = require('./cacheStore');
const pagamentosStore = require('./pagamentosStore');
const contasStore = require('./contasStore');

// Mercado Pago (Checkout Pro). Sem token configurado, as rotas respondem
// INDISPONIVEL e o app mantém o comportamento atual.
const MP_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN || '';
// Base da API do Mercado Pago. Overridável por env apenas para TESTES locais
// (mock); em produção usar sempre o padrão.
const MP_API = process.env.MP_API_BASE || 'https://api.mercadopago.com';
// URL para onde o comprador volta depois de pagar (back_urls) — o app web
// também consulta /pagamentos/status/:ref para ativar o benefício.
const PAGAMENTO_RETORNO = process.env.PAGAMENTO_URL_RETORNO || 'https://app.aquariapp.com.br';

const otplib = require('otplib');
const ADMIN_KEY = process.env.ADMIN_KEY || (process.env.NODE_ENV === 'production' ? '' : 'admin123');
if (!ADMIN_KEY) {
  console.error('[FATAL] Defina a variável ADMIN_KEY no .env (obrigatória em produção).');
  process.exit(1);
}

// 2FA opcional no Admin: se ADMIN_TOTP_SECRET estiver definido no ambiente,
// todas as rotas admin exigem também o código de 6 dígitos (X-Otp).
const ADMIN_TOTP_SECRET = process.env.ADMIN_TOTP_SECRET || '';
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

function otpAdminValido(req) {
  if (!ADMIN_TOTP_SECRET) return true; // 2FA não configurado → não exige
  const otp = req.get('X-Otp') || '';
  if (!/^\d{6}$/.test(otp)) return false;
  try {
    const res = otplib.verifySync({ token: otp, secret: ADMIN_TOTP_SECRET });
    return res.valid === true;
  } catch (e) {
    return false;
  }
}

function autenticado(req) {
  const chave = req.get('X-Admin-Key');
  if (chave && chave === ADMIN_KEY) return otpAdminValido(req);
  return cookieAdminValido(req) && otpAdminValido(req);
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

// Transcrição de voz (OpenAI Whisper) — usada pelo botão "Falar" do app
// (Perguntas e Pronto-Socorro) quando a Web Speech API não existe (celular).
// Recebe o áudio em base64 e devolve o texto transcrito.
app.post('/transcrever', (req, res) => {
  const { audio, tipo, idioma } = req.body || {};
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ erro: 'Envie o campo "audio" (base64).' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ erro: 'Transcrição indisponível (chave OpenAI não configurada).' });
  }
  const base64 = audio.includes('base64,') ? audio.split('base64,')[1] : audio;
  let buf;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch (e) {
    return res.status(400).json({ erro: 'Áudio inválido.' });
  }
  if (!buf || buf.length === 0) {
    return res.status(400).json({ erro: 'Áudio vazio.' });
  }
  if (buf.length > 12 * 1024 * 1024) {
    return res.status(400).json({ erro: 'Áudio muito grande (máx. 12 MB).' });
  }
  const mime = String(tipo || 'audio/webm').toLowerCase();
  const extensao = /mp4|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm';
  const lang = idioma === 'en' ? 'en' : 'pt';

  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `voz.${extensao}`);
  form.append('model', 'whisper-1');
  form.append('language', lang);
  form.append('response_format', 'json');

  return fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  })
    .then(async (resp) => {
      const dados = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error('Falha Whisper:', resp.status, JSON.stringify(dados).slice(0, 300));
        return res.status(502).json({ erro: `Falha na transcrição (${resp.status}).` });
      }
      const texto = String((dados && dados.text) || '').trim();
      if (!texto) {
        return res.status(422).json({ codigo: 'sem_fala', erro: 'Nenhum texto reconhecido no áudio.' });
      }
      return res.json({ texto });
    })
    .catch((e) => {
      console.error('Falha ao transcrever:', e.message);
      return res.status(502).json({ erro: 'Não foi possível transcrever o áudio.' });
    });
});

const rotasIA = [
  '/identify',
  '/buscar-nome',
  '/buscar-produto',
  '/alimentos-recomendados',
  '/validar-foto',
  '/diagnostico',
  '/diagnostico-alga',
  '/diagnostico-micro',
  '/compatibilidade',
  '/sugestoes',
  '/sugestoes-ajuste',
  '/sugestao-aquario',
  '/avaliacao-aquario',
  '/avaliacao-graficos',
  '/cronograma-alimentar',
  '/pergunta',
  '/transcrever',
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

const AI_TIMEOUT_MS = 15000;

// Timeout do refino de decisão: menor que o padrão para não estourar o tempo
// total do request (o refino é uma chamada extra após os provedores).
const REFINO_TIMEOUT_MS = 12000;

// Timeout da validação de foto (é só um sim/não; não precisa de 20s).
const VALIDACAO_TIMEOUT_MS = 8000;

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
  'Você é um especialista em aquarismo de água doce. Avalie se um NOVO peixe pode ser introduzido com segurança em um aquário JÁ habitado. ' +
  'Seja CRITERIOSO e CONSERVADOR: marque como incompatível APENAS nos casos listados abaixo. ' +
  'Considere incompatível SOMENTE quando houver: ' +
  '(1) RISCO DE MORTE POR PREDAÇÃO OU BRIGAS: o novo peixe é predador e vai comer a fauna existente (ex.: Oscar/ciclídeo grande com ' +
  'tetras, neons, guppys, coridoras pequenas), OU há risco real de morte por agressão/territorialidade letal entre espécies. ' +
  '(2) ESPAÇO INSUFICIENTE PARA SOBREVIVER: o volume do aquário é claramente pequeno demais para o tamanho adulto do novo peixe ' +
  '(ex.: Oscar adulto de 40cm num aquário de 40L) — risco de morte por espaço. ' +
  '(3) AMBIENTE TOTALMENTE DIFERENTE: os parâmetros de água são extremos e opostos entre as espécies, de forma que NENHUMA das duas ' +
  'sobrevive na água da outra (ex.: ciclídeo africano de lago alcalino pH 8.5+ com barbo de água ácida pH 6.0, ou peixe de água doce ' +
  'pura com peixe de água salobra). ' +
  'NÃO considere incompatível por pequenas diferenças de pH, temperatura ou dureza (ex.: pH 7.0 vs 7.4, temperatura 24 vs 26°C), ' +
  'nem por diferenças de comportamento que não impliquem risco de morte. Ajustes pequenos de água atendem ambas as espécies. ' +
  'Responda APENAS com JSON válido: {"compativel": true} se for seguro, ou ' +
  '{"compativel": false, "motivo": "explicação breve em português com poucas palavras, citando o risco principal (ex.: predação, ' +
  'espaço insuficiente, ambiente totalmente diferente)"} se houver risco de morte ou ambiente totalmente incompatível. ' +
  'Se houver mais de um risco, mencione os principais no motivo. Se não tiver certeza sobre um risco real de morte, ' +
  'responda compativel true (apenas se não houver risco claro de morte nem ambiente totalmente diferente).';

const PROMPT_SUGESTOES =
  'Você é um especialista em aquarismo de água doce. O usuário quer sugestões de espécies de peixes (apenas fauna, nada de plantas) ' +
  'que possam ser ADICIONADAS com segurança a um aquário já montado. Seja CRITERIOSO: considere incompatível APENAS quando houver ' +
  'risco real de morte (predação, brigas letais) ou espaço insuficiente para o tamanho adulto, ou ambiente totalmente diferente ' +
  '(ex.: peixe de água alcalina extrema vs ácida extrema). Pequenas diferenças de pH/temperatura não tornam espécies incompatíveis. ' +
  '1º RISCO ENTRE ESPÉCIES: o novo peixe não pode ter risco de morte (predação, agressão letal) com NENHUM peixe existente. ' +
  '2º ESPAÇO: o tamanho adulto do novo peixe deve caber no volume do aquário. ' +
  '3º AMBIENTE: o novo peixe deve tolerar o pH e a temperatura do aquário (pequenas diferenças são aceitáveis). ' +
  '4º Espécies que já existem no aquário NÃO devem ser repetidas. ' +
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
  'e em QUANTIDADE adequada ao volume (regra prática de até ~1 cm de peixe por litro, considerando 50% do tamanho adulto de cada peixe, para comunitário; menos para ' +
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
  'Você é um aquarista experiente em qualidade da água para água doce. Analise TODAS as informações do aquário ' +
  'do usuário fornecidas abaixo (parâmetros com seus SELOS, fauna, flora, equipamentos e histórico) e responda ' +
  'APENAS com JSON válido no formato: ' +
  '{"resumo":"avaliação curta e honesta do estado atual (2 a 4 frases)",' +
  '"pontosFortes":["o que está bem feito","..."],' +
  '"sugestoes":[{"titulo":"dica curta","detalhe":"explicação prática de como melhorar"}],' +
  '"urgencias":[{"titulo":"atenção","detalhe":"o que precisa de ação rápida"]}]}. ' +
  'Regras: ' +
  '(1) Avalie CADA parâmetro preenchido pelo seu SELO (Seguro/Atenção/Perigo) e pelo valor medido; não invente ' +
  'parâmetros que o usuário não mediu. ' +
  '(2) Se houver HISTÓRICO com mais de uma medição, faça uma análise EVOLUTIVA: compare as últimas medições e ' +
  'diga se cada parâmetro melhorou, piorou ou ficou estável, e o que isso indica. ' +
  '(3) Considere a fauna e a flora cadastradas: aponte incompatibilidades entre os parâmetros ideais das espécies ' +
  'e a água medida. ' +
  '(4) pontosFortes: destaque o que está correto (parâmetros em selo Seguro, fauna compatível, lotação adequada, etc.). ' +
  '(5) sugestoes: até 4 dicas práticas e específicas, com base no que está em Atenção ou que pode melhorar. ' +
  '(6) urgencias: liste apenas riscos reais exigindo ação rápida (parâmetro em Perigo, incompatibilidade grave, ' +
  'risco de morte). Se não houver, retorne lista vazia. ' +
  '(7) Resposta CURTA: o resumo deve ter no máximo 3 frases e o total de tudo não deve passar de 15 linhas. ' +
  'Seja objetivo e direto, sem encher linguiça.';

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

const PROMPT_AVALIACAO_GRAFICOS =
  'Você é um especialista em aquarismo de água doce e analisa os gráficos de qualidade da água de um aquário. ' +
  'O usuário enviou as últimas medições registradas (série temporal de pH, temperatura, amônia, nitrito, nitrato, KH e GH). ' +
  'Analise as TENDÊNCIAS e os VALORES ATUAIS. Responda APENAS com JSON válido: ' +
  '{"resposta": "texto curto em português (até ~250 caracteres)"}. ' +
  'A resposta deve: ' +
  '(1) PARABENIZAR o aquarista pelos parâmetros bons e estáveis (ex.: amônia 0, nitrito 0, nitrato baixo, temperatura e pH estáveis). ' +
  '(2) ALERTAR para perigos iminentes com base nas tendências (ex.: amônia subindo, nitrito presente, pH variando muito, temperatura fora da faixa). ' +
  '(3) Trazer DICAS RESUMIDAS de como melhorar os parâmetros em poucos dias (TPA, alimentação, filtro, aquecedor, bactérias). ' +
  'Seja objetivo, use emojis com moderação e não invente dados que não estão nas medições. ' +
  'Valores de referência: amônia 0, nitrito 0, nitrato <20-40 ppm, pH estável 6,5-7,5, temperatura 24-28 °C.';


const PROMPT_SISTEMA =
  'Você é um especialista mundial em peixes e plantas de aquário de água doce, com conhecimento profundo de taxonomia (cichlidae, characidae, ' +
  'cyprinidae, poeciliidae, etc.). Sua tarefa é IDENTIFICAR COM ALTA PRECISÃO o animal ou planta aquática da foto. ' +
  'Responda APENAS com JSON válido no formato: ' +
  '{"tipo":"fauna ou flora","confianca":0 a 100,"nomeComum":"nome popular em português","nomeCientifico":"nome científico","familia":"família",' +
  '"origem":"origem geográfica","tamanho":"ex: até 5 cm","temperatura":"ex: 23 - 27 °C","ph":"ex: 5,5 - 6,5","dureza":"ex: 5 - 12 °dH",' +
  '"dieta":"tipo de alimentação","comportamento":"comportamento","aquarioMinimo":"ex: 40 L","dificuldade":"fácil/médio/avançado",' +
  '"iluminacao":"baixa/média/alta","co2":"opcional/recomendado/necessário","crescimento":"lento/médio/rápido","tipoPlanta":"tipo de planta (se flora)",' +
  '"observacoes":"curiosidades e dicas de manutenção","dimorfismo":"como diferenciar MACHO de FÊMEA em poucas palavras (apenas se a espécie tem dimorfismo sexual fácil de ver; senão deixe vazio ' + '""".}. ' +
  'COBERTURA: identifique peixes, plantas, invertebrados (camarões, caramujos, caranguejos, lagostins, hidras, planárias, copépodes), ' +
  'anfíbios (axolotes, rãs), insetos e larvas aquáticas (ex.: "tigre d\'água", barata-d\'água, ninfas) e tartarugas de água doce. ' +
  'REGRAS DE PRECISÃO (MUITO IMPORTANTES — NUNCA retorne nomes genéricos): ' +
  '(0) ÁGUA DOCE vs MARINHO: este app é para aquários de ÁGUA DOCE. NUNCA identifique peixes marinhos. ' +
  'Se a foto parece um peixe marinho (cores vivas de recife, listras verticais pretas e brancas como "serranus" ou "goatfish"), ' +
  'verifique se NÃO é um ciclídeo de água doce com padrão similar. Goatfish/Serranus são MARINHOS e NÃO existem em aquários de água doce. ' +
  'Se o peixe é de aquário de água doce e tem listras, provavelmente é um ciclídeo (Malawi, Tanganyika, etc.) e NÃO um peixe marinho. ' +
  '(1) NUNCA responda apenas "ciclídeo", "acará", "peixe" ou "peixe de aquário". SEMPRE dê a espécie mais específica possível, com nome popular e científico. ' +
  '(2) "Acará" é um termo genérico — identifique a ESPÉCIE exata (ex.: Acará-bandeira Pterophyllum scalare, Acará-disco Symphysodon, ' +
  'Acará-azul Aequidens pulcher, Acará-da-floresta Mesonauta festivus, Ciclídeo do Texas Herichthys cyanoguttatus, Texas Red/Herichthys carpintis "Texas red" que tem manchas vermelho-alaranjadas e pintas azuis, etc.). ' +
  '"Texas Red" (Herichthys carpintis / "Texas Red Cichlid") tem corpo com fundo vermelho-rosado e MANCHAS azuis metálicas/verdes espalhadas — é totalmente DIFERENTE do Acará-bandeira (corpo em formato de disco com listras verticais) e do Acará-azul (cinza/azulado). ' +
  '(3) Para ciclídeos africanos do Malawi, NUNCA diga apenas "ciclídeo do Malawi". Dê a espécie ou grupo específico: Aulonocara (Peacock, ex.: Aulonocara stuartgranti, Aulonocara baenschi "Sunshine"), ' +
  'Labidochromis caeruleus (Yellow Lab), Melanochromis auratus (Auratus), Maylandia/Pseudotropheus zebra (Zebra, listras verticais), ' +
  'Pseudotropheus acei (Acei), Cyrtocara moorii (Golfinho do Malawi), Tropheus (Tanganyika), Altolamprologus, etc. ' +
  'CUIDADO com Haplochromis obliquidens (Zebra Oblíquo / Obliquidens) — ciclídeo de ÁGUA DOCE do LAGO VICTORIA ' +
  '(NÃO do Malawi, NÃO marinho). É um CICLÍDEO PEQUENO (macho ~8-10 cm), corpo ovalado/alongado, ' +
  'macho com corpo laranja/avermelhado e 6-8 barras OBLÍQUAS (diagonais) escuras no flanco, ' +
  'fêmea prateada/olivácea com barras escuras mais discretas. ' +
  'PARECE Maylandia zebra (listras pretas e brancas) mas as barras do obliquidens são OBLÍQUAS ' +
  '(diagonais, inclinadas para trás) enquanto as do zebra são VERTICAIS. ' +
  'NÃO confundir com peixes MARINHOS como goatfish/serranus — Haplochromis obliquidens é de ÁGUA DOCE, ' +
  'tem corpo de ciclídeo (boca terminal, nadadeiras arredondadas), viv em cardume, ' +
  'e NÃO tem barbilhões (bbyss) no queixo como goatfish. ' +
  'Origem: Lago Vitoria, África Oriental (Quênia, Tanzânia, Uganda). ' +
  'Um "Aulonocara" (Peacock) tem corpo alongado com coloração uniforme e brilhante (azul/amarelo/laranja) e nadadeiras longas, sem listras verticais — diferente de um Mbuna listrado. ' +
  '(3.5) CUIDADO com ciclídeos AMERICANOS grandes, que NUNCA devem ser confundidos com ciclídeos do Malawi: ' +
  '"Green Terror" (Andinoacara rivulatus) tem corpo esverdeado com manchas escuras, bordas de barbatanas em tons amarelo/laranja, cabeça com padrão reticulado e barbatanas dorsais longas e pontiagudas no MACHO — origem América do Sul/Pacífico. ' +
  '"Jack Dempsey" (Rocio octofasciata) tem corpo marrom-escuro com pontos azuis/verdes brilhantes. ' +
  '"Ciclídeo do Texas" (Herichthys cyanoguttatus) tem pontos azuis em corpo prateado. ' +
  '"Oscar" (Astronotus ocellatus) tem manchas oceladas (olho) na base da cauda. ' +
  '"Severum" (Heros efasciatus) tem corpo arredondado amarelado com faixas verticais discretas. ' +
  '"Ciclídeo Papagaio / Blood Parrot" é um híbrido de aquário com corpo CURTO e bem arredondado (formato de pão/balão), boca pequena que NÃO fecha (sempre aberta, em forma de "o"), cores laranja/amarelo/vermelho uniformes, nadadeira dorsal e caudal curtas, e origem artificial (criado em cativeiro) — é MUITO diferente do Green Terror (corpo alongado esverdeado, boca normal, barbatanas longas e pontiagudas). Se a foto mostra corpo em balão + boca aberta, é PAPAGAIO, nunca Green Terror. ' +
  'Ciclídeos do Malawi (Aulonocara, Labidochromis, Melanochromis, Pseudotropheus) são de origem AFRICANA, corpo mais alongado e cores vivas uniformes — se a foto mostra um peixe grande, esverdeado, com manchas e barbatanas longas, é provavelmente Green Terror (Andinoacara rivulatus), NUNCA um Malawi. ' +
  'Para ciclídeos americanos com dimorfismo fácil, preencha "dimorfismo" (ex.: Green Terror — macho maior, com giba nucal e barbatanas dorsais/pélvicas longas e pontudas; fêmea menor e mais arredondada). ' +
  '(3.8) CUIDADO com peixes pequenos e comuns que confundem — sempre diga a ESPÉCIE exata, nunca apenas o grupo: ' +
  '"Neon Tetra" (Paracheirodon innesi) tem a faixa vermelha só na metade traseira do corpo; "Cardinal Tetra" (Paracheirodon axelrodi) tem a faixa vermelha no corpo INTEIRO — NUNCA confunda os dois. ' +
  '"Guppy/Lebiste" (Poecilia reticulata) tem cauda e nadadeiras grandes e coloridas no macho; "Molinésia" (Poecilia sphenops/velifera) tem corpo mais alto e nadadeira dorsal maior; "Espada/Xifóforo" (Xiphophorus hellerii) tem prolongamento em espada na cauda; "Plati" (Xiphophorus maculatus) tem corpo mais compacto. ' +
  '"Coridora" — identifique a espécie (Bronze/Corydoras aeneus, Panda/C. panda, Sterbai/C. sterbai, Pimenta/C. paleatus, etc.) pela mancha/padrão. ' +
  '"Barbo" — identifique (Sumatra/Barbus tetrazona com faixas verticais pretas, Cherry/Puntius titteya com corpo avermelhado no macho, etc.). ' +
  '"Peixe-palhaço/Botia" (Botia macracantha) tem faixas laranja e pretas; NÃO confundir com "Palhaço de água doce"... ' +
  '"Tetra" sozinho é genérico — sempre a espécie (Vermelho/Aphyocharax anisitsi, Imperador/Nematobrycon palmeri, Fantasma/Megalamphodus megalopterus, etc.). ' +
  '"Peixe-borboleta" (Pantodon buchholzi) tem nadadeiras largas em forma de asa e NÃO é um Betta. ' +
  'Para lebistes/molinésias/espadas/platis (poeciliídeos) e para coridoras e muitos ciclídeos, preencha "dimorfismo" quando for fácil (ex.: guppy macho colorido com cauda grande, fêmea cinza maior; coridora macho com barbatana dorsal maior e pontuda). ' +
  '(4) ANTES de responder, liste mentalmente as espécies parecidas e compare detalhes: forma da cabeça e do corpo, padrão e cor das manchas/listras, ' +
  'formato e posição das nadadeiras, cauda, dorsal, região da boca. Não escolha por semelhança superficial. ' +
  '(5) Se tiver dúvida entre duas espécies, escolha a mais provável, mas baixe a confianca (40-55) e explique as alternativas em "observacoes". ' +
  '(6) Somente retorne tipo "invalido" se a foto não for animal/planta aquática, com campo "motivo" curto. ' +
  'Retorne "desconhecido" apenas se a foto for aquática mas sem nada identificável.';

// Exemplos few-shot: pares de espécies fáceis de confundir, com a característica
// VISUAL decisiva que diferencia cada uma. Colocados no topo do prompt final
// para maximizar o impacto na decisão do modelo.
const FEW_SHOT_EXAMPLES =
  'EXEMPLOS DE DIFERENCIAÇÃO (leia com atenção — são os erros mais comuns): ' +
  '1) Neon Innesi (Paracheirodon innesi): faixa vermelha SÓ na metade traseira do corpo. ' +
  'Neon Cardinal (P. axelrodi): faixa vermelha no corpo INTEIRO (do olho à cauda). ' +
  '2) Guppy macho (Poecilia reticulata): cauda GRANDE, colorida e fluida; corpo pequeno. ' +
  'Guppy Endler (P. wingei): menor, com blocos de cor metálica, cauda curta. ' +
  'Molly (P. sphenops): corpo mais alto, nadadeira dorsal maior, cauda sem espada. ' +
  'Espada (X. hellerii): prolongamento em ESPADA na cauda. ' +
  '3) Acará-bandeira (Pterophyllum scalare): corpo ALTO em forma de disco, listras verticais pretas, nadadeiras longas. ' +
  'Acará-disco (Symphysodon): corpo arredondado, sem listras verticais marcadas. ' +
  '4) Haplochromis obliquidens (Lago Victoria, ÁGUA DOCE): barras OBLÍQUAS (diagonais) laranja/escuras. ' +
  'Maylandia zebra (Malawi): listras VERTICAIS pretas e brancas. NUNCA é goatfish/serranus (marinhos). ' +
  '5) Betta (B. splendens): barbatanas longas em véu, corpo compacto, vem do Sudeste Asiático. ' +
  'Gourami/Colisa (Trichogaster): barbatanas peitorais em forma de antena fina. ' +
  '6) Coridora (Corydoras): peixe de fundo com bigodes, corpo blindado por placas. ' +
  'Panda: mancha preta ao redor do olho. Sterbai: pintas claras no fundo escuro. Bronze: cor uniforme. ' +
  '7) Green Terror (Andinoacara rivulatus, AMERICANO): corpo esverdeado com manchas, barbatanas longas e pontiagudas. ' +
  'Ciclídeos do Malawi (africanos): cores vivas uniformes, corpo menor. ' +
  '8) Ciclídeo Papagaio/Blood Parrot (híbrido): corpo em BALÃO (pão), boca pequena sempre aberta em "o". ' +
  '9) Oscar (Astronotus ocellatus): manchas OCELADAS (com olho) na base da cauda. ' +
  '10) Tetra Foguinho (Hyphessobrycon flammeus): corpo avermelhado/laranja. ' +
  'Tetra Amanda (H. amandae): corpo pequeno laranja-claro, cauda sem marcação forte. ' +
  '11) INVERTEBRADOS de água doce (ornamentais de aquário): camarões (Red Cherry Neocaridina davidi vermelho; Amano Caridina multidentata cinza com pintas; Ghost Palaemonetes translúcido), ' +
  'caramujos (Ampulária/Pomacea concha grande e redonda; Ramshorn Planorbella concha em espiral plana avermelhada; Neritina concha com listras/marcas, não se reproduz em água doce), ' +
  'lagostas/caranguejos de água doce (Procambarus clarkii vermelho). ' +
  '12) ANFÍBIOS de água doce (terrário/aquaterrário): Axolote (Ambystoma mexicanum) — salamandra com brânquias externas plumosas na cabeça, corpo liso, cauda longa; ' +
  'rãs e pererecas aquáticas. ' +
  '13) RÉPTEIS de água doce (terrário/tartarugário): Tigre d\'água (Staurotypus/Dermatemys ou a tartaruga aquática comum) — casco rígido, cabeça retrátil, patas palmadas; ' +
  'tartarugas de água doce (Trachemys scripta), quelônios. NUNCA é um peixe. ' +
  '14) CICLÍDEOS DO MALAWI entre si (todos africanos, corpo ovalado): Labidochromis caeruleus = AMARELO uniforme com faixa preta na dorsal. ' +
  'Pseudotropheus zebra (Maylandia) = listras VERTICAIS azuis/pretas. Demasoni = listras verticais azul e preto MUITO finas. ' +
  'Melanochromis auratus = macho listrado amarelo/preto, fêmea amarela. Aulonocara (Peacock) = cor UNIFORME brilhante (vermelho/azul/amarelo) SEM listras. ' +
  '15) Barbos: Sumatra (Pethia tetrazona) = 4 listras VERTICAIS pretas em corpo alaranjado/prateado. ' +
  'Cereja (Puntius titteya) = macho VERMELHO/cereja uniforme sem listras. Rosado (Pethia conchonius) = prateado/rosado com mancha preta no pedúnculo. ' +
  '16) Cascudos/limpa-vidros: Otocinclus = pequeno (~4cm), delgado, mancha escura horizontal, come algas do vidro. ' +
  'Ancistrus = tem RABO (tentáculos) no focinho, corpo mais robusto. Hypostomus/Pleco = grande (20-30cm), corpo com placas. ' +
  '17) Tetras escuros: Tetra Preto/Fantasma Negro (Gymnocorymbus ternetzi) = corpo alto, 2 listras verticais escuras, nadadeiras pretas. ' +
  'Tetra Fantasma Vermelho (H. sweglesi) = vermelho, sem listras verticais. ' +
  '18) Gouramis: Azul (Trichopodus trichopterus) = azul-acinzentado com pintas, barbatana peitoral em antena. ' +
  'Pérola (T. leerii) = manchas claras tipo pérola no corpo escuro. Mel (Trichogaster chuna) = laranja/mel. ' +
  '19) Carpas/Kinguios: Carassius auratus (dourado comum) = corpo alongado, cauda bifurcada simples. ' +
  'Kinguio Oranda = capuz (wén) na cabeça + cauda longa. Ranchu = SEM barbatana dorsal, corpo arredondado. ' +
  'Kinguio Telescópio = OLHOS salientes em telescópio. Koi (Cyprinus carpio) = tem BARBILHÕES no focinho (o dourado não tem). ' +
  '20) ALGAS por foto — PETECA é a mais comum em aquários plantados; em dúvida entre peteca e filamentosa, prefira PETECA. ' +
  'Peteca/BBA = TUFOS pretos/cinza-escuros, DENSOS e RÍGIDOS, grudados nas BORDAS de folhas, troncos e saídas de filtro (não saem esfregando). ' +
  'Filamentosa = FIOS VERDES longos, finos e MACIOS como cabelo, formando teias (verdes, nunca pretos). ' +
  'Marrom = POEIRA marrom fina que sai fácil com o dedo (aquário novo/ciclagem). ' +
  'Green Dust = poeira verde difusa no vidro (macia). Green Spot = PONTOS verdes DUROS que só saem com lâmina. ' +
  'Cianobactéria = película verde-azulada VISCOSA com CHEIRO de mofo (não é alga verdadeira). ' +
  'Água verde = água inteira turva esverdeada. ' +
  '21) Tetra Rosa (Hyphessobrycon bentosi) vs Rosado (H. rosaceus) vs Serpae (H. eques): Rosa = corpo ALTO em disco, rosa-avermelhado uniforme, dorsal alta com mancha escura na base. ' +
  'Rosado = corpo mais alongado, faixa prateada discreta. Serpae = mancha preta em VÍRGULA atrás da guelra. ' +
  '22) Polypterus (PEIXE primitivo africano) vs Axolote (ANFÍBIO mexicano): Polypterus tem corpo cilíndrico com ESCAMAS em losango, dorsal em ESPINHOS isolados, nadadeiras peitorais em leque, SEM patas, SEM brânquias externas. ' +
  'Axolote tem BRÂNQUIAS externas plumosas na cabeça, 4 PATAS, corpo liso SEM escamas. NUNCA confunda: peixe com escamas ≠ anfíbio com patas. ' +
  '23) Barbo Ouro (Pethia gelius, 3-4 cm) vs Kinguio (Carassius auratus, 15-30 cm): Barbo Ouro é MINÚSCULO, dourado uniforme, corpo alongado de ciprinídeo, nada em cardume. ' +
  'Kinguio é 5-10x MAIOR, corpo alto/arredondado, cauda dupla. Um peixe pequeno dourado é SEMPRE barbo, NUNCA kinguio — use o TAMANHO como critério decisivo. ' +
  '24) NOMES POPULARES — Colisa = Gourami Anão: Trichogaster lalius é chamado de COLISA no Brasil e de DWARF GOURAMI / GOURAMI ANÃO internacionalmente. ' +
  'São o MESMO peixe (variedades azul, vermelha/flame, neon, arco-íris). Ao identificar, cite AMBOS os nomes para não parecer erro. ' +
  '25) Platy Mickey (Xiphophorus maculatus variedade Mickey Mouse) vs Molinésia (Poecilia sphenops): Platy Mickey tem a MARCA de 3 manchas escuras na base da cauda (rosto do Mickey), corpo compacto 4-6 cm. ' +
  'Molinésia é MAIOR (8-12 cm), corpo alongado, dorsal maior, SEM marca do Mickey. Com marca do Mickey = Platy, sem dúvida. ' +
  '26) Tetra Fortuna (Moenkhausia costae) vs Limão (Hyphessobrycon pulchripinnis): Fortuna = PRATEADO com brilho metálico e faixa horizontal escura discreta, 5-7 cm. ' +
  'Limão = AMARELO-limão vivo por todo o corpo. Prateado = Fortuna; amarelo = Limão. ' +
  'REGRAS DE ESCOPO: este app identifica FAUNA AQUÁTICA DE ÁGUA DOCE ornamental de aquários, lagos e terrários — ' +
  'peixes, invertebrados (camarões, caramujos, lagostas, caranguejos), anfíbios (axolotes, rãs) e repteis aquáticos (tigre d\'água, tartarugas). ' +
  'NUNCA identifique animais TERRESTRES (gatos, cachorros, pássaros) nem MARINHOS (peixes de recife, coral, anêmonas marinhas).';

// Prompt final de identificação: junta o PROMPT_SISTEMA com a lista de
// espécies conhecidas do catálogo do app (para a IA escolher dentro dela).
function montarPromptSistema() {
  const lista = obterListaEspeciesPrompt();
  return (
    FEW_SHOT_EXAMPLES +
    ' ' +
    PROMPT_SISTEMA +
    ' ' +
    'CATÁLOGO DISPONÍVEL NO APP (escolha PREFERENCIALMENTE uma espécie desta lista quando a foto corresponder; ' +
    'nomeComum + nomeCientifico): ' +
    (lista || 'nenhuma') +
    '. Se a espécie não estiver na lista, ainda assim identifique com nome popular e científico corretos.'
  );
}

const PROMPT_BUSCA_NOME =
  'Você é um especialista em aquarismo de água doce. O usuário digitou o nome de uma espécie de peixe ou planta aquática e ' +
  'quer a ficha técnica. Responda APENAS com JSON válido no seguinte formato: ' +
  '{"tipo":"fauna ou flora","confianca":null,"nomeComum":"nome popular em português","nomeCientifico":"nome científico","familia":"família",' +
  '"origem":"origem geográfica","tamanho":"ex: até 5 cm","temperatura":"ex: 23 - 27 °C","ph":"ex: 5,5 - 6,5","dureza":"ex: 5 - 12 °dH",' +
  '"dieta":"tipo de alimentação","comportamento":"comportamento","aquarioMinimo":"ex: 40 L","dificuldade":"fácil/médio/avançado",' +
  '"iluminacao":"baixa/média/alta","co2":"opcional/recomendado/necessário","crescimento":"lento/médio/rápido","tipoPlanta":"tipo de planta (se flora)",' +
  '"observacoes":"curiosidades e dicas de manutenção","dimorfismo":"como diferenciar MACHO de FÊMEA em poucas palavras (apenas se a espécie tem dimorfismo sexual fácil de ver; senão deixe vazio ' + '""".}. Se o nome não corresponder a uma espécie aquática conhecida de água doce, ' +
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
  if (process.env.FISHIAL_CLIENT_ID && process.env.FISHIAL_CLIENT_SECRET) presentes.push('Fishial');
  if (process.env.GOOGLE_VISION_API_KEY) presentes.push('Google Vision');
  if (process.env.ROBOFLOW_API_KEY) presentes.push('Roboflow');
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
        `&gsrsearch=${encodeURIComponent(termo)}&gsrlimit=8&prop=pageimages|extracts` +
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
      const melhor = ordenadas[0];
      if (melhor.score <= 0) continue;

      const pagina = melhor.p;
      const nomeArquivo = pagina.pageimage || '';
      if (nomeArquivo) {
        const enc = encodeURIComponent(nomeArquivo.replace(/ /g, '_'));
        return `https://${idioma}.wikipedia.org/wiki/Special:FilePath/${enc}?width=480`;
      }
      if (pagina.original && pagina.original.source) return pagina.original.source;
    } catch (e) {
      console.warn(`[buscarImagemWikipedia ${idioma}]`, e.message);
    }
  }
  return '';
}

async function comFoto(r) {
  const enriquecido = await comTimeoutEnriquecimento(r);
  if (!enriquecido.foto) {
    enriquecido.foto = await buscarImagemWikipedia(enriquecido.nomeCientifico || enriquecido.nomeComum || '');
  }
  return enriquecido;
}

async function viaOpenAI(imagem, sistemaCustom) {
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
      max_tokens: 1600,
      messages: [
        {
          role: 'system',
          content: sistemaCustom || montarPromptSistema(),
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
  const dados = JSON.parse(conteudo);
  if (dados.tipo === 'invalido') throw new FotoInvalidaError(dados.motivo);
  if (dados.tipo === 'desconhecido') throw new Error('OpenAI: não reconheceu a imagem');
  return normalizarResultado({ provedor: 'OpenAI', ...dados });
}

// Catálogo de descrições VISUAIS das espécies brasileiras mais comuns
// (gerado offline: dataset/fotos + scripts/gerar-descricoes-visuais.js).
let catalogoVisualCache = null;
function lerCatalogoVisual() {
  if (catalogoVisualCache) return catalogoVisualCache;
  try {
    const raw = fs.readFileSync(path.join(CATALOGOS_DIR, 'faunaBrasileiraVisual.json'), 'utf8');
    catalogoVisualCache = JSON.parse(raw);
    return catalogoVisualCache;
  } catch (e) {
    return { especies: [] };
  }
}

// Provider especializado em FAUNA brasileira de água doce. Usa o catálogo de
// descrições visuais (faunaBrasileiraVisual.json) para montar um prompt focado
// nas espécies mais comuns, com detalhes morfológicos e diferenciação.
// Tem o MAIOR peso do ensemble (3.0) por ser o conhecimento mais relevante.
async function viaFaunaBrasileira(base64, mime) {
  const cat = lerCatalogoVisual();
  const todas = cat.especies || [];
  // Prioriza as não-peixes (invertebrados, anfíbios, répteis — id > 900) para
  // garantir cobertura, e completa com as peixes mais comuns.
  const extras = todas.filter((e) => e.id > 900);
  const peixes = todas.filter((e) => e.id <= 900).slice(0, 55);
  const especies = [...extras, ...peixes];

  if (especies.length === 0) {
    console.warn('[FaunaBrasileira] catálogo visual vazio — pulando.');
    return null;
  }

  const blocos = especies
    .map((e) => {
      const difs = Object.entries(e.diferenciacaoDe || {})
        .map(([sp, desc]) => `  ≠ ${sp}: ${desc}`)
        .join('\n');
      const chaves = (e.caracteristicasChave || []).join('; ');
      return `${e.nomeComum} (${e.nomeCientifico})${e.variedade ? ` — variedade ${e.variedade}` : ''}.\n` +
        `Descrição visual: ${e.descricaoVisual || ''}\n` +
        `Tamanho: ${e.tamanhoCm || '?'} cm. Cores: ${e.coresPredominantes || '?'}.\n` +
        (chaves ? `Chaves: ${chaves}.\n` : '') +
        (difs ? `Diferenciação:\n${difs}\n` : '');
    })
    .join('\n\n');

  const sistemaFaunaBR =
    'Você é especialista em peixes de aquário de ÁGUA DOCE, com foco em espécies populares no Brasil. ' +
    'Compare a foto com as descrições visuais abaixo e identifique a espécie MAIS provável. ' +
    'Use o formato, tamanho, cores, padrões e diferenciações descritos para decidir. ' +
    'Se a foto não corresponder bem a nenhuma, retorne a mais próxima com confiança < 50 e explique em observacoes. ' +
    'NUNCA identifique peixes marinhos. Retorne JSON no formato: ' +
    '{"tipo":"fauna","confianca":0-100,"nomeComum":"nome popular","nomeCientifico":"nome científico","familia":"família",' +
    '"tamanho":"ex: 4-5 cm","temperatura":"ex: 23 - 27 °C","ph":"ex: 6 - 7","dureza":"ex: 5 - 12 °dH",' +
    '"dieta":"tipo de alimentação","comportamento":"comportamento","aquarioMinimo":"ex: 40 L","dificuldade":"fácil/médio/avançado",' +
    '"observacoes":"explicação da identificação e alternativas se houver dúvida"}. ' +
    'CATÁLOGO DE REFERÊNCIA:\n' + blocos;

  // Detector de erro de QUOTA/RATE LIMIT (429) ou serviço indisponível (503).
  // Esses erros indicam que o provedor está temporariamente fora — vale tentar o
  // fallback pago (OpenAI). Erros de conteúdo (foto inválida) NÃO fazem fallback.
  function isQuotaError(msg) {
    return /429|503|quota|rate.?limit|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(String(msg || ''));
  }

  // Tenta Gemini (grátis) primeiro; se exceder a cota, usa OpenAI (pago).
  let resultado = null;
  let geminiErro = '';
  try {
    resultado = await viaGemini(base64, mime, '', sistemaFaunaBR);
  } catch (e) {
    geminiErro = e.message || String(e);
    console.warn('[viaFaunaBrasileira] Gemini falhou:', geminiErro);
  }

  // Se o Gemini não respondeu e há quota erro (ou retorno vazio), usa OpenAI.
  const precisaFallback =
    !resultado || !resultado.nomeCientifico || resultado.nomeCientifico === 'Não identificado' ||
    isQuotaError(geminiErro);

  if (precisaFallback && process.env.OPENAI_API_KEY) {
    try {
      const dataUrl = `data:${mime || 'image/jpeg'};base64,${base64}`;
      resultado = await viaOpenAI(dataUrl, sistemaFaunaBR);
      if (resultado && resultado.nomeCientifico && resultado.nomeCientifico !== 'Não identificado') {
        console.log('[viaFaunaBrasileira] usado OpenAI (fallback do Gemini).');
      }
    } catch (e2) {
      console.warn('[viaFaunaBrasileira] OpenAI fallback falhou:', e2.message);
    }
  }

  if (resultado && resultado.nomeCientifico && resultado.nomeCientifico !== 'Não identificado') {
    resultado.provedor = 'FaunaBrasileira';
  }
  return resultado || null;
}

async function viaGemini(base64, mime, textoExtra, sistemaPrompt) {
  const modelo = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const system = sistemaPrompt || montarPromptSistema();
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
          maxOutputTokens: 1800,
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
  const dados = JSON.parse(conteudo);
  if (dados.tipo === 'invalido') throw new FotoInvalidaError(dados.motivo);
  if (dados.tipo === 'desconhecido') throw new Error('Gemini: não reconheceu a imagem');
  return normalizarResultado({ provedor: 'Gemini', ...dados });
}

// PASSO B — Ficha por NOME (sem imagem): o "palpite web" (nomeAncora da Google
// Vision) vira a âncora e o Gemini TEXTO monta a ficha completa (barato, sem
// gastar visão). Evita que o Gemini alucine vendo a foto e melhora a ficha
// quando o nome vem da web. Reusa o formato de /buscar-nome (PROMPT_BUSCA_NOME).
async function viaGeminiTextoFicha(nome) {
  return viaGemini(null, null, nome, PROMPT_BUSCA_NOME);
}

// Refino de decisão: quando os provedores discordam ou a confiança é baixa, uma
// chamada extra do Gemini Flash vê a foto + a lista curta de candidatos e
// escolhe a espécie final (restringida à lista). Custo baixo (~US$ 0,002) e só
// dispara em caso de dúvida.
const PROMPT_REFINO_CANDIDATOS =
  'Você é um ictiólogo especialista em peixes e invertebrados de aquário de água doce. ' +
  'Vários sistemas identificaram a foto com resultados DIVERGENTES. Sua tarefa é escolher, ENTRE OS ' +
  'CANDIDATOS ABAIXO, a espécie que MELHOR corresponde à foto. ' +
  'Compare: forma e altura do corpo, padrão de listras/manchas, cores, formato e posição das nadadeiras, ' +
  'cauda, boca e olhos. Não escolha por semelhança superficial. ' +
  'Se houver dúvida real entre dois candidatos, escolha o mais provável e baixe a confianca (40-55), ' +
  'explicando a dúvida em "observacoes". ' +
  'Responda APENAS com JSON válido no formato: ' +
  '{"tipo":"fauna","confianca":0 a 100,"nomeComum":"nome popular em português","nomeCientifico":"nome científico",' +
  '"familia":"família","origem":"origem","tamanho":"ex: até 5 cm","temperatura":"ex: 23 - 27 °C","ph":"ex: 6,0 - 7,0",' +
  '"dureza":"ex: 5 - 12 °dH","dieta":"alimentação","comportamento":"comportamento","aquarioMinimo":"ex: 40 L",' +
  '"dificuldade":"fácil/médio/avançado","iluminacao":"baixa/média/alta","co2":"opcional/recomendado/necessário",' +
  '"crescimento":"lento/médio/rápido","tipoPlanta":"","observacoes":"curtas"}. ' +
  'A espécie escolhida DEVE ser um dos CANDIDATOS.';

async function viaGeminiRefino(base64, mime, candidatos) {
  const modelo = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(REFINO_TIMEOUT_MS),
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
              { text: `Escolha a melhor espécie entre: ${candidatos}.` },
            ],
          },
        ],
        systemInstruction: { parts: [{ text: PROMPT_REFINO_CANDIDATOS }] },
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 700,
        },
      }),
    }
  );
  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error(`Gemini refino (HTTP ${res.status}): ${texto.slice(0, 300)}`);
  }
  const json = await res.json();
  const conteudo = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  if (!conteudo) throw new Error('Gemini refino: resposta vazia');
  const dados = JSON.parse(conteudo);
  if (dados.tipo !== 'fauna') throw new Error('Gemini refino: não é fauna');
  return normalizarResultado({ provedor: 'Gemini', ...dados });
}

async function validarFotoGemini(base64, mime, prompt, timeoutMs) {
  const modelo = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs || VALIDACAO_TIMEOUT_MS),
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
  const dados = JSON.parse(conteudo);
  return { valida: !!dados.valida, motivo: dados.motivo || '' };
}

async function validarFotoOpenAI(dataUrl, prompt, timeoutMs) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs || VALIDACAO_TIMEOUT_MS),
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
  const dados = JSON.parse(conteudo);
  return { valida: !!dados.valida, motivo: dados.motivo || '' };
}

// Pré-classificação barata com Gemini: a foto é FAUNA ou FLORA? Usada para
// escolher a ordem dos provedores especialistas (planta → PlantNet/Google;
// peixe → Google/Fishial) antes de gastar os créditos de identificação.
async function classificarTipoGemini(base64, mime) {
  const modelo = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const PROMPT_TIPO =
    'Analise a imagem e responda APENAS com um JSON válido: {"tipo":"fauna"|"flora"|"outro"}. ' +
    '"fauna" = peixe, camarão, caramujo, caranguejo, lagosta, tartaruga ou outro animal aquático de água doce; ' +
    '"flora" = planta aquática, alga, musgo, samambaia ou outra vegetação; ' +
    '"outro" = qualquer outra coisa (pessoa, pet terrestre, objeto, paisagem, comida etc.).';
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
              { text: 'Classifique o tipo do ser vivo na imagem.' },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 40,
        },
      }),
    }
  );
  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error(`Gemini classificação (HTTP ${res.status}): ${texto.slice(0, 200)}`);
  }
  const json = await res.json();
  const conteudo = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!conteudo) return 'outro';
  const dados = JSON.parse(conteudo.replace(/```json|```/g, '').trim());
  const tipo = String((dados && dados.tipo) || 'outro').toLowerCase();
  return tipo === 'fauna' || tipo === 'flora' ? tipo : 'outro';
}

// Endpoint leve para keep-alive externo (UptimeRobot, cron-job.org, Kaffeine,
// etc.): resposta mínima para manter o Render free acordado 24/7, garantindo
// que o scheduler de Web Push rode no horário mesmo com o app fechado.
app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get('/', (req, res) => {
  // Navegadores recebem o app dos testadores (mesma origem da IA: sem CORS).
  // Clientes de API/monitoramento continuam recebendo o JSON de status.
  if (SERVIR_TESTER && TEM_TESTER_APP && String(req.headers.accept || '').includes('text/html')) {
    return res.sendFile(TESTER_INDEX);
  }
// original:
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
        Trefle: !!process.env.TREFLE_TOKEN,
        INaturalist: true,
        FishBase: true,
        SpeciesLink: true,
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

  // CACHE de identificações: mesma foto (hash da imagem) → mesmo resultado por
  // até 30 dias. Evita gastar créditos de IA repetidamente e responde instantâneo.
  const hashCache = cacheStore.gerarHash(base64);
  const cacheHit = hashCache ? cacheStore.buscar(hashCache) : null;
  if (cacheHit && cacheHit.nomeCientifico) {
    console.log(`[identify] CACHE HIT (${hashCache.slice(0, 12)}…) → ${cacheHit.nomeCientifico}`);
    return res.json({ ...cacheHit, cache: true });
  }

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

  const resultados = [];
  // Todos os provedores rodam EM PARALELO: o tempo total ≈ o provedor mais
  // lento (não a soma), evitando estourar o timeout de 60s do app. A escolha
  // final é feita pelo ensemble ponderado, então a ordem de chamada não importa
  // (a pré-classificação Gemini foi removida por ser uma chamada redundante).
  const provedores = [
    ['FaunaBrasileira', () => viaFaunaBrasileira(base64, prefixo), () => true],
    ['GoogleVision', () => viaGoogleVision(base64, prefixo), () => !!process.env.GOOGLE_VISION_API_KEY],
    ['Fishial', () => viaFishial(base64, prefixo), () => !!(process.env.FISHIAL_CLIENT_ID && process.env.FISHIAL_CLIENT_SECRET)],
    ['PlantNet', () => viaPlantNet(base64, prefixo), () => !!process.env.PLANTNET_API_KEY],
    ['Gemini', () => viaGemini(base64, prefixo), () => !!process.env.GEMINI_API_KEY],
    ['OpenAI', () => viaOpenAI(dataUrl), () => !!process.env.OPENAI_API_KEY],
  ];
  const ativos = provedores.filter(([, , habilitado]) => habilitado());
  const nomesAtivos = ativos.map(([nome]) => nome);
  const resultadosParalelos = await Promise.allSettled(ativos.map(([, fn]) => fn()));
  resultadosParalelos.forEach((s, i) => {
    const nome = nomesAtivos[i];
    if (s.status === 'fulfilled') {
      resultados.push({ nome, r: s.value });
    } else {
      console.error(`Falha ${nome}:`, s.reason && s.reason.message);
      if (s.reason instanceof FotoInvalidaError) {
        erros.push(`${nome} (foto inválida): ${s.reason.message}`);
      } else {
        erros.push(`${nome}: ${s.reason && s.reason.message}`);
      }
    }
  });

  // Enriquecimento complementar:
  //  - Se identificou FLORA, consulta o Trefle (base botânica) para validar/refinar.
  //  - Se identificou FAUNA, consulta o SpeciesLink (biodiversidade BR) e anota
  //    se a espécie tem ocorrência no Brasil (enriquecimento, sem substituir).
  const comTipo = (t) => resultados.filter((x) => x.r && x.r.tipo === t);
  const melhorFlora = comTipo('flora').sort((a, b) => (Number(b.r.confianca) || 0) - (Number(a.r.confianca) || 0))[0];
  if (melhorFlora && process.env.TREFLE_TOKEN) {
    try {
      const trefle = await viaTrefle(melhorFlora.r.nomeCientifico || melhorFlora.r.nomeComum);
      if (trefle && trefle.nomeCientifico) {
        resultados.push({ nome: 'Trefle', r: trefle });
      }
    } catch (e) {
      console.error('Falha Trefle (enriquecimento):', e.message);
      erros.push(`Trefle: ${e.message}`);
    }
  }
  const melhorFauna = comTipo('fauna').sort((a, b) => (Number(b.r.confianca) || 0) - (Number(a.r.confianca) || 0))[0];
  if (melhorFauna && process.env.SPECIESLINK_API_KEY) {
    try {
      const spl = await viaSpeciesLink(melhorFauna.r.nomeCientifico);
      if (spl && spl.nomeCientifico) {
        resultados.push({ nome: 'SpeciesLink', r: spl });
      }
    } catch (e) {
      console.error('Falha SpeciesLink (enriquecimento):', e.message);
      erros.push(`SpeciesLink: ${e.message}`);
    }
  }

  if (resultados.length > 0) {
    // PASSO B — "palpite web" como âncora de ficha: quando a Google Vision
    // apontou um nome (nomeAncora), o Gemini TEXTO monta a ficha completa
    // (sem imagem, barato). Esse resultado entra no ensemble como "FichaTexto":
    // concorda com a Vision (bônus de concordância) e preenche a ficha.
    let ancoraFicha = null;
    {
      const gv = resultados.find((x) => x.nome === 'GoogleVision' && x.r && x.r.nomeAncora);
      if (gv && process.env.GEMINI_API_KEY) {
        try {
          const ficha = await viaGeminiTextoFicha(gv.r.nomeAncora);
          if (ficha && ficha.nomeCientifico && ficha.nomeCientifico !== 'Não identificado') {
            ancoraFicha = { nomeAncora: gv.r.nomeAncora, ficha };
            resultados.push({ nome: 'FichaTexto', r: { ...ficha, provedor: 'FichaTexto' } });
          }
        } catch (e) {
          console.warn('Passo B (ficha por nome) falhou:', e.message);
          erros.push(`FichaTexto: ${e.message}`);
        }
      }
    }

    // Confiança PONDERADA + ENSEMBLE: especialistas valem mais que IAs
    // genéricas, mas a concordância entre provedores (mesma espécie canônica)
    // e a canonicalização no catálogo entram na decisão.
    const PESOS = {
      FaunaBrasileira: 3.0,
      GoogleVision: 2.5,
      Fishial: 2.0,
      PlantNet: 2.5,
      Trefle: 1.5,
      SpeciesLink: 1.3,
      Gemini: 1.0,
      OpenAI: 1.0,
      FichaTexto: 1.0,
    };
    const pesoDe = (x) =>
      x.nome === 'GoogleVision' && x.r && x.r.tipo === 'flora' ? 2.0 : PESOS[x.nome] || 1.0;

    // Agrupa por espécie canônica (resolvida no catálogo) para medir concordância.
    const ident = resultados.filter((x) => x.nome !== 'SpeciesLink' && x.nome !== 'Trefle');
    const grupos = new Map();
    for (const x of ident) {
      const chave = chaveCanonica(x.r) || `__${x.nome}`;
      if (!grupos.has(chave)) grupos.set(chave, []);
      grupos.get(chave).push(x);
    }
    const divergencia = grupos.size > 1;
    const pontuaGrupo = (lista) => {
      let s = 0;
      let maiorConf = 0;
      for (const x of lista) {
        const c = Number(x.r && x.r.confianca) || 0;
        if (c > maiorConf) maiorConf = c;
        s += c * pesoDe(x);
      }
      if (lista.length >= 2) s += 15; // bônus de concordância
      if (lista.some((x) => x.nome === 'SpeciesLink')) s -= 40;
      // Sem concordância, um Google Vision isolado não domina pelo multiplicador
      // 2.5 sozinho: cai para a confiança crua (o refino decide quando divergir).
      if (divergencia && lista.length === 1 && lista[0].nome === 'GoogleVision') {
        s = maiorConf;
      }
      return s;
    };
    let melhorGrupo = null;
    let melhorScore = -Infinity;
    let segundoMelhorScore = -Infinity;
    for (const [, lista] of grupos) {
      const s = pontuaGrupo(lista);
      if (s > melhorScore) {
        segundoMelhorScore = melhorScore;
        melhorScore = s;
        melhorGrupo = lista;
      } else if (s > segundoMelhorScore) {
        segundoMelhorScore = s;
      }
    }
    const candidatosMelhor = [...melhorGrupo]
      .filter((x) => x.nome !== 'SpeciesLink')
      .sort((a, b) => (Number(b.r.confianca) || 0) - (Number(a.r.confianca) || 0));
    let melhor = candidatosMelhor[0] || melhorGrupo[0];

    // Proteção fauna-vs-flora: se o melhor por pontuação é uma planta (PlantNet/
    // Trefle) mas uma IA de visão (Google Vision/Gemini/OpenAI) apontou FAUNA com
    // confiança razoável, prioriza a fauna (evita "peixe → planta").
    const vision = resultados.filter(
      (x) => (x.nome === 'GoogleVision' || x.nome === 'Gemini' || x.nome === 'OpenAI') && x.r && x.r.tipo === 'fauna'
    );
    if (
      (melhor.nome === 'PlantNet' || melhor.nome === 'Trefle') &&
      melhor.r && melhor.r.tipo === 'flora' && vision.length > 0
    ) {
      const visaoTop = vision.sort((a, b) => (Number(b.r.confianca) || 0) - (Number(a.r.confianca) || 0))[0];
      if ((Number(visaoTop.r.confianca) || 0) >= 60) melhor = visaoTop;
    }

    // Proteção inversa: o FaunaBrasileira é especialista em FAUNA. Se ele venceu
    // (peso 3.0) mas PlantNet/GoogleVision apontaram FLORA com confiança alta,
    // prioriza a flora (evita "planta → peixe"). Também reduz o impacto do
    // FaunaBrasileira quando a confiança dele é baixa (< 50) e há alternativa.
    const flora = resultados.filter(
      (x) => (x.nome === 'PlantNet' || x.nome === 'GoogleVision') && x.r && x.r.tipo === 'flora'
    );
    if (
      melhor.nome === 'FaunaBrasileira' &&
      melhor.r && melhor.r.tipo === 'fauna' && flora.length > 0
    ) {
      const floraTop = flora.sort((a, b) => (Number(b.r.confianca) || 0) - (Number(a.r.confianca) || 0))[0];
      const confFauna = Number(melhor.r.confianca) || 0;
      const confFlora = Number(floraTop.r.confianca) || 0;
      if (confFlora >= 70 && confFlora > confFauna) {
        melhor = floraTop;
      } else if (confFauna < 50 && confFlora >= 60) {
        melhor = floraTop;
      }
    }

    // REFINO com Gemini quando há dúvida (discordância ou confiança baixa): a
    // imagem + a lista curta de candidatos decide a espécie final (fauna).
    // OTIMIZAÇÃO DE CHAMADAS: se o FaunaBrasileira (especialista brasileiro,
    // peso 3.0) deu confiança >= 80, o refino é desnecessário — evita 1 chamada
    // extra de IA por foto (aumenta a capacidade da quota gratuita).
    if (process.env.GEMINI_API_KEY && melhor.r && melhor.r.tipo === 'fauna') {
      const confiancaMelhor = Number(melhor.r.confianca) || 0;
      const faunabrConfiavel =
        melhor.nome === 'FaunaBrasileira' && confiancaMelhor >= 80;
      const gruposTop = [...grupos.entries()]
        .sort((a, b) => pontuaGrupo(b[1]) - pontuaGrupo(a[1]))
        .slice(0, 3);
      const nomesCandidatos = [];
      const vistosC = new Set();
      for (const [, lista] of gruposTop) {
        for (const x of lista) {
          const e = resolverNoCatalogo(x.r);
          const ci = (e && e.nomeCientifico) || x.r.nomeCientifico || '';
          const nc = String(x.r.nomeComum || '').trim();
          const chave = `${ci}|${nc}`;
          if (!vistosC.has(chave)) { vistosC.add(chave); nomesCandidatos.push(`${nc} (${ci})`); }
        }
      }
      // Dispara apenas em dúvida real: top-2 grupos próximos OU confiança baixa.
      // Com FaunaBrasileira confiável (>=80), pula o refino (economia de 1 chamada).
      const precisaRefino =
        !faunabrConfiavel &&
        ((divergencia && segundoMelhorScore >= melhorScore - 15) || confiancaMelhor < 55);
      if (nomesCandidatos.length >= 2 && precisaRefino) {
        try {
          const refino = await viaGeminiRefino(base64, prefixo, nomesCandidatos.join('; '));
          const refinoFinal = aplicarFichaCanonica(refino, resolverNoCatalogo(refino));
          if (refinoFinal.nomeCientifico && refinoFinal.nomeCientifico !== 'Não identificado') {
            melhor.nome = 'Gemini';
            melhor.r = refinoFinal;
          }
        } catch (e) {
          console.warn('Refino Gemini falhou, mantendo ensemble:', e.message);
        }
      }
    }

    // Enriquecimento SpeciesLink: ocorrência no Brasil NÃO é origem nativa
    // (ex.: axolote mexicano pode ter registro em zoológico brasileiro).
    // Por isso, NUNCA sobrescreve o campo origem — apenas anexa a observação.
    // A origem autoritativa vem do catálogo via aplicarFichaCanonica abaixo.
    const splEnriq = resultados.find((x) => x.nome === 'SpeciesLink' && x.r);
    if (splEnriq && melhor.nome !== 'SpeciesLink') {
      const obsSpl = splEnriq.r.observacoes;
      if (obsSpl) {
        melhor.r.observacoes = [melhor.r.observacoes, obsSpl].filter(Boolean).join(' ');
      }
    }

    // Canonicaliza o vencedor para a espécie do catálogo (ficha consistente).
    if (melhor && melhor.r) {
      melhor.r = aplicarFichaCanonica(melhor.r, resolverNoCatalogo(melhor.r));
    }
    // Merge da ficha do Passo B (Gemini texto) como fallback dos campos que o
    // vencedor ainda não preencheu (ex.: GoogleVision devolve '—' em quase tudo).
    if (ancoraFicha) {
      const alvo = melhor.r || {};
      const fb = ancoraFicha.ficha || {};
      const camposFicha = ['familia', 'origem', 'tamanho', 'temperatura', 'ph', 'dureza', 'dieta',
        'comportamento', 'aquarioMinimo', 'dificuldade', 'iluminacao', 'co2', 'crescimento',
        'tipoPlanta', 'observacoes', 'nomesPopulares'];
      for (const campo of camposFicha) {
        const atual = alvo[campo];
        const v = fb[campo];
        if ((!atual || atual === '—' || atual === '') && v && v !== '—' && v !== '') {
          alvo[campo] = v;
        }
      }
      alvo.nomeAncora = ancoraFicha.nomeAncora;
      melhor.r = alvo;
    }
    const enr = await comFoto(melhor.r);
    // Une as opções dos demais provedores quando houver divergência, com score.
    const opcoesExtras = resultados
      .filter((x) => x !== melhor && x.r && x.r.nomeComum && x.nome !== 'SpeciesLink' && x.nome !== 'FichaTexto')
      .map((x) => {
        const peso = pesoDe(x);
        const c = Number(x.r.confianca) || 0;
        return { provedor: x.nome, score: Math.round(c * peso), ...x.r };
      })
      .filter((o) => o.nomeComum && o.nomeComum !== enr.nomeComum);
    // Ordena por score (melhor primeiro) e limita a 3 alternativas.
    const alternativas = opcoesExtras
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
      .slice(0, 3);
    if (alternativas.length > 0) {
      enr.opcoes = [...(enr.opcoes || []), ...alternativas];
      enr.alternativas = alternativas;
    }
    // Classificação da confiança geral da identificação.
    const confPrincipal = Number(enr.confianca) || 0;
    enr.confiancaGeral =
      confPrincipal >= 80 ? 'alta' : confPrincipal >= 60 ? 'media' : 'baixa';
    enr.provedor = melhor.nome;
    enr.nomeAncora = (melhor.r && melhor.r.nomeAncora) || null;
    enr.fotoEscura = !!(melhor.r && melhor.r.fotoEscura);
    if (hashCache) {
      cacheStore.salvarResultado(hashCache, {
        provedor: enr.provedor,
        confianca: enr.confianca,
        tipo: enr.tipo,
        nomeComum: enr.nomeComum,
        nomeCientifico: enr.nomeCientifico,
        familia: enr.familia,
        origem: enr.origem,
        tamanho: enr.tamanho,
        temperatura: enr.temperatura,
        ph: enr.ph,
        dureza: enr.dureza,
        dieta: enr.dieta,
        comportamento: enr.comportamento,
        aquarioMinimo: enr.aquarioMinimo,
        dificuldade: enr.dificuldade,
        iluminacao: enr.iluminacao,
        co2: enr.co2,
        crescimento: enr.crescimento,
        tipoPlanta: enr.tipoPlanta,
        observacoes: enr.observacoes,
        foto: enr.foto,
        nomeAncora: enr.nomeAncora || null,
        opcoes: enr.opcoes || [],
        alternativas: enr.alternativas || [],
        confiancaGeral: enr.confiancaGeral || null,
      });
    }
    return res.json(enr);
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

  const { aquario } = req.body || {};

  const baseDoNovo =
    `Novo peixe: ${novoPeixe.nomeComum || ''} (${novoPeixe.nomeCientifico}). ` +
    (novoPeixe.tamanho ? `Tamanho adulto: ${novoPeixe.tamanho}. ` : '') +
    (novoPeixe.comportamento ? `Comportamento: ${novoPeixe.comportamento}. ` : '') +
    (novoPeixe.dieta ? `Dieta: ${novoPeixe.dieta}. ` : '') +
    (novoPeixe.temperatura ? `Temperatura: ${novoPeixe.temperatura}. ` : '') +
    (novoPeixe.ph ? `pH: ${novoPeixe.ph}. ` : '');

  const litros = aquario?.litros || '';
  const tipoAquario = aquario?.tipo || '';
  const descricaoAquario =
    (litros ? `Capacidade do aquário: ${litros} L. ` : 'Capacidade do aquário: não informada. ') +
    (tipoAquario ? `Tipo do aquário: ${tipoAquario}. ` : '');

  const textoFauna = (faunaExistente || [])
    .map((f, i) => {
      const qtd = f.quantidade ? ` (${f.quantidade}x)` : '';
      let linha = `${i + 1}. ${f.nomeComum || f.nome || ''} (${f.nomeCientifico || '?'})${qtd}`;
      if (f.tamanho) linha += ` | Tamanho: ${f.tamanho}`;
      if (f.comportamento) linha += ` | Comportamento: ${f.comportamento}`;
      if (f.dieta) linha += ` | Dieta: ${f.dieta}`;
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
    `${baseDoNovo}\n${descricaoAquario}\nPeixes já existentes no aquário: ${textoFauna || 'nenhum'}\nParâmetros da água: ${textoAgua || 'não informados'}` +
    `\nAvalie se ${novoPeixe.nomeComum || novoPeixe.nomeCientifico} pode ser adicionado a este aquário.`;

  const erros = [];
  console.log(`[compatibilidade] novo=${novoPeixe.nomeCientifico} | fauna=${(faunaExistente || []).length}`);

  if (process.env.GEMINI_API_KEY) {
    try {
      const modelo = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
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
      const modelo = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
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
      'Amazônico: água ácida (pH 6.0-7.0) e muito mole, temperatura quente (24-28 °C), rica em troncos. ' +
      'IMPORTANTE — sugira espécies ESPECÍFICAS, NUNCA genéricos como "peixe amazônico". Prefira nomes concretos: ' +
      '"Acará-bandeira" (Pterophyllum scalare), "Acará-disco" (Symphysodon aequifasciatus), "Neon" (Paracheirodon innesi), ' +
      '"Cardinal" (Paracheirodon axelrodi), "Corydora" (ex.: Corydoras panda / aeneus), "Cascudo" (ex.: Ancistrus / Hypancistrus), ' +
      '"Tetra-limon" (Hyphessobrycon pulchripinnis), "Acará-azul" (Aequidens pulcher), "Ramirezi" (Mikrogeophagus ramirezi), "Apistogramma". ' +
      'Escolha 4 a 8 espécies compatíveis entre si, com quantidades realistas para o volume. ' +
      'Flora: Echinodorus (ex.: Echinodorus amazonicus, "Chá-chá"), Vallisneria, Microsorum pteropus ("samambaia de Java").',
    'agua-negra':
      'Água negra (blackwater, afluentes do Rio Negro): água muito escura (cor de chá) por taninos de folhas e troncos, iluminação muito baixa, pH muito baixo (5.0-6.0). ' +
      'IMPORTANTE — sugira espécies ESPECÍFICAS: "Neon" (Paracheirodon innesi), "Cardinal" (Paracheirodon axelrodi), ' +
      '"Tetra-fantasma" (Hyphessobrycon sweglesi), "Acará-bandeira" (Pterophyllum scalare), "Ramirezi" (Mikrogeophagus ramirezi), ' +
      '"Apistogramma" (ex.: Apistogramma agassizii), "Corydora" (Corydoras), "Otocinclus". ' +
      'Escolha 4 a 8 espécies compatíveis, com quantidades realistas para o volume.',
    americana:
      'Americana (rios de correnteza e lagos da América Central): água alcalina e dura, decoração de rochas e poucos troncos. ' +
      'IMPORTANTE — sugira espécies ESPECÍFICAS, NUNCA genéricos: "Jack Dempsey" (Rocio octofasciata), "Ciclídeo boca de fogo" (Thorichthys meeki), ' +
      '"Tilápia do Nilo" (Oreochromis niloticus), "Acará-da-floresta" (Mesonauta festivus), vivíparos "Guppy" (Poecilia reticulata), ' +
      '"Plati" (Xiphophorus maculatus), "Molinésia" (Poecilia sphenops), "Espada" (Xiphophorus hellerii). ' +
      'Escolha 4 a 8 espécies compatíveis, com quantidades realistas para o volume.',
    asiatica:
      'Asiática (rios e pântanos do Sudeste Asiático): água levemente ácida a neutra, fluxo lento ou estagnado, vegetação abundante. ' +
      'IMPORTANTE — sugira espécies ESPECÍFICAS, NUNCA genéricos: "Beta" (Betta splendens), "Gourami-pigmeu" (Trichogaster lalius), ' +
      '"Gourami-beijador" (Helostoma temminckii), "Rasbora" (ex.: Rasbora heteromorpha), "Danio" (Danio rerio), "Barbo" (Puntius tetrazona), ' +
      '"Cobrinha kuhli" (Pangio kuhlii), "Garra/flathead". ' +
      'Flora: Cryptocorynes, higrófilas (Hygrophila) e samambaias de Java (Microsorum). ' +
      '(Há também a variação de correnteza/hillstream: água fria, muito oxigenada, correnteza forte; cobrinhas kuhli e peixes-ventosa (Gastromyzon).)',
    africana:
      'Africana (grandes lagos do Rift — Malawi, Tanganyika e Victoria): água muito alcalina (pH 7.8-8.6) e muito dura, decoração de rochas empilhadas, quase sem troncos. ' +
      'IMPORTANTE — sugira espécies ESPECÍFICAS, NUNCA o genérico "ciclídeo do Malawi". Prefira nomes concretos e bem conhecidos de cada grupo: ' +
      '"Aulonocara" (ex.: Aulonocara stuartgranti — "Peacock"), "golfinho do Malawi" (Cyrtocara moorii), "Labidochromis caeruleus" (Yellow Lab / "auratus" é outro, o Labidochromis é amarelo), ' +
      '"Pseudotropheus zebra" / "Maylandia zebra" (Zebra), "Melanochromis auratus" (Auratus, listras amarelas e pretas), "Pseudotropheus acei" (Acei), "Tropheus" (Tanganyika), ' +
      '"Altolamprologus compressiceps", "Lamprologus"/"Neolamprologus" (ex.: N. brichardi), "Julidochromis". ' +
      'Escolha 3 a 6 espécies compatíveis entre si, com quantidades realistas para o volume, e indique o nome popular e o científico de cada uma. ' +
      'Flora: quase inexistente (apenas Anúbias resistentes). ' +
      '(Rios do oeste africano: água ácida a neutra, troncos e vegetação; kribensis (Pelvicachromis) e peixes-elefante (Gnathonemus).)',
    australiana:
      'Australiana/Papua Nova Guiné: água neutra a levemente alcalina, vegetação esparsa, boa iluminação. ' +
      'IMPORTANTE — sugira espécies ESPECÍFICAS: "Arco-íris" (ex.: Melanotaenia boesemani, Melanotaenia praecox "arco-íris anão", ' +
      'Melanotaenia lacustris "arco-íris do Lago Kutubu"), "Pseudo-mugil" (Pseudomugil furcatus), "Rhinogobius". ' +
      'Escolha 4 a 8 espécies compatíveis, com quantidades realistas para o volume.',
    primitiva:
      'Peixes primitivos/antigos de água doce (fósseis vivos). IMPORTANTE — sugira espécies ESPECÍFICAS e icônicas: ' +
      '"Bichir" / "Polypterus" (Polypterus senegalus, Polypterus delhezi, Polypterus ornatipinnis), "Protopterus" (Protopterus annectens, "peixe-pulmonado africano"), ' +
      '"Peixe-espatula" (Polyodon spathula, "peixe-espátula"), "Peixe-faca" (Chitala ornata, "peixe-faca listrado"; Gymnotus, "sarapó"), ' +
      '"Pirarucu" (Arapaima gigas), "Peixe-agulha" (Xenentodon cancila, "peixe-agulha asiático"), "Esturjão" (Acipenser, "sturgeon"), ' +
      '"Celacanto" (Latimeria — note: é marinho, NÃO deve ser mantido em aquário de água doce; se o usuário pedir, oriente que é inviável em aquário), ' +
      '"Arowana" (Osteoglossum bicirrhosum "arowana prata", Scleropages), "Peixe-elefante" (Gnathonemus petersii), "Tetra de vidro" (Gymnocharacinus). ' +
      'Priorize espécies de água doce viáveis em aquário e compatíveis entre si; escolha 3 a 5 espécies com quantidades realistas para o volume. ' +
      'Para espécies muito grandes (pirarucu, esturjão, arowana), verifique se o volume é suficiente e avise em "agua.nota" quando não for.',
    exotica:
      'Fauna exótica/diferenciada de água doce. IMPORTANTE — sugira espécies ESPECÍFICAS e incomuns: "Arco-íris" (Melanotaenia), ' +
      '"Ciclídeo de Uaru" (Uaru amphiacanthoides), "Peixe-folha" (Polycentrus), "Nandus", "Ctenopoma" (Ctenopoma acutirostre), "Rasbora galaxy" (Danio margaritatus). ' +
      'Escolha 3 a 6 espécies compatíveis, com quantidades realistas para o volume.',
    nanofauna:
      'Nanofauna (espécies pequenas, ideais para aquários nano de até ~40 L). IMPORTANTE — sugira espécies ESPECÍFICAS e pequenas: ' +
      '"Tetra-cobre" (Hasemania nana), "Danio margaritatus" (Galaxy), "Boraras brigittae" (Micro-rasbora), "Microrasbora kubotai", ' +
      '"Guppy-endler" (Poecilia wingei), "Otocinclus", "Camarão-red cherry" (Neocaridina davidi), "Caramujo-nero" (Neritina). ' +
      'Escolha 4 a 8 espécies compatíveis e diminutas, com quantidades realistas para o volume.',
    invertebrados:
      'Aquário de invertebrados (com camarões, caramujos/ampularias, lagostas e, se quiser, poucos peixes pequenos compatíveis). ' +
      'IMPORTANTE — sugira espécies ESPECÍFICAS e compatíveis: "Camarão-red cherry" (Neocaridina davidi), "Camarão-amano" (Caridina multidentata), ' +
      '"Camarão-crystal" (Caridina cantonensis), "Camarão-blue velvet / blue dream" (Neocaridina davidi azul), "Lagosta azul da Flórida" (Procambarus clarkii, "blue lobster"), ' +
      '"Lagosta anã" (Cambarellus), "Ampulária" (Pomacea bridgesii / Pomacea diffusa, "caramujo-mistério"), "Caramujo-zebra" (Vittina natalensis), ' +
      '"Caramujo-nero" (Neritina), "Planorbis" (Planorbarius), "Caramujo-trombeta malaia" (Melanoides tuberculata), "Caranguejo de água doce" (Sesarma). ' +
      'Atenção à compatibilidade: lagostas (Procambarus) predam camarões e podem destruir plantas — sugira apenas UM grande predador OU só camarões/caramujos, nunca misture lagosta grande com camarões. ' +
      'Escolha 3 a 6 espécies compatíveis, com quantidades realistas para o volume, e avise em "agua.nota" sobre água (GH/KH e temperatura) adequada aos invertebrados escolhidos.',
    sem:
      'Sem preferência específica de biótopo — monte um aquário comunitário equilibrado, variado e compatível. ' +
      'Sugira espécies ESPECÍFICAS de fácil manutenção (ex.: Neons, Corydoras, Otocinclus, guppys, tetras) com quantidades realistas para o volume.',
  };

  // Se o usuário marcar "sem preferência", o app escolhe uma das categorias de
  // fauna aleatoriamente e monta o resultado com base nela.
  const CATEGORIAS_FAUNA = Object.keys(BIOTOPOS).filter((k) => k !== 'sem');
  let faunaEscolhida = tipoFauna || 'sem';
  if (faunaEscolhida === 'sem' || !BIOTOPOS[faunaEscolhida]) {
    faunaEscolhida = CATEGORIAS_FAUNA[Math.floor(Math.random() * CATEGORIAS_FAUNA.length)];
  }

  const biotopoTexto = `\nTipo de fauna / biótopo: ${BIOTOPOS[faunaEscolhida]}`;

  const pergunta =
    `Volume pretendido: ${volume} L.\nTipo de aquário: ${tipoAquario}.` +
    biotopoTexto +
    `\nMonte a sugestão completa de fauna, flora, água e equipamentos para este aquário novo.`;

  console.log(`[sugestao-aquario] litros=${volume} | tipo=${tipoAquario} | fauna=${faunaEscolhida}`);

  try {
    const dados = await viaIAVision({
      imagem: null,
      systemPrompt: PROMPT_SUGESTAO_AQUARIO,
      userText: pergunta,
    });
    return res.json({
      litros: volume,
      tipo: tipoAquario,
      tipoFauna: faunaEscolhida,
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
    ? `Qualidade da água: ${qualidade.descricao || qualidade.nivel || 'sem dados'}.${qualidade.alertas && qualidade.alertas.length ? ` Alertas: ${qualidade.alertas.join('; ')}.` : ''}` +
      (Array.isArray(qualidade.detalhes) && qualidade.detalhes.length
        ? ` Parâmetros medidos (valor [selo]): ${qualidade.detalhes
            .map((d) => `${d.titulo || d.campo}: ${d.valor}${d.unidade ? ` ${d.unidade}` : ''} [${d.selo || 'sem selo'}]`)
            .join('; ')}.`
        : '') +
      (Array.isArray(qualidade.historico) && qualidade.historico.length > 1
        ? ` Histórico evolutivo (da mais recente para a mais antiga): ${qualidade.historico
            .map(
              (h, i) =>
                `#${i + 1} (${h.criadoEm ? new Date(h.criadoEm).toLocaleDateString('pt-BR') : '?'}): ` +
                (Array.isArray(h.detalhes) && h.detalhes.length
                  ? h.detalhes.map((d) => `${d.titulo || d.campo}=${d.valor}${d.unidade ? d.unidade : ''}[${d.selo || ''}]`).join(', ')
                  : 'sem medições')
            )
            .join(' | ')}.`
        : '')
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
  '(1) CONSIDERE TODA A FAUNA: você recebe a lista de peixes com a quantidade de cada espécie (ex.: "Neon (10x)"). ' +
  'Analise CADA espécie: porte, boca (pequena/média/grande), hábito (superfície, meio-d\u00e1gua, fundo), dieta ' +
  '(carnívora, herbívora, onívora) e se há filhotes (alevinos) ou invertebrados (camarões, caramujos, lagostas) na fauna. ' +
  'Peixes de fundo (coridoras, cascudos, botias, labeos) precisam de alimento que afunde (pastilha/tablete); ' +
  'alevinos precisam de alimento fino/esfarelável; invertebrados têm necessidades específicas. ' +
  '(2) FAÇA UM MIX ADEQUADO: se o estoque tiver rações que atendem faunas diferentes (ex.: flocos para onívoros de ' +
  'superfície/meio + pastilha que afunda para peixes de fundo + alimento fino para alevinos/invertebrados), ' +
  'COMBINE-AS ao longo da semana para que TODA a fauna seja alimentada corretamente. Preencha "alimentacao" com o ' +
  'nome da ração e "observacoes" indicando a que público se destina (ex.: "pastilha para peixes de fundo"). ' +
  'Se um dia precisar atender mais de um grupo, escolha a ração mais adequada OU combine no campo "alimentacao" ' +
  'ex.: "Flocos + pastilha de fundo". ' +
  '(3) AVALIE A ADEQUAÇÃO DE CADA RAÇÃO: verifique se a ração é compatível com a dieta, o porte e a boca da fauna. ' +
  'Exemplos de incompatibilidade: ração onívora/flocos finos NÃO serve para um axolote carnívoro; ração herbívora não ' +
  'serve para peixes carnívoros; grânulos grandes não servem para peixes de boca pequena; ração que só flutua não ' +
  'alimenta peixes de fundo. Use SOMENTE rações do estoque ADEQUADAS à fauna. ' +
  '(4) SE NENHUMA ração do estoque for adequada (ou todas incompatíveis), NÃO invente nem force o uso: deixe ' +
  '"alimentacao" null nos dias, ative alerta.temAlerta explicando por que as rações atuais não servem para a fauna, ' +
  'e preencha "sugestoes" com até 3 alimentos adequados (nome, marca, tipo, indicação e motivo da escolha). ' +
  '(5) QUANTIDADE: considere o número de peixes de cada espécie e o porte do aquário. Não subalimente (evita brigas ' +
  'por falta de comida) nem superalimente (evita sobrecarga de amônia/nitrito na água). ' +
  '(6) FERTILIZANTES: use SOMENTE os do estoque e apenas se o aquário tiver plantas (flora) e for plantado. ' +
  'Calcule a dose conforme a capacidade em litros e a quantidade de plantas, distribuindo em dias específicos. ' +
  '(7) SEGURANÇA DA FAUNA (obrigatório): NUNCA sugira fertilizantes com glutaraldeído/carbono líquido se houver ' +
  'AXOLOTE ou INVERTEBRADOS (camarões, caramujos, lagostas, lagostins, siris/caranguejos); NUNCA sugira com COBRE ' +
  'se houver invertebrados. Se a flora indicaria esses produtos mas a fauna é sensível, deixe de fora, ative ' +
  'alerta.temAlerta e mencione no resumo. ' +
  '(8) JEJUM: jejum é benéfico para a saúde e reduz a sobrecarga da água. SUGIRA a quantidade de dias de jejum ' +
  'adequada à fauna (peixes herbívoros/carnívoros de trato curto geralmente toleram 1 dia; espécies com trato ' +
  'longo ou filhotes podem precisar de alimentação mais frequente e menos jejum). Se o usuário informou um dia ' +
  'fixo de TPA ("tpaDia"), aquele dia DEVE ser de jejum obrigatoriamente (jejum true, observacoes mencionando "TPA"). ' +
  'Se NÃO houver TPA informada, escolha 1 dia de jejum (aleatório entre os 7) adequado à fauna. ' +
  'Responda APENAS com JSON válido no formato: ' +
  '{"dias":[{"dia":"Segunda-feira","jejum":false,"alimentacao":"nome exato da ração do estoque (ou null)","quantidade":"ex: 1 pitada","observacoes":"breve dica"},...],' +
  '"fertilizantes":[{"produto":"nome exato do fertilizante do estoque","dose":"ex: 2,5 mL","frequencia":"ex: 2x por semana","dias":["Terça-feira","Sexta-feira"],"observacoes":"breve dica"}],' +
  '"resumo":"resumo curto da estratégia, citando como cada grupo da fauna foi alimentado",' +
  '"alerta":{"temAlerta":false,"titulo":"","mensagem":""},' +
  '"sugestoes":[{"nome":"nome do alimento","marca":"marca","tipo":"tipo","indicacao":"indicação do produto","motivo":"por que é adequado para a fauna"}]}. ' +
  'Os campos "dias" devem conter exatamente 7 itens, de Segunda-feira a Domingo. ' +
  'Se houver rações adequadas, preencha os dias normalmente e deixe alerta.temAlerta false e sugestoes vazia. ' +
  'Se não houver ração adequada, deixe alimentacao null, ative alerta.temAlerta e preencha sugestoes. ' +
  'Se não houver fertilizante ou plantas, deixe fertilizantes como lista vazia. ' +
  'Sempre inclua 1 dia de jejum (ou o dia de TPA, se informado) e deixe claro no resumo a estratégia para o bem-estar.';

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
  { nome: 'Doença da Bolha de Gás (Gas Bubble Disease)', sinonimos: 'bolhas de gás, embolia gasosa, gas bubble disease', sintomas: 'bolhas de gás sob a pele, guelras e olhos; peixe boiando ou letárgico', causa: 'supersaturação de gases na água (oxigênio/nitrogênio) por vazamento de ar, bomba com entrada de ar, aquário superaerado ou água de torneira supersaturada', tratamento: 'desligar/ajustar aeração excessiva, eliminar vazamentos de ar, TPA com água sem bolhas e aguardar a água degasear antes de adicionar', medicamentos: [] },
  { nome: 'Vermes de Pele e Guelras (Gyrodactylus/Dactylogyrus)', sinonimos: 'monogenea, skin flukes, gill flukes, vermes nas guelras', sintomas: 'peixe esfregando-se (flashing), guelras abertas e vermelhas, respiração rápida, muco excessivo, opérculo levantado', causa: 'parasitas monogenéticos (Gyrodactylus na pele, Dactylogyrus nas guelras)', tratamento: 'banho antiparasitário com praziquantel ou formalina diluída, seguir dose conforme litragem, repetir em 4-7 dias para quebrar o ciclo', medicamentos: ['praziquantel'] },
  { nome: 'Furunculose (Aeromonas)', sinonimos: 'furunculosis, aeromonas, feridas profundas', sintomas: 'feridas/abscessos profundos na musculatura, hemorragias na base das nadadeiras, apatia', causa: 'bactéria Aeromonas salmonicida, favorecida por estresse e água ruim', tratamento: 'TPA rigorosa, antibacteriano (oxitetraciclina/amoxicilina), isolar o peixe e melhorar filtragem e oxigenação', medicamentos: ['oxitetraciclina', 'amoxicilina'] },
];

const CATALOGO_ALGAS = [
  { nome: 'Alga Marrom (Diatomáceas)', sinonimos: 'diatomácea, poeira marrom, brown algae', aspecto: 'Camada poeirenta marrom, fina e MUITO FÁCIL de limpar (sai com o dedo). Cobre vidros, substrato e plantas, comum em montagens novas (ciclagem).', causa: 'Excesso de silicatos na água e FALTA de iluminação (típico do início do aquário).', tratamento: 'Costuma sumir sozinha quando a biologia estabiliza. Sifonar o fundo; aumentar um pouco a luz.', dicas: 'Limpa-vidros (Otocinclus) e caramujos (Neritina, Ampulária) devoram rapidamente. Usar água com baixo silicato.' },
  { nome: 'Alga Peteca / Barba Negra (BBA)', sinonimos: 'peteca, barba negra, black beard algae, black brush algae', aspecto: 'TUFOS PRETOS ou cinza-escuros, DENSOS e RÍGIDOS, muito bem fixados (não saem esfregando). Aparecem nas BORDAS de folhas de crescimento lento, saídas de filtro, troncos e rochas. É a alga MAIS COMUM em aquários plantados — em caso de dúvida entre peteca e filamentosa, prefira peteca.', causa: 'FLUTUAÇÃO de CO2 (principal) e excesso de circulação/matéria orgânica.', tratamento: 'Carbono líquido (glutaraldeído) aplicado direto nos focos com seringa, ou água oxigenada 10 volumes, com filtros desligados por 10 minutos. NÃO escovar dentro do aquário (espalha esporos).', dicas: 'Comedor de Alga Siamês (Crossocheilus oblongus) come BBA. Estabilizar o CO2 é a prevenção definitiva.' },
  { nome: 'Algas Verdes Filamentosas', sinonimos: 'hair algae, fios verdes, filamentosa', aspecto: 'FIOS VERDES longos, finos, MACIOS (como cabelo), que formam teias entre plantas de crescimento rápido e musgos. Diferente da peteca: é VERDE e macia, NÃO preta e rígida.', causa: 'Excesso de iluminação e excesso de Ferro (Fe) na água.', tratamento: 'Remoção manual enrolando com escova de dentes; reduzir luz para 6-7h/dia; TPAs frequentes.', dicas: 'Molinésias, Camarões Amano e Red Cherry comem filamentosa.' },
  { nome: 'Green Dust (GDA / Poeira Verde)', sinonimos: 'green dust algae, GDA, poeira verde, névoa verde', aspecto: 'Camada de POEIRA VERDE fina como névoa biológica, cobre VIDROS e superfícies plásticas. Diferente do Green Spot: é poeira difusa (não pontos duros).', causa: 'Desequilíbrio entre Nitrato e Fosfato; comum em aquários novos.', tratamento: 'DEIXAR o ciclo de vida terminar (3-4 semanas SEM raspar — raspar reinicia o ciclo).', dicas: 'Caramujos Neritina ajudam. Não confundir com Green Spot (pontos duros).' },
  { nome: 'Green Spot (GSA / Pontos Verdes)', sinonimos: 'green spot algae, GSA, pontos verdes', aspecto: 'Pequenos PONTOS VERDES redondos e MUITO DUROS (não saem esfregando com o dedo, precisa de lâmina). No vidro e em folhas duras como Anúbias.', causa: 'FALTA de Fosfato (PO4) na água ou excesso de luz.', tratamento: 'Remoção mecânica com raspador/lâmina; ajustar fertilização com Fosfato.', dicas: 'Cascudos e Neritinas ajudam. Diferente do Green Dust (poeira macia).' },
  { nome: 'Cianobactéria (Alga Verde-Azulada)', sinonimos: 'cianobactéria, BGA, gosma, slime', aspecto: 'PELÍCULA verde-azulada VISCOSA e gosmenta, com CHEIRO FORTE de mofo/lodo. Cobre o substrato (junto ao vidro) e as plantas. NÃO é alga verdadeira (é bactéria).', causa: 'Baixa circulação de água e níveis ZERADOS de Nitrato (NO3).', tratamento: 'Sifonar a película; apagão total de 3 dias (sem luz, com oxigenação); em casos severos, antibiótico Eritromicina ou removedor específico (ex.: Ciano Clean).', dicas: 'Melhorar circulação e reequilibrar nitrato/fosfato. Cheiro de mofo confirma o diagnóstico.' },
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

  // Roboflow Fish Disease: visão especializada que detecta doença/peixe saudável.
  // Se encontrar indício de doença com confiança razoável, inclui no contexto
  // para o Gemini/OpenAI confirmarem com o catálogo local.
  if (process.env.ROBOFLOW_API_KEY && imagem) {
    try {
      const roboflow = await viaRoboflowDoenca(
        imagem.includes('base64,') ? imagem.split('base64,')[1] : imagem,
        imagem.match(/^data:([^;]+);base64,/) ? imagem.match(/^data:([^;]+);base64,/)[1] : 'image/jpeg'
      );
      if (roboflow && roboflow.comDoenca && roboflow.confianca >= 50) {
        userText += `\n\n[Pré-análise por visão especializada (Roboflow): possível sinal de doença detectado — classe "${roboflow.classe}" com ${roboflow.confianca}% de confiança. Use isso como pista adicional, mas confirme com o catálogo e a foto.]`;
      }
    } catch (e) {
      console.error('Falha Roboflow (pré-diagnóstico):', e.message);
    }
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const base64 = imagem && imagem.includes('base64,') ? imagem.split('base64,')[1] : imagem;
      const prefixo = imagem && imagem.match(/^data:([^;]+);base64,/) ? imagem.match(/^data:([^;]+);base64,/)[1] : 'image/jpeg';
      const parts = [];
      if (base64) parts.push({ inline_data: { mime_type: prefixo, data: base64 } });
      parts.push({ text: userText });
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-3.6-flash'}:generateContent`,
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
      const modelo = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
      const parts = [];
      if (base64 && prefixo) parts.push({ inline_data: { mime_type: prefixo, data: base64 } });
      parts.push({ text: userText });
      // Retry com backoff para 429 (rate limit do plano free): tenta até 3x
      // antes de cair para o próximo provedor.
      let ultimaFalha = null;
      for (let tentativa = 1; tentativa <= 3; tentativa += 1) {
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
              generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1800 },
            }),
          }
        );
        if (res.ok) {
          const json = await res.json();
          const conteudo = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
          if (!conteudo) throw new Error('Gemini: resposta vazia');
          return JSON.parse(conteudo);
        }
        const texto = await res.text().catch(() => '');
        ultimaFalha = new Error(`Gemini (HTTP ${res.status}): ${texto.slice(0, 300)}`);
        if (res.status !== 429 && res.status !== 500 && res.status !== 503) break;
        if (tentativa < 3) {
          await new Promise((r) => setTimeout(r, 1500 * tentativa));
        }
      }
      throw ultimaFalha || new Error('Gemini: falha sem status');
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
          max_tokens: 1600,
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
      const modelo = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
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

// Fishial.AI — reconhecimento de PEIXES por imagem (API V2).
// Requer FISHIAL_CLIENT_ID e FISHIAL_CLIENT_SECRET (gratuitos em fishial.ai).
// Fluxo: obtém um token curto (~10 min) em /v2/auth e envia a imagem crua em
// /v2/recognize. Resposta: objects[].species[] com certainty (0-1) + definitions.
async function viaFishial(base64, mime) {
  if (!process.env.FISHIAL_CLIENT_ID || !process.env.FISHIAL_CLIENT_SECRET) {
    throw new Error('Fishial: credenciais não configuradas');
  }
  const authRes = await fetch('https://api-recognition.fishial.ai/v2/auth', {
    method: 'POST',
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.FISHIAL_CLIENT_ID,
      client_secret: process.env.FISHIAL_CLIENT_SECRET,
    }),
  });
  if (!authRes.ok) {
    const corpo = await authRes.text().catch(() => '');
    throw new Error(`Fishial auth (HTTP ${authRes.status}): ${corpo.slice(0, 300)}`);
  }
  const auth = await authRes.json();
  const token = auth.access_token || auth.token || auth.accessToken || '';
  if (!token) throw new Error('Fishial: token não retornado');

  const contentType = mime && mime.startsWith('image/') ? mime : 'image/jpeg';
  const recRes = await fetch('https://api-recognition.fishial.ai/v2/recognize', {
    method: 'POST',
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
    },
    body: Buffer.from(base64, 'base64'),
  });
  if (!recRes.ok) {
    const corpo = await recRes.text().catch(() => '');
    throw new Error(`Fishial recognize (HTTP ${recRes.status}): ${corpo.slice(0, 300)}`);
  }
  const rec = await recRes.json();
  const objetos = rec.objects || [];
  if (objetos.length === 0) throw new Error('Fishial: nenhum peixe detectado');
  const especies = (objetos[0].species || []).filter((s) => s && s.certainty != null);
  if (especies.length === 0) throw new Error('Fishial: nenhuma espécie');
  const melhorEspecie = especies[0];
  const defs = rec.definitions || {};
  const def = defs[melhorEspecie.id] || {};
  const confianca = Math.round(melhorEspecie.certainty * 100);
  return normalizarResultado({
    provedor: 'Fishial',
    confianca,
    tipo: 'fauna',
    nomeComum: def.commonName || 'Peixe identificado',
    nomeCientifico: def.scientificName || 'Não identificado',
    familia: '—',
    foto: def.imageUrl || '',
    observacoes: `Confiança de ${confianca}% segundo o modelo Fishial.`,
  });
}

// Google Cloud Vision — identificação geral por LABEL + WEB detection.
// Requer GOOGLE_VISION_API_KEY (Cloud Vision API). Melhor acurácia geral;
// usado como 1ª opção para FAUNA (peso 2.5) e 2ª para FLORA (peso 2.0).
// Extrai o tipo (fauna/flora), o nome popular e o nome científico (binomial)
// das entidades da web.
const VISION_STOPWORDS = new Set([
  'aquarium', 'aquário', 'aquario', 'fish', 'peixe', 'peixes', 'pet', 'animal', 'animals',
  'plant', 'plants', 'planta', 'plantas', 'water', 'água', 'agua', 'biology', 'biologia',
  'underwater', 'submerso', 'submerged', 'aquatic', 'aquática', 'aquatico', 'fauna',
  'flora', 'nature', 'natureza', 'organism', 'organismo', 'vertebrate', 'invertebrate',
  'aquatic animal', 'animal aquático', 'pescado', 'life', 'vida', 'wildlife', 'marine',
  'freshwater', 'agua doce', 'água doce', 'ornamental fish', 'tropical fish',
  'peixe ornamental', 'image', 'photo', 'foto', 'photography', 'fotografia', 'wallpaper',
  'background', 'fundo', 'fish tank', 'aquario', 'tank', 'tanque', 'ornament', 'decor',
  'aquascaping', 'aquaponia', 'icthyology', 'piscicultura', 'aquaculture', 'zoo',
  'biotope', 'biotopo', 'home', 'casa', 'man', 'mulher', 'woman', 'homem', 'person',
  'people', 'pessoas', 'group', 'grupo', 'hand', 'mão', 'mao', 'finger', 'dedo', 'kid',
  'criança', 'crianca', 'child', 'menino', 'menina', 'boy', 'girl', 'table', 'mesa',
  'room', 'sala', 'salao', 'couch', 'sofa', 'sofa', 'toy', 'brinquedo', 'statue',
  'estatua', 'sculpture', 'escultura', 'paint', 'tinta', 'drawing', 'desenho',
  'fin', 'fins', 'tail', 'tails', 'eye', 'eyes', 'scale', 'scales', 'gill', 'gills',
  'mouth', 'mouths', 'body', 'corpo', 'nadadeira', 'nadadeiras', 'barbatana', 'barbatanas',
  'cauda', 'caudas', 'olho', 'olhos', 'escama', 'escamas', 'branquia', 'branquias',
  'guelra', 'guelras', 'boca', 'bocas', 'dorsal', 'aleta', 'aletas', 'finlet',
]);

const VISION_GENERICO = /(fish|peixe|plant|planta|aquarium|aquário|aquario|pet|animal|biology|biologia|underwater|submerso|aquatic|aquático|aquatico|água|agua|water|natureza|nature|imagem|image|photo|foto|life|vida|vertebrate|invertebrate|organism|organismo|fauna|flora)$/i;

function visaoNomeEhEspecie(texto) {
  const x = String(texto || '').trim();
  if (!x) return false;
  const chave = x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (VISION_STOPWORDS.has(chave)) return false;
  if (VISION_GENERICO.test(x)) return false;
  const palavras = x.split(/\s+/).length;
  return palavras >= 1 && palavras <= 5;
}

async function viaGoogleVision(base64, mime, recorteBase64) {
  if (!process.env.GOOGLE_VISION_API_KEY) {
    throw new Error('Google Vision: chave não configurada');
  }
  // 1 ou 2 imagens numa única chamada: a foto inteira e, se o app enviou, o
  // recorte do assunto — mais sinal focado no peixe/planta.
  const imagens = [
    { content: base64 },
    ...(recorteBase64 ? [{ content: recorteBase64 }] : []),
  ];
  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(process.env.GOOGLE_VISION_API_KEY)}`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: imagens.map((image) => ({
          image,
          features: [
            { type: 'LABEL_DETECTION', maxResults: 25 },
            { type: 'WEB_DETECTION', maxResults: 25 },
            { type: 'OBJECT_LOCALIZATION', maxResults: 5 },
            { type: 'IMAGE_PROPERTIES', maxResults: 1 },
          ],
        })),
      }),
    }
  );
  if (!res.ok) {
    const corpo = await res.text().catch(() => '');
    console.error('Google Vision HTTP', res.status, '| corpo:', corpo.slice(0, 300));
    throw new Error(`Google Vision (HTTP ${res.status}): ${corpo.slice(0, 200)}`);
  }
  const json = await res.json();
  const respostas = (json.responses || []).filter((resp) => resp && !resp.error);
  if (respostas.length === 0) {
    const erro = (json.responses && json.responses[0] && json.responses[0].error) || {};
    throw new Error(`Google Vision: ${erro.message || 'resposta vazia'}`);
  }

  // União dos sinais de todas as imagens, deduplicando por texto normalizado
  // (mantém o maior score de cada candidato).
  const labels = [];
  const entidades = [];
  const paginasSimilares = [];
  const objetos = [];
  const bestGuesses = [];
  let corMedia = null;
  const vistosLabels = new Set();
  const vistosEntidades = new Set();
  const vistosPaginas = new Set();
  const vistosObjetos = new Set();

  for (const resp of respostas) {
    for (const l of resp.labelAnnotations || []) {
      const texto = String(l.description || '');
      const chave = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (!chave || vistosLabels.has(chave)) continue;
      vistosLabels.add(chave);
      labels.push({ texto, score: Math.round((l.score || 0) * 100) });
    }
    for (const e of (resp.webDetection && resp.webDetection.webEntities) || []) {
      const texto = String(e.description || '');
      const chave = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (!chave || vistosEntidades.has(chave)) continue;
      vistosEntidades.add(chave);
      entidades.push({ texto, score: Math.round((e.score || 0) * 100) });
    }
    for (const p of (resp.webDetection && resp.webDetection.pagesWithMatchingImages) || []) {
      const titulo = String(p.pageTitle || '');
      const chave = titulo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (!titulo || vistosPaginas.has(chave)) continue;
      vistosPaginas.add(chave);
      paginasSimilares.push({ titulo, score: 75 });
    }
    for (const o of resp.localizedObjectAnnotations || []) {
      const nome = String(o.name || '');
      const chave = nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (!chave || vistosObjetos.has(chave)) continue;
      vistosObjetos.add(chave);
      objetos.push({ nome, score: Math.round((o.score || 0) * 100) });
    }
    const bg =
      resp.webDetection && resp.webDetection.bestGuessLabels && resp.webDetection.bestGuessLabels[0]
        ? resp.webDetection.bestGuessLabels[0].label
        : '';
    if (bg) bestGuesses.push(bg);
    if (corMedia == null) {
      const props =
        resp.imagePropertiesAnnotation &&
        resp.imagePropertiesAnnotation.dominantColors &&
        resp.imagePropertiesAnnotation.dominantColors.colors;
      const c = props && props[0] && props[0].color;
      if (c) {
        corMedia = (0.299 * (c.red || 0) + 0.587 * (c.green || 0) + 0.114 * (c.blue || 0)) / 255;
      }
    }
  }

  labels.sort((a, b) => b.score - a.score);
  entidades.sort((a, b) => b.score - a.score);

  // Foto escura (luminância dominante baixa) → sinaliza ao front para pedir
  // nova foto com melhor luz antes de gastar o refino.
  const fotoEscura = corMedia != null && corMedia < 0.18;

  const todoTexto = [
    ...labels.map((l) => l.texto),
    ...entidades.map((e) => e.texto),
    ...objetos.map((o) => o.nome),
    ...bestGuesses,
  ]
    .join(' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  // Fauna vs flora pelos sinais do texto (labels + entidades + objetos).
  const sinaisFlora = ['plant', 'planta', 'flowering plant', 'aquatic plant', 'planta aquatica', 'aquarium plant',
    'leaf', 'folha', 'moss', 'musgo', 'fern', 'samambaia', 'alga', 'algae', 'anubias',
    'echinodorus', 'cryptocoryne', 'bucephalandra', 'java moss', 'tropica', 'pteridophyte',
    'tracheophyte', 'macrophyte'];
  const sinaisFauna = ['fish', 'peixe', 'guppy', 'betta', 'tetra', 'cichlid', 'ciclideo', 'ciclídeo',
    'shrimp', 'camarao', 'camarão', 'snail', 'caracol', 'caramujo', 'crayfish', 'lagosta',
    'catfish', 'cascudo', 'goldfish', 'molly', 'platy', 'swordtail', 'barbo', 'danio',
    'rasbora', 'loach', 'botia', 'angelfish', 'acara', 'acará', 'neon tetra', 'oscar',
    'discus', 'gourami', 'aquatic animal', 'animal aquatico', 'freshwater fish',
    'peixe de agua doce', 'invertebrate', 'crustacean', 'crustaceo', 'turtle', 'tartaruga',
    'axolotl', 'axolote', 'dwarf shrimp', 'crystal red', 'cherry shrimp', 'amber'];
  const floraPontos = sinaisFlora.reduce((acc, s) => acc + (todoTexto.includes(s) ? 1 : 0), 0);
  const faunaPontos = sinaisFauna.reduce((acc, s) => acc + (todoTexto.includes(s) ? 1 : 0), 0);
  let tipo = '';
  if (floraPontos > faunaPontos) tipo = 'flora';
  else if (faunaPontos > floraPontos) tipo = 'fauna';

  // Nome científico (binomial "Gênero espécie") extraído das entidades da web.
  let nomeCientifico = '';
  const binomial = /([A-ZÀ-Ü][a-zà-ü]+)\s+([a-zà-ü]+)/g;
  for (const e of entidades) {
    let m;
    const copia = new RegExp(binomial.source, 'g');
    while ((m = copia.exec(e.texto))) {
      const candidato = `${m[1]} ${m[2]}`;
      const chave = candidato.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (VISION_STOPWORDS.has(chave) || VISION_GENERICO.test(candidato)) continue;
      // Evita capturar nomes de pessoas/empresas/páginas como binômio.
      if (/(ltd|inc|company|s.a|import|export|produtos|aquario|aquarium|tropical|world|fish)$/i.test(candidato)) continue;
      nomeCientifico = candidato;
      break;
    }
    if (nomeCientifico) break;
  }

  // Páginas com imagens visualmente similares: os títulos dessas páginas
  // costumam conter o nome da espécie (é o sinal mais parecido com o Google
  // Lens — "fotos como esta são chamadas de X na web"). Extraímos binômios
  // e nomes populares desses títulos como candidatos extras.
  const candidatosPaginas = [];
  for (const titulo of paginasSimilares.map((p) => p.titulo).slice(0, 12)) {
    // Binômio no título (ex.: "Poecilia reticulata - Wikipedia")
    let m;
    const copiaB = new RegExp(binomial.source, 'g');
    while ((m = copiaB.exec(titulo))) {
      const candidato = `${m[1]} ${m[2]}`;
      const chave = candidato.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (VISION_STOPWORDS.has(chave) || VISION_GENERICO.test(candidato)) continue;
      if (/(ltd|inc|company|s\.a|import|export|produtos|aquario|aquarium|tropical|world|fish)$/i.test(candidato)) continue;
      candidatosPaginas.push({ texto: candidato, score: 75 });
    }
    // Nome popular no título antes de separadores comuns (" - ", " | ", " – ").
    const antesSep = titulo.split(/\s[-–|]\s/)[0].trim();
    if (antesSep.length >= 4 && antesSep.length <= 60 && !/^[A-ZÀ-Ü][a-zà-ü]+\s+[a-zà-ü]+$/.test(antesSep)) {
      candidatosPaginas.push({ texto: antesSep, score: 65 });
    }
  }

  // Melhor nome popular: candidatos específicos, com maior score. Preferimos o
  // que NÃO é binomial (ex.: "Anubias", "Guppy") sobre o nome científico como
  // nome comum (ex.: "Anubias barteri" vira o nomeCientifico, não o popular).
  // O bestGuess (palpite direto da web = sinal tipo Lens) tem prioridade máxima.
  const ehBinomial = (t) => /^[A-ZÀ-Ü][a-zà-ü]+\s+[a-zà-ü]+$/.test(String(t || '').trim());
  const candidatos = [
    ...bestGuesses.map((b) => ({ texto: b, score: 95 })),
    ...candidatosPaginas,
    ...entidades.map((e) => ({ texto: e.texto, score: e.score })),
    ...labels.map((l) => ({ texto: l.texto, score: l.score })),
  ];
  const especies = candidatos.filter((c) => visaoNomeEhEspecie(c.texto)).sort((a, b) => b.score - a.score);
  const naoBinomial = especies.filter((c) => !ehBinomial(c.texto));
  const melhorNome = naoBinomial[0] || especies[0] || null;
  // Se só há rótulos genéricos/partes do corpo (ex.: "fins", "tail") e nenhum
  // nome de espécie, descarta o provider em vez de devolver ficha vazia.
  if (!melhorNome) throw new Error('Google Vision: nenhum nome de espécie identificado (só rótulos genéricos)');

  // "Palpite web" (nomeAncora): o que a web diria — usado pelo Passo B para
  // montar a ficha com Gemini TEXTO (barato, sem imagem).
  const nomeAncora = melhorNome.texto;
  const nomeComum = melhorNome.texto;
  const confianca = Math.min(100, melhorNome.score || 0);

  if (!tipo && labels.length === 0) throw new Error('Google Vision: nenhum rótulo identificado');

  const candidatosVisao = especies.slice(0, 5).map((c) => ({ nome: c.texto, score: c.score }));

  return {
    ...normalizarResultado({
      provedor: 'GoogleVision',
      confianca,
      tipo,
      nomeComum,
      nomeCientifico,
      familia: '—',
      observacoes: `Identificação via Google Cloud Vision (labels + web). ${nomeCientifico ? 'Nome científico extraído das entidades web.' : ''}`.trim(),
    }),
    nomeAncora,
    candidatosVisao,
    fotoEscura: !!fotoEscura,
    objetos: objetos.map((o) => o.nome).slice(0, 5),
  };
}

// Trefle.io — busca de PLANTAS por nome (base botânica com 400k+ espécies).
// Requer TREFLE_TOKEN (trefle.io). Recebe o nome identificado (popular ou
// científico) e retorna dados de flora enriquecidos. Não identifica por foto.
async function viaTrefle(nome) {
  const termo = String(nome || '').trim();
  if (!termo || !process.env.TREFLE_TOKEN) {
    throw new Error('Trefle: termo vazio ou chave não configurada');
  }
  const res = await fetch(
    `https://trefle.io/api/v1/plants/search?token=${encodeURIComponent(process.env.TREFLE_TOKEN)}&q=${encodeURIComponent(termo)}&limit=5`,
    { signal: AbortSignal.timeout(AI_TIMEOUT_MS) }
  );
  if (!res.ok) {
    const corpo = await res.text().catch(() => '');
    throw new Error(`Trefle (HTTP ${res.status}): ${corpo.slice(0, 300)}`);
  }
  const json = await res.json();
  const itens = json.data || [];
  if (itens.length === 0) throw new Error('Trefle: nenhuma planta encontrada');
  const melhor = itens[0];
  const nomeCientifico = melhor.scientific_name || '';
  const nomesComuns = (melhor.common_name || '').split(',').map((s) => s.trim()).filter(Boolean);
  const familia = (melhor.family || '—').trim();
  const imagem = melhor.image_url || '';
  return normalizarResultado({
    provedor: 'Trefle',
    confianca: 80,
    tipo: 'flora',
    nomeComum: nomesComuns[0] || 'Planta identificada',
    nomeCientifico,
    familia,
    origem: (melhor.origin || '—'),
    tamanho: melhor.vegetable ? '—' : '—',
    foto: imagem,
    observacoes: `Base botânica Trefle: ${nomeCientifico} (família ${familia}).`,
  });
}

// SpeciesLink (splink.cria.org.br) — biodiversidade brasileira. Valida se a
// espécie identificada é registrada no Brasil (ocorrências de fauna/flora).
// Recebe o nome científico após a identificação e enriquece com distribuição.
async function viaSpeciesLink(nomeCientifico) {
  const termo = String(nomeCientifico || '').trim();
  if (!termo || termo === 'Não identificado') {
    throw new Error('SpeciesLink: sem nome científico');
  }
  const chave = process.env.SPECIESLINK_API_KEY || '';
  const url = `https://api.splink.org.br/records/${encodeURIComponent(termo)}/count`;
  const headers = { Accept: 'application/json' };
  if (chave) headers['X-Api-Key'] = chave;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(AI_TIMEOUT_MS) });
  if (!res.ok) {
    const corpo = await res.text().catch(() => '');
    throw new Error(`SpeciesLink (HTTP ${res.status}): ${corpo.slice(0, 300)}`);
  }
  const json = await res.json();
  const total = Number(json.total) || Number(json.count) || 0;
  const temOcorrencia = total > 0;
  return {
    provedor: 'SpeciesLink',
    confianca: temOcorrencia ? 85 : 30,
    tipo: null,
    nomeComum: '',
    nomeCientifico: termo,
    familia: '—',
    origem: temOcorrencia ? 'Brasil (registro SpeciesLink)' : 'Sem registro no Brasil',
    tamanho: '—',
    observacoes: temOcorrencia
      ? `Espécie com ${total} ocorrência(s) registrada(s) no Brasil (SpeciesLink).`
      : 'Espécie sem ocorrência registrada no Brasil (SpeciesLink).',
    foto: '',
  };
}

// Roboflow Fish Disease — visão especializada em doenças de peixes.
// Requer ROBOFLOW_API_KEY (app.roboflow.com/settings/api) e opcionalmente
// ROBOFLOW_MODEL (model_id no formato "projeto/versao"; padrão: modelo público
// de detecção fish_diseases-cog3w/5 — classes: cotton mouth, BGD, etc.).
// A API aceita a imagem como base64 no corpo (Content-Type form-urlencoded).
// Retorna { classe, confianca, comDoenca } ou null quando não configurado.
async function viaRoboflowDoenca(base64, mime) {
  if (!process.env.ROBOFLOW_API_KEY || !base64) return null;
  const modelo = process.env.ROBOFLOW_MODEL || 'fish_diseases-cog3w/5';
  const res = await fetch(`https://serverless.roboflow.com/${modelo}?api_key=${encodeURIComponent(process.env.ROBOFLOW_API_KEY)}`, {
    method: 'POST',
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: base64,
  });
  if (!res.ok) {
    const corpo = await res.text().catch(() => '');
    throw new Error(`Roboflow (HTTP ${res.status}): ${corpo.slice(0, 300)}`);
  }
  const json = await res.json();
  const predicoes = json.predictions || [];
  if (predicoes.length === 0) return null;
  const melhor = predicoes.sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))[0];
  const classe = String(melhor.class || melhor.predicted_class || json.top || '');
  if (!classe) return null;
  const confianca = Math.round((Number(melhor.confidence) || json.confidence || 0) * 100);
  const classeNorm = classe.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const comDoenca = !/healthy|sadio|sana/.test(classeNorm);
  return { classe, confianca, comDoenca };
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
app.use('/concursos', (req, res, next) => {
  // Deixa as rotas JSON (/concursos e /concursos/...) prevalecerem; só arquivos
  // de imagem devem ser tratados pelo diretório estático.
  if (!path.extname(req.path)) return next();
  return express.static(CONCURSOS_UPLOADS_DIR, { maxAge: '1d' })(req, res, next);
});

// Estado público: se o admin não ativou, retorna null (a seção não aparece no app).
app.get('/concursos', (req, res) => {
  concursosStore.encerrarSeDivulgacaoExpirada();
  const config = concursosStore.obterConfig();
  if (!config || config.ativo !== true) {
    return res.json({ ativo: false, config: null });
  }
  const agora = Date.now();
  let fase =
    agora < config.inscricaoDe
      ? 'aguarda_inscricao'
      : agora < config.inscricaoAte
      ? 'inscricoes'
      : agora < config.votacaoDe
      ? 'aguarda_votacao'
      : agora < config.votacaoAte
      ? 'votacao'
      : 'encerrado';
  const ganhador = concursosStore.obterGanhador();
  if (ganhador) fase = 'finalizado';
  const dispositivoId = String((req.query && req.query.dispositivoId) || '').trim();
  const inscricoes = concursosStore.listarInscricoes().filter((i) => i.status === 'aprovado').map((i) => ({
    id: i.id,
    nome: i.nome || '',
    apelido: i.apelido || '',
    foto: i.foto || '',
    votos: i.votos || 0,
  }));
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
       linkVotacao: config.linkVotacao || `${urlBasePublica(req).replace(/\/$/, '')}/concurso/votacao`,
      ganhadorDeclarado: !!config.ganhadorDeclarado,
    },
    fase,
    inscricoes,
    meuStatus: dispositivoId ? concursosStore.statusDeDispositivo(dispositivoId) : null,
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

// Config + inscrições completas (painel do admin).
app.get('/concursos/admin', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  concursosStore.encerrarSeDivulgacaoExpirada();
  const config = concursosStore.obterConfig();
  res.json({
    config: config
      ? { ...config, linkVotacao: config.linkVotacao || `${urlBasePublica(req).replace(/\/$/, '')}/concurso/votacao` }
      : null,
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

// Envio de inscrição com foto. A foto é validada (só peixes/aquários) e salva
// de forma IMUTÁVEL (não há edição nem exclusão depois).
app.post('/concursos/inscricao', async (req, res) => {
  const config = concursosStore.obterConfig();
  if (!config || config.ativo !== true) {
    return res.status(400).json({ erro: 'O concurso não está ativo.' });
  }
  const agora = Date.now();
  if (agora < config.inscricaoDe || agora > config.inscricaoAte) {
    return res.status(400).json({ erro: 'As inscrições não estão abertas neste momento.' });
  }
  const { imagem, nome, apelido, dispositivoId } = req.body || {};
  if (!imagem || typeof imagem !== 'string') {
    return res.status(400).json({ erro: 'Envie a foto do aquário (imagem).' });
  }
  if (!String(nome || '').trim() || !String(apelido || '').trim()) {
    return res.status(400).json({ erro: 'Informe nome e apelido.' });
  }
  // Uma inscrição por dispositivo.
  const jaInscrito = concursosStore
    .listarInscricoes()
    .some((i) => String(i.dispositivoId || '') === String(dispositivoId || '') && i.status !== 'rejeitado');
  if (jaInscrito) {
    return res.status(400).json({ erro: 'JÁ_INSCRITO', motivo: 'Este dispositivo já possui uma inscrição aprovada ou em avaliação.' });
  }

  const base64 = imagem.includes('base64,') ? imagem.split('base64,')[1] : imagem;
  const prefixo = imagem.match(/^data:([^;]+);base64,/) ? imagem.match(/^data:([^;]+);base64,/)[1] : 'image/jpeg';
  const dataUrl = `data:${prefixo};base64,${base64}`;

  // Validação: só fotos do AQUÁRIO INTEIRO (concurso).
  const provedores = semChavesValidacao();
  let valida = false;
  let motivo = '';
  if (provedores.length > 0) {
    if (process.env.GEMINI_API_KEY) {
      try {
        const r = await validarFotoGemini(base64, prefixo, PROMPT_VALIDACAO_CONCURSO);
        valida = r.valida;
        motivo = r.motivo || '';
      } catch (e) {
        console.error('Falha Gemini (concurso):', e.message);
      }
    }
    if (!valida && process.env.OPENAI_API_KEY) {
      try {
        const r = await validarFotoOpenAI(dataUrl, PROMPT_VALIDACAO_CONCURSO);
        valida = r.valida;
        motivo = r.motivo || '';
      } catch (e) {
        console.error('Falha OpenAI (concurso):', e.message);
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

  const inscricao = concursosStore.criarInscricao({
    nome: String(nome).trim(),
    apelido: String(apelido).trim(),
    dispositivoId: String(dispositivoId || ''),
    foto: fotoUrl,
  });
  res.status(201).json({ ok: true, inscricao: { id: inscricao.id, foto: inscricao.foto } });
});

// Votação: 1 voto por dispositivo.
app.post('/concursos/votar', (req, res) => {
  const config = concursosStore.obterConfig();
  if (!config || config.ativo !== true) {
    return res.status(400).json({ erro: 'O concurso não está ativo.' });
  }
  const agora = Date.now();
  if (agora < config.votacaoDe || agora > config.votacaoAte) {
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

app.post('/concursos/encerrar', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const config = concursosStore.obterConfig() || {};
  const inscricoes = concursosStore.listarInscricoes();
  const ganhador = concursosStore.obterGanhador();
  const fotoVencedor = ganhador ? String(ganhador.inscricao.foto || '').split('/').pop() : '';
  for (const inscricao of inscricoes) {
    const arquivo = String(inscricao.foto || '').split('/').pop();
    if (arquivo && arquivo !== fotoVencedor && /^concurso-.*\.\w+$/.test(arquivo)) {
      try {
        fs.unlinkSync(path.join(CONCURSOS_UPLOADS_DIR, arquivo));
      } catch (e) {
        console.warn('Falha ao apagar foto ao finalizar concurso:', e.message);
      }
    }
  }
  const historico = concursosStore.encerrarConcurso({
    categoria: config.categoria || '',
    premio: config.premio || '',
    inscricaoDe: config.inscricaoDe || 0,
    inscricaoAte: config.inscricaoAte || 0,
    votacaoDe: config.votacaoDe || 0,
    votacaoAte: config.votacaoAte || 0,
    encerradoEm: Date.now(),
    ganhador: ganhador
      ? {
          nome: ganhador.inscricao.nome || '',
          apelido: ganhador.inscricao.apelido || '',
          votos: ganhador.inscricao.votos || 0,
          foto: ganhador.inscricao.foto || '',
          premio: config.premio || '',
        }
      : null,
  });
  res.json({ ok: true, historico });
});

app.post('/concursos/aprovar', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const { inscricaoId } = req.body || {};
  const inscricao = concursosStore.atualizarInscricao(inscricaoId, { status: 'aprovado', motivo: '' });
  if (!inscricao) return res.status(404).json({ erro: 'Inscrição não encontrada.' });
  res.json({ ok: true, inscricao });
});

app.post('/concursos/rejeitar', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const { inscricaoId, motivo } = req.body || {};
  const inscricao = concursosStore.atualizarInscricao(inscricaoId, {
    status: 'rejeitado',
    motivo: String(motivo || '').trim(),
  });
  if (!inscricao) return res.status(404).json({ erro: 'Inscrição não encontrada.' });
  res.json({ ok: true, inscricao });
});

app.delete('/concursos/inscricao/:id', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const inscricao = concursosStore.obterInscricao(req.params.id);
  if (!inscricao) return res.status(404).json({ erro: 'Inscrição não encontrada.' });
  const arquivo = String(inscricao.foto || '').split('/').pop();
  if (arquivo && /^concurso-.*\.\w+$/.test(arquivo)) {
    try {
      fs.unlinkSync(path.join(CONCURSOS_UPLOADS_DIR, arquivo));
    } catch (e) {
      console.warn('Falha ao apagar foto excluída:', e.message);
    }
  }
  concursosStore.removerInscricao(req.params.id);
  res.json({ ok: true });
});

// ============================ FIM CONCURSOS ============================

// ============================ TELEMETRIA ============================

// Recebe um evento de uso de seção (ex.: usuário abriu o Identificador).
app.post('/telemetria/secao', (req, res) => {
  const { secao, dispositivoId, plano } = req.body || {};
  const nome = String(secao || '').trim();
  if (!nome) return res.status(400).json({ erro: 'Envie o campo "secao".' });
  telemetriaStore.registrarSecao(nome.slice(0, 60), plano, dispositivoId);
  res.json({ ok: true });
});

// Recebe o perfil de um aquário cadastrado/atualizado (para estatísticas).
app.post('/telemetria/aquario', (req, res) => {
  const { aquario, dispositivoId, plano } = req.body || {};
  if (!aquario || typeof aquario !== 'object') {
    return res.status(400).json({ erro: 'Envie o campo "aquario".' });
  }
  telemetriaStore.registrarPerfilAquario(aquario, plano, dispositivoId);
  res.json({ ok: true });
});

// Resumo estatístico (painel do admin).
app.get('/telemetria/admin', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  res.json(telemetriaStore.resumo());
});

// ============================ USO DE IA ============================

// Recebe um consumo de IA do app (fire-and-forget): agrega por plano e período
// para o painel admin. Falhas são silenciosas (o app não depende desta rota).
app.post('/ia/uso', (req, res) => {
  const { dispositivoId, plano, qtd, custo } = req.body || {};
  iaUsoStore.registrar({ dispositivoId, plano, qtd, custo });
  res.json({ ok: true });
});

// Resumo do uso de IA por plano e período (painel do admin).
app.get('/ia/uso/admin', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const { plano = '', de = null, ate = null } = req.query || {};
  res.json(
    iaUsoStore.resumo({
      plano: String(plano || ''),
      de: de ? Number(de) : null,
      ate: ate ? Number(ate) : null,
    })
  );
});

// ============================ FIM USO DE IA ============================

// ============================ PUSH (Web Push) ============================

// Registra/atualiza a subscription push do dispositivo (web/PWA).
app.post('/push/registrar', (req, res) => {
  const { dispositivoId, subscription } = req.body || {};
  if (!dispositivoId || !subscription || !subscription.endpoint) {
    return res.status(400).json({ erro: 'Envie dispositivoId e subscription.' });
  }
  pushStore.registrar({ dispositivoId: String(dispositivoId), subscription });
  res.json({ ok: true, status: pushStore.resumo() });
});

// Agenda os disparos futuros do dispositivo: [{ ts, title, body }].
app.post('/push/agendar', (req, res) => {
  const { dispositivoId, triggers } = req.body || {};
  if (!dispositivoId) {
    return res.status(400).json({ erro: 'Envie dispositivoId.' });
  }
  pushStore.agendar({ dispositivoId: String(dispositivoId), triggers });
  res.json({ ok: true });
});

// Status do push (painel/admin).
app.get('/push/status', (req, res) => {
  res.json(pushStore.resumo());
});

// Processa disparos vencidos a cada 30s enquanto o processo estiver de pé.
if (require.main === module) {
  setInterval(() => {
    pushStore.processarDevidos().catch((e) => console.error('Falha no push scheduler:', e.message));
  }, 30000);
}

// ============================ FIM PUSH ============================

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

// Monta a lista de espécies conhecidas do app (fauna + flora) para embutir no
// prompt de identificação. Isso faz a IA escolher dentro do catálogo do app —
// reduz espécies inventadas e aumenta a precisão da ficha devolvida.
// Prioriza: (1) espécies com ficha completa (especies.json), (2) flora,
// (3) fauna brasileira e complementar com nome científico real. Deduplica por
// nome científico e limita a LIMITE_NOMES (800) para caber no contexto sem
// inflar o custo por chamada.
const LIMITE_NOMES_PROMPT = 1600;
let listaEspeciesPrompt = null;

// Grupos de fauna que caíam fora da lista do prompt (limite antigo de 800) e
// causavam erros de identificação (ex.: Polypterus endlicheri/ornatipinnis/
// delhezi/lapradei, botias-zebra, otocinclus zebra). Estas espécies são movidas
// para o início da lista para garantirem vaga dentro do limite.
const GRUPOS_PRIORITARIOS_PROMPT = [
  /^polypterus/i,
  /hypancistrus zebra/i,
  /maylandia zebra/i,
  /^botia/i,
  /otocinclus cocama/i,
  /neritina natalensis/i,
  /^danio/i,
  /^corydoras/i,
  /^apistogramma/i,
  /^paracheirodon/i,
  /^poecilia/i,
  /^xiphophorus/i,
  /^pseudotropheus/i,
  /^aulonocara/i,
  /^melanochromis/i,
  /^labidochromis/i,
];

function obterListaEspeciesPrompt() {
  if (listaEspeciesPrompt) return listaEspeciesPrompt;
  const especies = lerCatalogo('especies') || [];
  const flora = lerCatalogo('flora') || [];
  const faunaBrasileira = lerCatalogo('faunaBrasileira') || [];
  const faunaComplementar = lerCatalogo('faunaComplementar') || [];

  const item = (e) => ({ nc: e.nomeComum || e.nome || '', ci: e.nomeCientifico || '' });
  // Fauna brasileira tem agregados ("…– 110 Espécies") sem nome científico —
  // filtra apenas entradas com nome científico real.
  const fbReais = faunaBrasileira
    .map(item)
    .filter((x) => x.ci.trim() && !/esp[eê]cies|f[ií]cheiros|fam[ií]lia/i.test(x.nc));

  const prioridade = [
    ...especies.map(item),
    ...flora.map(item),
    ...faunaComplementar.map(item),
    ...fbReais,
  ];

  const vistos = new Set();
  const unicos = [];
  for (const x of prioridade) {
    const chave = (x.ci || x.nc)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);
    unicos.push(x);
  }

  // Espécies dos grupos prioritários primeiro (garantem vaga no limite).
  const ehPrioritaria = (x) => GRUPOS_PRIORITARIOS_PROMPT.some((rx) => rx.test(`${x.nc} ${x.ci}`));
  const priorizadas = unicos.filter(ehPrioritaria);
  const demais = unicos.filter((x) => !ehPrioritaria(x));
  const ordenadas = [...priorizadas, ...demais].slice(0, LIMITE_NOMES_PROMPT);

  const txt = ordenadas.map((x) => `${x.nc.trim()} (${x.ci.trim()})`).join(', ');
  listaEspeciesPrompt = txt || 'nenhuma';
  return listaEspeciesPrompt;
}

// ======================= CANONICALIZAÇÃO NO CATÁLOGO =======================
// Resolve os nomes devolvidos pelos provedores para a espécie canônica do
// catálogo do app (nome científico exato, nome comum, ou gênero). Garante que a
// ficha devolvida seja de uma espécie real do catálogo e permite medir a
// concordância entre provedores (ensemble).
let catalogoCanonico = null;
function obterCatalogoCanonico() {
  if (catalogoCanonico) return catalogoCanonico;
  const todos = [
    ...(lerCatalogo('especies') || []),
    ...(lerCatalogo('faunaComplementar') || []),
    ...(lerCatalogo('faunaBrasileira') || []),
  ];
  const porCi = new Map();
  const porNc = new Map();
  for (const e of todos) {
    const ci = String(e.nomeCientifico || '').trim();
    const nc = String(e.nomeComum || e.nome || '').trim();
    if (ci) {
      const chave = normalizarTxt(ci);
      if (!porCi.has(chave)) porCi.set(chave, e);
    }
    if (nc) {
      const chaveN = normalizarTxt(nc);
      if (!porNc.has(chaveN)) porNc.set(chaveN, e);
    }
    // Aliases (palavrasChave): cobre nomes em inglês e variações
    // (ex.: "Axolotl" → Axolote, "Ember Tetra" → Tetra Âmbar).
    const pws = e.palavrasChave || e.keywords || [];
    if (Array.isArray(pws)) {
      for (const pw of pws) {
        const chaveP = normalizarTxt(String(pw || ''));
        if (chaveP && chaveP.length >= 3 && !porNc.has(chaveP)) porNc.set(chaveP, e);
      }
    }
  }
  catalogoCanonico = { porCi, porNc, todos };
  return catalogoCanonico;
}

function normalizarTxt(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function generoDe(ci) {
  const m = String(ci || '').trim().match(/^([a-zA-ZÀ-Üà-ü]+)\s+/);
  return m ? m[1].toLowerCase() : '';
}

// Encontra a espécie canônica do catálogo para um resultado de provedor.
function resolverNoCatalogo(resultado) {
  const cat = obterCatalogoCanonico();
  const alvos = [];
  const ci = String(resultado.nomeCientifico || '').trim();
  const nc = String(resultado.nomeComum || '').trim();
  if (ci && ci !== 'Não identificado') alvos.push(ci);
  if (nc && nc !== 'Espécie não catalogada' && nc !== 'Espécie identificada') alvos.push(nc);

  // 1) nome científico exato (normalizado).
  for (const a of alvos) {
    const e = cat.porCi.get(normalizarTxt(a));
    if (e) return e;
  }
  // 2) nome comum exato (normalizado).
  for (const a of alvos) {
    const e = cat.porNc.get(normalizarTxt(a));
    if (e) return e;
  }
  // 3) gênero + palavra de espécie (com tolerância a variações de escrita,
  //    ex.: "Polypterus endlicheri" → "Polypterus endlicherii").
  for (const a of alvos) {
    const e = casarPorTokens(a, cat.todos);
    if (e) return e;
  }
  // 4) último recurso: primeira espécie do gênero no catálogo.
  for (const a of alvos) {
    const g = generoDe(a);
    if (g) {
      const e = cat.todos.find((x) => generoDe(x.nomeCientifico || '') === g);
      if (e) return e;
    }
  }
  return null;
}

// Casa um texto (ex.: "Polypterus endlicheri endlicheri") com uma espécie do
// catálogo pelo gênero (1ª palavra) + palavra de espécie (2ª), tolerando
// pequenas variações de escrita (uma palavra contém a outra, mín. 6 letras).
function casarPorTokens(texto, todos) {
  const toks = normalizarTxt(texto).split(' ').filter((t) => t.length > 2);
  if (toks.length < 2) return null;
  const [g, esp] = toks;
  for (const e of todos) {
    const s = normalizarTxt(`${e.nomeCientifico || ''} ${e.nomeComum || ''}`).split(' ');
    if (!s.includes(g)) continue;
    const casa = s.some(
      (t) =>
        t === esp ||
        (esp.length >= 6 && t.length >= 6 && (t.startsWith(esp) || esp.startsWith(t)))
    );
    if (casa) return e;
  }
  return null;
}

// Aplica a ficha canônica sobre o resultado do provedor (mantém o que o
// provedor devolveu quando o catálogo não tem o campo).
function aplicarFichaCanonica(r, e) {
  if (!e) return r;
  const novo = { ...r };
  const campos = ['nomeComum', 'nomeCientifico', 'familia', 'origem', 'tamanho', 'temperatura',
    'ph', 'dureza', 'dieta', 'comportamento', 'aquarioMinimo', 'dificuldade', 'iluminacao',
    'co2', 'crescimento', 'tipoPlanta'];
  for (const c of campos) {
    const v = e[c];
    if (v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim() !== '—') {
      novo[c] = String(v).trim();
    }
  }
  if (e.observacoes && String(e.observacoes).trim() && !/\.docx?$/i.test(String(e.observacoes).trim()) && !novo.observacoes) {
    novo.observacoes = String(e.observacoes).trim();
  }
  return novo;
}

// Chave canônica (espécie resolvida no catálogo, ou nome científico cru).
function chaveCanonica(r) {
  const e = resolverNoCatalogo(r);
  if (e && e.nomeCientifico) return normalizarTxt(e.nomeCientifico);
  const ci = String(r.nomeCientifico || '').trim();
  if (ci && ci !== 'Não identificado') return normalizarTxt(ci);
  return normalizarTxt(r.nomeComum || '');
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
  if (texto.length > 200) {
    return res.status(400).json({ erro: 'A pergunta deve ter no máximo 200 caracteres.' });
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

app.post('/avaliacao-graficos', async (req, res) => {
  const { mediacoes, nomeAquario } = req.body || {};
  if (!Array.isArray(mediacoes) || mediacoes.length === 0) {
    return res.status(400).json({ erro: 'Envie as medições de parâmetros da água.' });
  }
  const textoMedicoes = mediacoes
    .slice(-10)
    .map((m, i) => {
      const vals = (m && m.valores) || {};
      const linha = Object.keys(vals)
        .filter((k) => vals[k] !== undefined && vals[k] !== null && vals[k] !== '')
        .map((k) => `${k}: ${vals[k]}`)
        .join(', ');
      const data = m.criadoEm ? new Date(m.criadoEm).toLocaleDateString('pt-BR') : `medida ${i + 1}`;
      return `${data} — ${linha || 'sem dados'}`;
    })
    .join('\n');
  const texto = `Aquário: ${nomeAquario || 'não informado'}.\nÚltimas medições:\n${textoMedicoes}`;

  try {
    const dados = await viaIAVision({
      imagem: null,
      systemPrompt: PROMPT_AVALIACAO_GRAFICOS,
      userText: texto,
    });
    if (dados && dados.resposta) {
      return res.json({ resposta: String(dados.resposta) });
    }
    return res.status(502).json({ erro: 'Não foi possível gerar a avaliação dos gráficos.' });
  } catch (e) {
    console.error('Falha ao avaliar gráficos:', e.message);
    return res.status(502).json({ erro: e.message });
  }
});

app.post('/alimentos-recomendados', async (req, res) => {
  const fauna = Array.isArray(req.body && req.body.fauna) ? req.body.fauna : [];
  try {
    const lista = fauna
      .map((f) => `${f.nomeComum || f.nome || 'peixe'} (${f.dieta || 'dieta não informada'})`)
      .join(', ');
    const dados = await viaIAVision({
      imagem: null,
      systemPrompt:
        'Recomende alimentos para peixes de aquário de água doce. Responda apenas JSON com uma chave ' +
        'recomendacoes, um array de até 6 itens contendo marca, nome, tipo, indicacao e motivo.',
      userText: lista || 'Recomende alimentos de rotina para aquário comunitário.',
    });
    if (dados && Array.isArray(dados.recomendacoes)) {
      return res.json({ recomendacoes: dados.recomendacoes.slice(0, 6), provedor: dados.provedor || 'IA' });
    }
  } catch (e) {
    console.error('Falha ao recomendar alimentos (IA):', e.message);
  }

  const produtos = catalogosStore.listar('produtos');
  const recomendacoes = produtos.slice(0, 6).map((p) => ({
    marca: p.marca || '',
    nome: p.nome || '',
    tipo: p.tipo || '',
    indicacao: p.indicacao || '',
    motivo: p.indicacao
      ? `Adequado para a dieta da fauna: ${p.indicacao}.`
      : 'Alimento de rotina adequado para peixes de aquário comunitário.',
  }));
  return res.json({ recomendacoes, provedor: 'local', offline: true });
});

app.post('/sugestoes-ajuste', async (req, res) => {
  const corpo = req.body || {};
  try {
    const dados = await viaIAVision({
      imagem: null,
      systemPrompt:
        'Analise parâmetros de água de aquário doce e responda apenas JSON com a chave resposta. ' +
        'Dê orientações práticas e seguras, com ajustes graduais.',
      userText: `Parâmetros/situação do aquário: ${JSON.stringify(corpo)}. Sugira ajustes.`,
    });
    if (dados && typeof dados.resposta === 'string' && dados.resposta.trim()) {
      return res.json({ resposta: dados.resposta });
    }
  } catch (e) {
    console.error('Falha ao gerar sugestões de ajuste (IA):', e.message);
  }

  const alertas = (corpo.alertas || []).map((a) => String(a.campo || a.titulo || '').toLowerCase());
  const resumo = String(corpo.resumo || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tem = (palavra) => alertas.includes(palavra) || resumo.includes(palavra);
  const linhas = [];
  if (tem('temperatura')) linhas.push('Ajuste a temperatura gradualmente, no máximo 1-2 °C por dia.');
  if (tem('ph')) linhas.push('Evite variações bruscas de pH e corrija aos poucos.');
  if (tem('amonia') || tem('amônia')) linhas.push('Faça uma TPA de 20-30%, reduza a alimentação e confira o filtro biológico.');
  if (tem('nitrito')) linhas.push('Faça TPAs e reduza a alimentação até o ciclo biológico estabilizar.');
  if (tem('nitrato')) linhas.push('Faça TPAs regulares e reduza o excesso de ração.');
  if (linhas.length === 0) linhas.push('Repita as medições em 24-48h e mantenha a rotina de TPAs.');
  return res.json({ resposta: `Sugestões rápidas para ajustar a água:\n\n${linhas.map((l) => `• ${l}`).join('\n')}`, _offline: true });
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

app.get('/admin-usuarios', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'usuarios.html'));
});

// ============================ TESTER (limite de testadores) ============================
// O app consulta esta rota no boot (ambiente tester) para validar o acesso:
//  - no máximo LIMITE_TESTERS dispositivos distintos;
//  - expira em testerStore.EXPIRA_EM (30/09/2026) mesmo que esqueçam de tirar o link do ar.

app.post('/tester/validar', (req, res) => {
  const { dispositivoId } = req.body || {};
  const r = testerStore.validar(dispositivoId);
  if (!r.ok) {
    return res.status(403).json({ ok: false, codigo: r.codigo, motivo: r.motivo });
  }
  res.json({ ok: true, limite: testerStore.LIMITE_TESTERS });
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

// ---------------------------------------------------------------------------
// FEEDBACK DE IDENTIFICAÇÃO (app tester)
// O usuário informa quando a identificação errou e sugere o nome correto
// (com autocomplete dos nomes do catálogo no app, para padronizar).
// Os registros alimentam o dataset de revisão e futuras melhorias.
// ---------------------------------------------------------------------------
app.post('/feedback-identificacao', (req, res) => {
  const { hashImagem, resultadoErrado, nomeCorretoSugerido, dispositivoId, origem } = req.body || {};
  if (!nomeCorretoSugerido || !String(nomeCorretoSugerido).trim()) {
    return res.status(400).json({ erro: 'Informe o nome correto sugerido.' });
  }
  try {
    const registro = feedbackStore.registrar({
      hashImagem,
      resultadoErrado: resultadoErrado || null,
      nomeCorretoSugerido,
      dispositivoId,
      origem: origem || 'tester',
    });
    res.json({ ok: true, id: registro.id });
  } catch (e) {
    console.error('Falha ao registrar feedback:', e.message);
    res.status(500).json({ erro: 'Não foi possível registrar. Tente de novo.' });
  }
});

app.get('/feedback-identificacao/admin', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  res.json(feedbackStore.resumo());
});

// ---------------------------------------------------------------------------
// PAGAMENTOS WEB (Mercado Pago Checkout Pro)
// Fluxo: app -> POST /pagamentos/criar -> abre init_point no navegador ->
// Mercado Pago chama POST /pagamentos/webhook -> app consulta
// GET /pagamentos/status/:ref e ativa o benefício localmente.
// ---------------------------------------------------------------------------

async function mpChamar(caminho, opcoes = {}) {
  const r = await fetch(MP_API + caminho, {
    ...opcoes,
    headers: {
      Authorization: `Bearer ${MP_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opcoes.headers || {}),
    },
  });
  let corpo = null;
  try {
    corpo = await r.json();
  } catch (e) {}
  return { ok: r.ok, status: r.status, corpo };
}

app.post('/pagamentos/criar', async (req, res) => {
  if (!MP_TOKEN) return res.status(503).json({ ok: false, codigo: 'INDISPONIVEL' });
  const { produtoId, email, dispositivoId } = req.body || {};
  const criado = pagamentosStore.criar({ produtoId, email, dispositivoId });
  if (!criado.ok) return res.status(400).json({ ok: false, codigo: criado.erro });
  const p = criado.registro;

  try {
    const preferencia = {
      items: [
        {
          id: produtoId,
          title: `AquarIApp — ${p.rotulo}`,
          quantity: 1,
          unit_price: p.preco,
          currency_id: 'BRL',
        },
      ],
      external_reference: criado.ref,
      payer: p.email ? { email: p.email } : undefined,
      back_urls: {
        success: `${PAGAMENTO_RETORNO}?pagamento=${criado.ref}`,
        pending: `${PAGAMENTO_RETORNO}?pagamento=${criado.ref}`,
        failure: `${PAGAMENTO_RETORNO}?pagamento=${criado.ref}`,
      },
    };

    // notification_url precisa ser a URL pública absoluta do backend
    // (defina PAGAMENTO_WEBHOOK_URL no painel do Render).
    if (process.env.PAGAMENTO_WEBHOOK_URL) {
      preferencia.notification_url = process.env.PAGAMENTO_WEBHOOK_URL;
    }

    const r = await mpChamar('/checkout/preferences', {
      method: 'POST',
      body: JSON.stringify(preferencia),
    });
    if (!r.ok || !r.corpo || !r.corpo.init_point) {
      console.error('[pagamentos] erro ao criar preferência:', r.status, JSON.stringify(r.corpo || {}).slice(0, 500));
      return res.status(502).json({ ok: false, codigo: 'ERRO_GATEWAY' });
    }
    res.json({ ok: true, ref: criado.ref, init_point: r.corpo.init_point });
  } catch (e) {
    console.error('[pagamentos] exceção ao criar preferência:', e.message);
    res.status(502).json({ ok: false, codigo: 'ERRO_GATEWAY' });
  }
});

// Notificação do Mercado Pago. Consulta o pagamento na API oficial antes de
// confiar no status (nunca marca pago só pelo corpo do webhook).
app.post('/pagamentos/webhook', async (req, res) => {
  try {
    const q = req.query || {};
    const b = req.body || {};
    const tipo = q.type || q.topic || b.type || '';
    const idPagamento = (q['data.id'] || (b.data && b.data.id)) + '';
    if ((tipo === 'payment' || tipo === '') && idPagamento && /^\d+$/.test(idPagamento)) {
      if (!MP_TOKEN) return res.sendStatus(200);
      const r = await mpChamar(`/v1/payments/${idPagamento}`);
      const pg = r.corpo;
      const ref = pg && pg.external_reference;
      if (r.ok && ref && pg.status === 'approved') {
        pagamentosStore.marcarPago(ref, {
          mpPaymentId: idPagamento,
          metodo:
            pg.payment_method_id +
            (pg.payment_type_id === 'credit_card' ? ' (crédito)' : pg.payment_type_id === 'debit_card' ? ' (débito)' : ''),
        });
        // Mantém o registro de contas em sync com a assinatura paga
        // (lista de transmissão do admin atualiza sozinha).
        try {
          const registro = pagamentosStore.statusPorRef(ref);
          if (registro && registro.email && registro.tipo) {
            const plano = String(registro.tipo).includes('trimestral')
              ? 'trimestral'
              : String(registro.tipo).includes('mensal')
                ? 'mensal'
                : null;
            if (plano) contasStore.definirPlano({ email: registro.email, plano });
          }
        } catch (e2) {
          console.error('[pagamentos] sync contas:', e2.message);
        }
      }
    }
  } catch (e) {
    console.error('[pagamentos] webhook:', e.message);
  }
  // Sempre 200 para o MP não reenviar indefinidamente em caso de erro pontual.
  res.sendStatus(200);
});

// Consulta do app: retorna o estado da compra por ref.
app.get('/pagamentos/status/:ref', (req, res) => {
  const registro = pagamentosStore.statusPorRef(req.params.ref);
  if (!registro) return res.status(404).json({ ok: false, codigo: 'NAO_ENCONTRADO' });
  res.json({
    ok: true,
    ref: registro.ref,
    status: registro.status,
    tipo: registro.tipo,
    rotulo: registro.rotulo,
    preco: registro.preco,
    validadeAte: registro.validadeAte || null,
  });
});

// Painel admin: últimas cobranças.
app.get('/pagamentos/admin', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  res.json({ pagamentos: pagamentosStore.listarTodos() });
});

// ---------------------------------------------------------------------------
// CONTAS (registro central para a lista de transmissão do admin)
// O app chama /contas/registrar logo após verificar o email; preferências e
// cancelamentos mantêm o registro sempre atualizado — sem importar lista à mão.
// ---------------------------------------------------------------------------

const limiteContas = rateLimit({ windowMs: 60 * 1000, max: 30 });

app.post('/contas/registrar', limiteContas, (req, res) => {
  const { email, dispositivoId, receberOfertas } = req.body || {};
  const conta = contasStore.registrarOuAtualizar({ email, dispositivoId, receberOfertas });
  if (!conta) return res.status(400).json({ ok: false, codigo: 'EMAIL_INVALIDO' });
  res.json({ ok: true });
});

app.post('/contas/preferencias', limiteContas, (req, res) => {
  const { email, receberOfertas } = req.body || {};
  const conta = contasStore.definirPreferencias({ email, receberOfertas });
  if (!conta) return res.status(404).json({ ok: false, codigo: 'CONTA_NAO_ENCONTRADA' });
  res.json({ ok: true, receberOfertas: conta.receberOfertas });
});

app.post('/contas/cancelar', limiteContas, (req, res) => {
  const { email } = req.body || {};
  const conta = contasStore.definirPlano({ email, plano: 'basico' });
  if (!conta) return res.status(404).json({ ok: false, codigo: 'CONTA_NAO_ENCONTRADA' });
  res.json({ ok: true });
});

// Painel admin: usuários separados por segmento + exportação da lista de
// transmissão. A lista é gerada na hora a partir do registro — novos usuários,
// mudanças de plano e cancelamentos aparecem automaticamente.
app.get('/contas/admin', (req, res) => {
  if (!exigirAdmin(req, res)) return;
  const segmento = String((req.query && req.query.segmento) || 'todos');
  if (!['todos', 'assinantes', 'basicos', 'ofertas', 'cancelados'].includes(segmento)) {
    return res.status(400).json({ erro: 'Segmento inválido.' });
  }
  const contas = contasStore.listar(segmento);
  if (String((req.query && req.query.formato) || '') === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="lista-transmissao-${segmento}.csv"`
    );
    return res.send('\uFEFF' + contasStore.paraCSV(contas));
  }
  res.json({ ok: true, total: contas.length, contas });
});

if (require.main === module) {
  // ---- App dos testadores (SPA estática) — registrada APÓS todas as rotas de API ----
// Serve /_expo/*, /assets/*, /manifest.json, /favicon.ico, /sw.js e /icons/* da
// pasta tester-app. A raiz '/' já entrega o index.html para navegadores (patch
// no GET '/'), então o PWA e a IA convivem na MESMA origem (sem CORS).
if (SERVIR_TESTER && TEM_TESTER_APP) {
  app.use(express.static(TESTER_APP_DIR, { maxAge: '1h', index: false }));
}

app.listen(PORT, () => {
    console.log(`[AquarIApp Server] rodando em http://localhost:${PORT}`);
    console.log(`Chaves detectadas: ${semChaves().join(', ') || 'nenhuma — preencha o .env'}`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
    console.log(`  Ofertas:    /admin-ofertas`);
    console.log(`  Catálogos:  /admin-catalogos`);
    console.log(`  Usuários:   /admin-usuarios`);
  });
}
module.exports = { app, viaGemini, viaPlantNet, viaOpenAI, viaGoogleVision, viaFaunaBrasileira, classificarTipoGemini, validarFotoGemini, validarFotoOpenAI, filtrarCronogramaSeguro, detectarFaunaSensivel };
