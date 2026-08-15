const LINGUAS = ['pt', 'en'];
const WIKI_TIMEOUT_MS = 6000;

function limparTexto(texto) {
  return String(texto || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function palavrasRelevantes(termo) {
  return String(termo || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)
    .filter((p) => p.length >= 3);
}

function eRelevante(termo, resumo) {
  const palavras = palavrasRelevantes(termo);
  if (palavras.length === 0) return true;
  const alvo = normalizar(limparTexto([resumo.title, resumo.extract, resumo.description].join(' ')));
  const casou = palavras.filter((p) => alvo.includes(p)).length;
  return casou >= Math.max(1, Math.ceil(palavras.length / 2));
}

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function extrairDoTexto(texto, padroes) {
  for (const padrao of padroes) {
    const m = String(texto || '').match(padrao);
    if (m && m[1]) return limparTexto(m[1]);
  }
  return '';
}

async function buscarTitulo(termo, idioma) {
  const url = `https://${idioma}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(termo)}&srlimit=1&format=json&origin=*`;
  const res = await fetch(url, { signal: AbortSignal.timeout(WIKI_TIMEOUT_MS) });
  if (!res.ok) return null;
  const json = await res.json();
  const item = json?.query?.search?.[0];
  return item?.title || null;
}

async function obterResumo(idioma, titulo) {
  const url = `https://${idioma}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titulo)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(WIKI_TIMEOUT_MS) });
  if (!res.ok) return null;
  return res.json();
}

async function enriquecerWikipedia(termo) {
  const resultados = await Promise.all(
    LINGUAS.map(async (idioma) => {
      try {
        const titulo = await buscarTitulo(termo, idioma);
        if (!titulo) return null;

        const resumo = await obterResumo(idioma, titulo);
        if (!resumo) return null;
        if (!eRelevante(termo, resumo)) return null;

        const extract = resumo.extract || '';
        const origem = extrairDoTexto(extract, [
          /origem[^\n.]{0,60}(?:no|na|nos|nas|em|de|do|da)?\s([A-Z][^,.;]{3,60})/,
          /nativ[oa][^\n.]{0,40}(?:do|da|de|do|dos|das)?\s([A-Z][^,.;]{3,60})/,
          /(?:do|da|de|dos|das)\s([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/,
        ]);
        const tamanho = extrairDoTexto(extract, [
          /(?:at[eé]|mede|cerca de|entre)\s([0-9][^,.;]{0,40}cm)/i,
          /([0-9][^,.;]{0,40}\s?cm)/,
        ]);
        const familia = extrairDoTexto(extract, [
          /fam[ií]lia\s+([A-ZÀ-Ú][a-zà-ú]+)/,
          /fam[ií]lia\s+([A-Z][a-z]+idae)/i,
        ]);

        return {
          idioma,
          titulo,
          descricao: resumo.description || '',
          nomeComum: resumo.displaytitle || '',
          extract: limparTexto(extract),
          foto: resumo.thumbnail?.source?.replace(/\?utm_.*$/, '') || '',
          origem: origem || '',
          tamanho: tamanho || '',
          familia: familia || '',
          url: resumo.content_urls?.desktop?.page || '',
        };
      } catch (e) {
        console.error(`[wikipedia] ${idioma}:`, e.message);
        return null;
      }
    })
  );

  const pt = resultados.find((r) => r?.idioma === 'pt');
  const en = resultados.find((r) => r?.idioma === 'en');
  const melhor = pt || en;
  if (!melhor) return null;

  const origem = melhor.origem || (en && pt ? pt.origem || en.origem : melhor.origem);
  return {
    provedor: 'Wikipedia',
    confianca: null,
    tipo: 'flora',
    nomeComum: melhor.descricao || melhor.nomeComum,
    nomeCientifico: melhor.titulo,
    familia: melhor.familia || (en && !pt ? en.familia : melhor.familia),
    origem: origem || '—',
    tamanho: melhor.tamanho || '—',
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
    observacoes: melhor.extract || 'Ficha parcial — informações limitadas na Wikipedia.',
    foto: melhor.foto || '',
    urlWikipedia: melhor.url,
  };
}

module.exports = { enriquecerWikipedia };
