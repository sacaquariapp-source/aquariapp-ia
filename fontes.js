/*
 * fontes.js — Fontes externas de enriquecimento do Identificador Fauna/Flora.
 *
 * Fontes integradas:
 *  - Aquarismo Paulista (WordPress REST API): fichas técnicas de peixes/plantas.
 *  - Fishipedia: fichas de peixes (slug = nome científico em minúsculas com hífens).
 *  - Chácara Takeyoshi: catálogo de plantas (índice próprio crawlado das 7 categorias).
 *  - Trefle (API de plantas, requer TREFLE_TOKEN): nome comum PT, família e fotos.
 *  - iNaturalist (API pública): nome comum, taxonomia e foto de referência.
 *  - FishBase (API rOpenSci): família, ordem e classe dos peixes.
 *  - SpeciesLink (rede CRIA, requer SPECIESLINK_API_KEY): ocorrências no Brasil.
 *  - GBIF (API pública, sem chave): taxonomia validada, nome comum PT, família.
 *
 * A função principal é enriquecerComFontes(resultado), que preenche campos
 * vazios de um resultado da IA usando as fontes em cascata e retorna um
 * array "fontes" com os provedores consultados.
 */

const USER_AGENT = 'AquarIApp/1.0 (+identificador de fauna/flora para aquarismo)';
const TIMEOUT_MS = 4000;
const LIMPAR_HTML = /<script[\s\S]*?<\/script>/gi;

async function obterTexto(url, { json = false, accept = 'text/html' } = {}) {
  const controle = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, {
    signal: controle,
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    redirect: 'follow',
  });
  if (!res.ok) return null;
  return json ? res.json() : res.text();
}

function limparTexto(texto) {
  return String(texto || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function htmlParaTexto(html) {
  return String(html || '')
    .replace(LIMPAR_HTML, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .split('\n')
    .map((l) => limparTexto(l))
    .filter(Boolean);
}

function extrairTexto(html, padrao) {
  const m = String(html || '').match(padrao);
  return m ? limparTexto(m[1]) : '';
}

function validarResultado(r) {
  if (!r) return false;
  return Boolean(r.nomeCientifico && r.nomeCientifico !== '—') || Boolean(r.nomeComum && r.nomeComum !== '—');
}

/* ============================================================
 * 1. AQUARISMO PAULISTA (WordPress com REST API)
 * ============================================================ */
const AQP_WP = 'http://www.aquarismopaulista.com/wp-json/wp/v2';

async function buscarAquarismoPaulista(termo) {
  try {
    const busca = await obterTexto(
      `${AQP_WP}/search?search=${encodeURIComponent(termo)}&per_page=10&_fields=id,url,subtype,title`,
      { json: true }
    );
    if (!busca || busca.length === 0) return null;

    const ids = busca.filter((b) => b.subtype === 'post').map((b) => b.id);
    const candidatos = (
      await Promise.all(
        ids.slice(0, 3).map((id) =>
          obterTexto(`${AQP_WP}/posts/${id}?_fields=id,slug,title,content,link`, { json: true })
        )
      )
    ).filter(Boolean);
    if (candidatos.length === 0) return null;

    const normalizado = normalizar(termo).replace(/\s+/g, '-');
    const temNomeBinomial = (c) => /Nome binomial/i.test(c.content?.rendered || '');
    const slugBate = (c) => normalizar(c.slug).replace(/\s+/g, '-') === normalizado;
    const tituloBate = (c) => normalizar(c.title?.rendered || '').includes(normalizar(termo));

    const alvo =
      candidatos.find((c) => temNomeBinomial(c) && slugBate(c)) ||
      candidatos.find((c) => temNomeBinomial(c) && tituloBate(c)) ||
      candidatos.find((c) => temNomeBinomial(c)) ||
      candidatos.find((c) => slugBate(c)) ||
      candidatos[0];

    const conteudo = alvo.content?.rendered || '';
    const titulo = limparTexto(alvo.title?.rendered || '');

    const classificacao = limparTexto(
      (String(conteudo).match(/Fam[ií]lia:\s*([\s\S]{0,80}?)(?:<\/p>|•|<br)/i) || [])[1]?.replace(/<[^>]+>/g, ' ')
    ) || '';
    const nomeBinomial = extrairTexto(conteudo, /Nome binomial:\s*([^<]+)/i);
    const sinonimos = extrairTexto(conteudo, /Sin[oô]nimos:\s*([^<]+)/i);
    const nomeComumSecao = extrairTexto(conteudo, /Nomes comuns<\/strong>\s*<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/i);

    const distribuicao = extrairTexto(conteudo, /Distribui[çc][ãa]o[^<]*<\/strong>\s*<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
    const ambiente = extrairTexto(conteudo, /par[âa]metros da [áa]gua<\/strong>\s*<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
    const tamanhoSecao = extrairTexto(conteudo, /Tamanho adulto<\/strong>\s*<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
    const manutencao = extrairTexto(conteudo, /Manuten[çc][ãa]o em aqu[áa]rio<\/strong>\s*<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
    const alimentacao = extrairTexto(conteudo, /Alimenta[çc][ãa]o<\/strong>\s*<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
    const descricao = extrairTexto(conteudo, /Descri[çc][ãa]o<\/strong>\s*<\/p>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
    const foto = extrairTexto(conteudo, /<img[^>]*src="([^"]*)"/) || '';

    const ph = limparTexto(extrairTexto(ambiente, /pH:\s*([\d,.\s–—-]+?)\s*•/i));
    const dureza = limparTexto(extrairTexto(ambiente, /Dureza:\s*([\d,.\s–—-]+?)\s*•/i));
    const temperatura = limparTexto(extrairTexto(ambiente, /([0-9]{1,3}°C\s*[–-]\s*[0-9]{1,3}°C)/i));
    const tamanho = limparTexto(extrairTexto(tamanhoSecao, /([0-9]+(?:\s?cm| mm))(?:\s*[^\d.]*)?/i));

    const r = {
      provedor: 'Aquarismo Paulista',
      confianca: null,
      tipo: 'fauna',
      nomeComum: limparTexto((nomeComumSecao || '').split('.').filter(Boolean)[0]) || titulo.replace(/\s*\(.*$/, ''),
      nomeCientifico: nomeBinomial.replace(/\s*\(.*$/, '') || alvo.slug || titulo,
      familia: classificacao || '—',
      origem: distribuicao || '—',
      tamanho: tamanho || '—',
      temperatura: temperatura || '—',
      ph: ph || '—',
      dureza: dureza || '—',
      dieta: alimentacao ? alimentacao.split('.').filter(Boolean)[0] + '.' : '—',
      comportamento: manutencao ? manutencao.split('.').slice(0, 2).join('.') + '.' : '—',
      aquarioMinimo: limparTexto(extrairTexto(manutencao, /\((\d+(?:,\d+)?\s*litros?)\)/i)) || '—',
      dificuldade: '—',
      iluminacao: '—',
      co2: '—',
      crescimento: '—',
      tipoPlanta: '—',
      observacoes: descricao || '',
      foto,
      url: alvo.link || `http://www.aquarismopaulista.com/${alvo.slug}/`,
      sinonimos,
    };
    return validarResultado(r) ? r : null;
  } catch (e) {
    console.error('[fontes] Aquarismo Paulista:', e.message);
    return null;
  }
}

/* ============================================================
 * 2. FISHIPEDIA (páginas de espécies por slug do nome científico)
 * ============================================================ */
const FISH_BASE = 'https://www.fishi-pedia.com';

function slugCientifico(nome) {
  return String(nome || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function obterCampoFish(html, rotulo) {
  const esc = rotulo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(html || '').match(
    new RegExp(`ListHighlightInfo--Label">${esc}<[^>]*>[\\s\\S]{0,300}?ListHighlightInfo--Value[^>]*>([\\s\\S]{0,120}?)<\\/`, 'i')
  );
  if (!m) return '';
  return limparTexto(m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' '));
}

async function buscarFishipedia(termo) {
  try {
    const slug = slugCientifico(termo);
    if (!slug) return null;
    const html = await obterTexto(`${FISH_BASE}/fishes/${slug}`);
    if (!html) return null;
    if (html.length < 2000) return null;

    const nomeComum = limparTexto((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]?.replace(/<[^>]+>/g, ' ')) || '—';
    const nomeCientifico = limparTexto(
      (html.match(/<title>[\s\S]{0,200}?•\s*([A-Z][a-z]+ [a-z]+)\s*•/i) || [])[1] || slug
    );
    const familia = obterCampoFish(html, 'Family') || '—';
    const dieta = obterCampoFish(html, 'diet') || '—';
    const sociabilidade = obterCampoFish(html, 'Sociability') || '—';
    const territorial = obterCampoFish(html, 'territorial') || '—';
    const tamanho = obterCampoFish(html, 'Average size') || '—';
    const temperatura = obterCampoFish(html, 'Temperature') || '—';
    const ph = obterCampoFish(html, 'pH (acidity)') || '—';
    const dureza = obterCampoFish(html, 'gh (hardness)') || '—';
    const dificuldade = obterCampoFish(html, 'Maintenance difficulty') || '—';

    const comportamento = [
      sociabilidade && sociabilidade !== '—' ? `Vive em ${sociabilidade}` : '',
      /yes/i.test(territorial) ? 'Territorial' : '',
    ].filter(Boolean).join(', ') || '—';

    const texto = htmlParaTexto(html).join('\n');
    const aquario = limparTexto((texto.match(/(A|An)\s*\d+(?:\.\d+)?\s*liters?\s+(?:tank|aquarium)[^.]*\./i) || [])[0] || '—');
    const origem = limparTexto((texto.match(/native to ([^.,]+)/i) || [])[1] || '—');
    const observacoes = limparTexto((texto.match(/How to recognize[\s\S]*?\n((?:[^\n]{40,}\n){1,3})/) || [])[1] || '') || texto.slice(0, 500);

    const og = (html.match(/og:image" content="([^"]*)"/i) || [])[1];
    const foto = og && !og.startsWith('http') ? `${FISH_BASE}${og}` : og || '';

    const r = {
      provedor: 'Fishipedia',
      confianca: null,
      tipo: 'fauna',
      nomeComum,
      nomeCientifico,
      familia,
      origem: origem === '—' ? '—' : `${origem} (Fishipedia)`,
      tamanho,
      temperatura,
      ph,
      dureza,
      dieta,
      comportamento,
      aquarioMinimo: aquario,
      dificuldade: dificuldade !== '—' ? dificuldade : '—',
      iluminacao: '—',
      co2: '—',
      crescimento: '—',
      tipoPlanta: '—',
      observacoes,
      foto,
      url: `${FISH_BASE}/fishes/${slug}`,
    };
    return validarResultado(r) ? r : null;
  } catch (e) {
    console.error('[fontes] Fishipedia:', e.message);
    return null;
  }
}

/* ============================================================
 * 3. CHÁCARA TAKEYOSHI (catálogo de plantas, sem busca — índice próprio)
 * ============================================================ */
const CHACARA_BASE = 'https://www.chacaratakeyoshi.com.br';
const CHACARA_CATS = [
  [1, 'plantas-baixas'],
  [2, 'plantas-maedias'],
  [3, 'plantas-altas'],
  [4, 'plantas-para-troncos-e-rochas'],
  [5, 'plantas-flutuantes'],
  [7, 'lagos-e-paludaarios'],
];
let cachePromise = null;
let cacheCatalogo = null;

async function montarIndiceChacara() {
  if (cacheCatalogo) return cacheCatalogo;
  if (cachePromise) return cachePromise;

  cachePromise = (async () => {
    const paginas = await Promise.all(
      CHACARA_CATS.map(async ([id, slug]) => {
        const html = await obterTexto(`${CHACARA_BASE}/produtos/${id}/${slug}`);
        return html || '';
      })
    );
    const index = [];
    for (const html of paginas) {
      if (!html) continue;
      const blocos = html.split('col-sm-3 text-center').slice(1);
      for (const bloco of blocos) {
        const link = bloco.match(/produto\/(\d+)\/([a-z0-9-]+)"/);
        const titulo = bloco.match(/titulo-bold-verde">([^<]+)</);
        if (!link || !titulo) continue;
        index.push({
          id: link[1],
          slug: link[2],
          nome: limparTexto(titulo[1]),
          url: `${CHACARA_BASE}/produto/${link[1]}/${link[2]}`,
        });
      }
    }
    const unicos = [];
    const vistos = new Set();
    for (const p of index) {
      if (!vistos.has(p.id)) {
        vistos.add(p.id);
        unicos.push(p);
      }
    }
    if (unicos.length > 0) {
      cacheCatalogo = unicos;
    }
    cachePromise = null;
    return unicos;
  })();

  return cachePromise;
}

function pontuarMatch(termo, nome) {
  const t = normalizar(termo);
  const n = normalizar(nome);
  if (n === t) return 100;
  if (n.includes(t)) return 90;
  const termos = t.split(/\s+/);
  const encontrados = termos.filter((w) => w.length >= 3 && n.includes(w)).length;
  return termos.length ? Math.round((encontrados / termos.length) * 80) : 0;
}

async function buscarChacaraTakeyoshi(termo) {
  try {
    const indice = await montarIndiceChacara();
    const alvos = indice
      .map((p) => ({ ...p, score: pontuarMatch(termo, p.nome) }))
      .sort((a, b) => b.score - a.score);
    if (!alvos.length || alvos[0].score < 45) return null;

    const pagina = await obterTexto(alvos[0].url);
    if (!pagina) return null;

    const nome = alvos[0].nome;
    const ph = limparTexto(extrairTexto(pagina, /[Pp][Hh]\s*[:\-]?\s*([0-9][0-9,.\s-]{2,12})/)) || '—';
    const temperatura = limparTexto(extrairTexto(pagina, /([0-9]{1,2}\s*(?:-|a)\s*[0-9]{1,2}\s*°C|[0-9]{1,2}\s*°C)/i)) || '—';
    const dureza = limparTexto(extrairTexto(pagina, /[Dd]ureza da [áa]gua\s*[:\-]?\s*([^<\n]{2,40})/)) || '—';
    const luz = limparTexto(extrairTexto(pagina, /[Ll]uz\s*[:\-]?\s*([^<\n]{2,40})/)) || '—';
    const caracteristicas = limparTexto(
      extrairTexto(pagina, /Caracter[ií]sticas<\/b>\s*<br\s*\/?>\s*([\s\S]*?)<\/div>/i) ||
        extrairTexto(pagina, /Caracter[ií]sticas<\/b>\s*<br\s*\/?>\s*([\s\S]*?)<\/p>/i)
    );
    const foto = extrairTexto(pagina, /<img[^>]*src="([^"]*thumb-produto[^"]*)"[^>]*class="[^"]*img-responsive[^"]*"/i) || '';

    const r = {
      provedor: 'Chácara Takeyoshi',
      confianca: null,
      tipo: 'flora',
      nomeComum: nome,
      nomeCientifico: nome,
      familia: '—',
      origem: '—',
      tamanho: '—',
      temperatura,
      ph,
      dureza,
      dieta: '—',
      comportamento: '—',
      aquarioMinimo: '—',
      dificuldade: '—',
      iluminacao: luz !== '—' ? luz : '—',
      co2: '—',
      crescimento: '—',
      tipoPlanta: '—',
      observacoes: caracteristicas || '',
      foto,
      url: alvos[0].url,
    };
    return validarResultado(r) ? r : null;
  } catch (e) {
    console.error('[fontes] Chácara Takeyoshi:', e.message);
    return null;
  }
}

/* ============================================================
 * 4. TREFLE (API de plantas — enriquecimento de flora)
 *    Requer TREFLE_TOKEN (gratuito em trefle.io). Retorna nome
 *    comum (PT), família, gênero e fotos da espécie.
 * ============================================================ */
const TREFLE_BASE = 'https://trefle.io/api/v1';

async function buscarTrefle(termo) {
  try {
    const token = process.env.TREFLE_TOKEN;
    if (!token) return null;
    const busca = await obterTexto(
      `${TREFLE_BASE}/species/search?token=${encodeURIComponent(token)}&q=${encodeURIComponent(termo)}&limit=1`,
      { json: true }
    );
    const primeiro = busca?.data?.[0];
    if (!primeiro) return null;

    const nomeCientifico = primeiro.scientific_name || '';
    const nomesPorIdioma = primeiro.common_names || {};
    const nomeComumPT = (Array.isArray(nomesPorIdioma.por) && nomesPorIdioma.por[0]) || primeiro.common_name || '';
    const fotos = (primeiro.images || []).filter((i) => i && i.url);

    const r = {
      provedor: 'Trefle',
      confianca: null,
      tipo: 'flora',
      nomeComum: nomeComumPT || 'Planta identificada',
      nomeCientifico: nomeCientifico || termo,
      familia: primeiro.family || '—',
      origem: '—',
      tamanho: '—',
      temperatura: '—',
      ph: '—',
      dureza: '—',
      dieta: '—',
      comportamento: '—',
      aquarioMinimo: '—',
      dificuldade: '—',
      iluminacao: '—',
      co2: '—',
      crescimento: '—',
      tipoPlanta: '—',
      observacoes: primeiro.family_common_name
        ? `Dados de cultivo e distribuição da base Trefle. Família: ${primeiro.family_common_name}.`
        : 'Dados da base Trefle.',
      foto: fotos[0] ? fotos[0].url : '',
    };
    return validarResultado(r) ? r : null;
  } catch (e) {
    console.error('[fontes] Trefle:', e.message);
    return null;
  }
}

/* ============================================================
 * 5. iNaturalist (API pública — enriquecimento de fauna/flora)
 *    Sem chave. Traz nome comum, rank taxonômico e foto de
 *    referência da maior base colaborativa de biodiversidade.
 * ============================================================ */
const INAT_BASE = 'https://api.inaturalist.org/v1';

async function buscarINaturalist(termo) {
  try {
    const busca = await obterTexto(
      `${INAT_BASE}/taxa?q=${encodeURIComponent(termo)}&per_page=3&order=desc&order_by=observations_count`,
      { json: true }
    );
    const resultados = busca?.results || [];
    if (resultados.length === 0) return null;

    const melhor = resultados.find((t) => t.rank === 'species') || resultados[0];
    if (!melhor || !melhor.name) return null;

    const foto =
      melhor.default_photo?.large_url || melhor.default_photo?.medium_url || melhor.default_photo?.square_url || '';
    const familiaAncestral =
      (melhor.ancestors || []).find((a) => a.rank === 'family')?.name || '';

    const r = {
      provedor: 'iNaturalist',
      confianca: null,
      tipo: 'fauna',
      nomeComum: melhor.preferred_common_name || 'Espécie não catalogada',
      nomeCientifico: melhor.name,
      familia: familiaAncestral || '—',
      origem: '—',
      tamanho: '—',
      temperatura: '—',
      ph: '—',
      dureza: '—',
      dieta: '—',
      comportamento: '—',
      aquarioMinimo: '—',
      dificuldade: '—',
      iluminacao: '—',
      co2: '—',
      crescimento: '—',
      tipoPlanta: '—',
      observacoes: melhor.observations_count
        ? `${melhor.observations_count} observações registradas na comunidade iNaturalist.`
        : 'Dados da comunidade iNaturalist.',
      foto,
    };
    return validarResultado(r) ? r : null;
  } catch (e) {
    console.error('[fontes] iNaturalist:', e.message);
    return null;
  }
}

/* ============================================================
 * 6. FISHBASE (API rOpenSci — enriquecimento de peixes)
 *    Sem chave. Traz família, ordem, classe e nome comum (EN)
 *    das 36.500+ espécies catalogadas no FishBase.
 * ============================================================ */
const FISHBASE_BASE = 'https://fishbase.ropensci.org';

async function buscarFishBase(termo) {
  try {
    // "Paracheirodon innesi" -> Genus=Paracheirodon&Species=innesi
    const partes = String(termo || '').trim().split(/\s+/);
    if (partes.length < 2) return null;
    const genus = partes[0];
    const species = partes.slice(1).join(' ');

    const dados = await obterTexto(
      `${FISHBASE_BASE}/species?Genus=${encodeURIComponent(genus)}&Species=${encodeURIComponent(species)}`,
      { json: true }
    );
    const linha = dados?.data?.[0];
    if (!linha) return null;

    const nomeComum = linha.FBname || '';
    const r = {
      provedor: 'FishBase',
      confianca: null,
      tipo: 'fauna',
      nomeComum: nomeComum || 'Espécie não catalogada',
      nomeCientifico: linha.Genus && linha.Species ? `${linha.Genus} ${linha.Species}` : termo,
      familia: linha.Family || '—',
      origem: '—',
      tamanho: '—',
      temperatura: '—',
      ph: '—',
      dureza: '—',
      dieta: '—',
      comportamento: '—',
      aquarioMinimo: '—',
      dificuldade: '—',
      iluminacao: '—',
      co2: '—',
      crescimento: '—',
      tipoPlanta: '—',
      observacoes: [linha.Order, linha.Class].filter(Boolean).join(' · ')
        ? `Classificação: ${[linha.Order, linha.Class].filter(Boolean).join(' · ')}. Dados do FishBase.`
        : 'Dados do FishBase.',
      foto: '',
    };
    return validarResultado(r) ? r : null;
  } catch (e) {
    console.error('[fontes] FishBase:', e.message);
    return null;
  }
}

/* ============================================================
 * 7. SPECIESLINK (rede CRIA — ocorrências no Brasil)
 *    Requer SPECIESLINK_API_KEY (gratuita em specieslink.net/aut/profile/apikeys).
 *    Endpoint atual: specieslink.net/ws/1.0/search (GeoJSON). Com limit=0
 *    retorna apenas numberMatched (total), sem baixar os registros.
 * ============================================================ */
const SPECIESLINK_BASE = 'https://specieslink.net/ws/1.0/search';

async function buscarSpeciesLink(termo) {
  try {
    const apikey = process.env.SPECIESLINK_API_KEY;
    if (!apikey) return null;
    const dados = await obterTexto(
      `${SPECIESLINK_BASE}?apikey=${encodeURIComponent(apikey)}&scientificname=${encodeURIComponent(termo)}&limit=0`,
      { json: true }
    );
    const total = dados?.numberMatched || 0;
    if (!total || total <= 0) return null;
    const r = {
      provedor: 'SpeciesLink',
      confianca: null,
      tipo: 'fauna',
      nomeComum: 'Espécie não catalogada',
      nomeCientifico: termo,
      familia: '—',
      origem: 'Brasil',
      tamanho: '—',
      temperatura: '—',
      ph: '—',
      dureza: '—',
      dieta: '—',
      comportamento: '—',
      aquarioMinimo: '—',
      dificuldade: '—',
      iluminacao: '—',
      co2: '—',
      crescimento: '—',
      tipoPlanta: '—',
      observacoes: `${total} registro(s) em coleções científicas brasileiras (rede speciesLink).`,
      foto: '',
    };
    return validarResultado(r) ? r : null;
  } catch (e) {
    console.error('[fontes] SpeciesLink:', e.message);
    return null;
  }
}

/* ============================================================
 * 8. GBIF (Global Biodiversity Information Facility)
 *    API pública sem chave. Traz taxonomia confirmada, nome
 *    comum (PT), família, distribuição e foto de referência da
 *    maior base mundial de biodiversidade.
 * ============================================================ */
const GBIF_BASE = 'https://api.gbif.org/v1';

async function buscarGBIF(termo) {
  try {
    const match = await obterTexto(
      `${GBIF_BASE}/species/match?name=${encodeURIComponent(termo)}&verbose=true`,
      { json: true }
    );
    const usageKey = match?.usageKey;
    const nomeMatch = match?.canonicalName || match?.scientificName || '';
    if (!usageKey || !nomeMatch) return null;

    const detalhe = await obterTexto(`${GBIF_BASE}/species/${usageKey}`, { json: true });
    if (!detalhe) return null;

    // Nome comum em português (melhor esforço; aceita PT-BR ou en).
    let nomeComum = '';
    try {
      const vern = await obterTexto(`${GBIF_BASE}/species/${usageKey}/vernacularNames`, { json: true });
      const nomes = vern?.results || [];
      const pt = nomes.find((n) => (n.language || '').toLowerCase().startsWith('pt'));
      const en = nomes.find((n) => (n.language || '').toLowerCase().startsWith('en'));
      nomeComum = (pt || en || {})?.vernacularName || '';
    } catch (e) {
      /* sem nome comum */
    }

    const r = {
      provedor: 'GBIF',
      confianca: null,
      tipo: 'fauna',
      nomeComum: nomeComum || 'Espécie não catalogada',
      nomeCientifico: detalhe.scientificName || nomeMatch,
      familia: detalhe.family || '—',
      origem: detalhe.kingdom === 'Plantae' ? '—' : (detalhe.class || '—'),
      tamanho: '—',
      temperatura: '—',
      ph: '—',
      dureza: '—',
      dieta: '—',
      comportamento: '—',
      aquarioMinimo: '—',
      dificuldade: '—',
      iluminacao: '—',
      co2: '—',
      crescimento: '—',
      tipoPlanta: '—',
      observacoes: `Taxonomia validada pela base GBIF. Reino: ${detalhe.kingdom || '—'}, Classe: ${detalhe.class || '—'}.`,
      foto: '',
    };
    return validarResultado(r) ? r : null;
  } catch (e) {
    console.error('[fontes] GBIF:', e.message);
    return null;
  }
}

/* ============================================================
 * Orquestração: enriquecer um resultado com as fontes externas
 * ============================================================ */
function juntar(preenchido, novo) {
  if (!novo) return preenchido;
  const chaves = [
    'nomeComum', 'nomeCientifico', 'familia', 'origem', 'tamanho',
    'temperatura', 'ph', 'dureza', 'dieta', 'comportamento',
    'aquarioMinimo', 'dificuldade', 'iluminacao', 'co2', 'crescimento',
    'tipoPlanta', 'observacoes', 'foto',
  ];
  const vazio = (v) => !v || v === '—' || v === 'Planta identificada' || v === 'Espécie não catalogada' || v === 'Não identificado';
  const complemento = {};
  for (const chave of chaves) {
    if (vazio(preenchido[chave]) && !vazio(novo[chave])) complemento[chave] = novo[chave];
  }
  if (Object.keys(complemento).length === 0) return preenchido;
  return { ...preenchido, ...complemento, fontes: [...(preenchido.fontes || []), novo.provedor] };
}

async function enriquecerComFontes(resultado) {
  try {
    const termos = [resultado.nomeCientifico, resultado.nomeComum]
      .filter((t) => t && !t.includes('—') && t !== 'Não identificado' && t !== 'Espécie não catalogada');
    if (termos.length === 0) return resultado;

    const alvos = [...new Set(termos.map((t) => t.trim()))];
    let melhor = resultado;
    const fontes = [];

    for (const termo of alvos) {
      const promessas = [buscarFishipedia(termo), buscarAquarismoPaulista(termo), buscarChacaraTakeyoshi(termo)];
      const [fish, aqp, chacara] = await Promise.allSettled(promessas);
      if (fish.value) { melhor = juntar(melhor, fish.value); fontes.push('Fishipedia'); }
      if (aqp.value) { melhor = juntar(melhor, aqp.value); fontes.push('Aquarismo Paulista'); }
      if (chacara.value) { melhor = juntar(melhor, chacara.value); fontes.push('Chácara Takeyoshi'); }
      if (melhor !== resultado) break;
    }

    // Fontes internacionais (Trefle/iNaturalist/GBIF) e de ocorrência (SpeciesLink),
    // usadas para preencher campos que as fontes nacionais não cobrem.
    const ehFlora = resultado.tipo === 'flora';
    if (resultado.nomeCientifico && !resultado.nomeCientifico.includes('—')) {
      const extra = ehFlora
        ? [buscarTrefle(resultado.nomeCientifico), buscarINaturalist(resultado.nomeCientifico)]
        : [buscarFishBase(resultado.nomeCientifico), buscarINaturalist(resultado.nomeCientifico)];
      const [trefle, inat] = await Promise.allSettled(extra);
      if (ehFlora && trefle.value) { melhor = juntar(melhor, trefle.value); fontes.push('Trefle'); }
      if (inat.value) { melhor = juntar(melhor, inat.value); fontes.push('iNaturalist'); }
    }

    // GBIF: taxonomia confirmada e nome comum (PT) para fauna e flora.
    if ((!melhor.nomeCientifico || melhor.nomeCientifico.includes('—')) ||
        (melhor.nomeComum === 'Espécie não catalogada' && (melhor.familia === '—' || !melhor.familia))) {
      const [gbif] = await Promise.allSettled([buscarGBIF(resultado.nomeCientifico || resultado.nomeComum)]);
      if (gbif.value) { melhor = juntar(melhor, gbif.value); fontes.push('GBIF'); }
    }

    // SpeciesLink: só quando nenhuma fonte nacional confirmou a origem.
    if (melhor.origem === '—' || !melhor.origem) {
      const [spl] = await Promise.allSettled([buscarSpeciesLink(resultado.nomeCientifico || resultado.nomeComum)]);
      if (spl.value) { melhor = juntar(melhor, spl.value); fontes.push('SpeciesLink'); }
    }

    if (fontes.length === 0) return resultado;
    return { ...melhor, fontes: [...new Set(fontes)] };
  } catch (e) {
    console.error('[fontes] enriquecerComFontes:', e.message);
    return resultado;
  }
}

function comTimeoutEnriquecimento(resultado) {
  const ENRIQUECIMENTO_LIMITE = 6000;
  return Promise.race([
    enriquecerComFontes(resultado),
    new Promise((resolve) => setTimeout(() => resolve(resultado), ENRIQUECIMENTO_LIMITE)),
  ]);
}

module.exports = {
  enriquecerComFontes,
  comTimeoutEnriquecimento,
  buscarAquarismoPaulista,
  buscarFishipedia,
  buscarChacaraTakeyoshi,
  buscarTrefle,
  buscarINaturalist,
  buscarFishBase,
  buscarSpeciesLink,
  buscarGBIF,
};
