const fs = require('fs');
const path = require('path');
const JSZip = require('C:/Users/isabella.salles/meu-novo-app/AquarIApp/node_modules/jszip');

const DOCX = 'C:/Users/isabella.salles/meu-novo-app/Catalogo algas.docx';
const ALVO = 'C:/Users/isabella.salles/meu-novo-app/AquarIApp/src/data/catalogoAlgas.js';

function slug(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizar(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

async function main() {
  const buffer = fs.readFileSync(DOCX);
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  const paragrafos = xml
    .split(/<w:p[ >]/)
    .map((p) => [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join(''));
  const linhas = paragrafos.map((t) => t.trim()).filter(Boolean);

  const isHeader = (l) => /^[IVX]+\.\s/.test(l) || /^\(\d+\s+a\s+\d+\)/.test(l);
  let grupo = '';
  const entradas = [];

  for (const l of linhas) {
    if (/^\[[\d,\s]+\]$/.test(l)) continue;
    if (isHeader(l)) {
      grupo = l.replace(/\([^)]*\)/g, '').trim();
      continue;
    }
    if (!l.includes('(')) continue;

    const limpa = l.replace(/\s*\[[\d,\s]+\]\s*$/g, '').trim();
    const ultParen = limpa.lastIndexOf('(');
    const fecha = limpa.lastIndexOf(')');
    if (ultParen < 0 || fecha < ultParen) continue;

    const descricao = limpa.slice(ultParen + 1, fecha).trim();
    const antes = limpa.slice(0, ultParen).trim();
    const primeiroParen = antes.indexOf('(');
    const cientifico = (primeiroParen >= 0 ? antes.slice(0, primeiroParen) : antes).trim();
    const nome = limpa;

    const alt = [];
    const adicionar = (t) => {
      const n = normalizar(t);
      if (n && n.length > 1 && !alt.includes(n)) alt.push(n);
    };
    adicionar(cientifico);
    const primeiraPalavra = cientifico.split(/\s+/)[0];
    if (primeiraPalavra) adicionar(primeiraPalavra);
    const conteudos = [...limpa.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
    conteudos.forEach((c) =>
      c
        .split(/\/| - |\(|\)|,/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach(adicionar)
    );

    entradas.push({
      id: `alga-${slug(cientifico)}`,
      nome,
      grupo,
      aspecto: descricao,
      causas: '',
      tratamento: '',
      pragasBiologicas: [],
      dicas: '',
      foto: '',
    });
  }

  const porId = new Map();
  entradas.forEach((e) => porId.set(e.id, e));
  const unicos = [...porId.values()];

  console.log(`[gerarAlgasDocx] ${entradas.length} linhas -> ${unicos.length} entradas`);

  const bloco = unicos.map((e) => `  ${JSON.stringify(e)}`).join(',\n');

  let codigo = fs.readFileSync(ALVO, 'utf8');
  const idx = codigo.lastIndexOf('];');
  if (idx === -1) {
    console.error('Não achei o fechamento do array em catalogoAlgas.js');
    process.exit(1);
  }
  codigo = codigo.slice(0, idx) + bloco + '\n];' + codigo.slice(idx + 2);
  fs.writeFileSync(ALVO, codigo, 'utf8');
  console.log(`[gerarAlgasDocx] inseridas ${unicos.length} entradas em catalogoAlgas.js`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
