const fs = require('fs');
const path = require('path');
const Module = require('module');

const APP = path.join(__dirname, '..', 'AquarIApp');
const APP_NODE_MODULES = path.join(APP, 'node_modules');
const babel = require(path.join(APP_NODE_MODULES, '@babel', 'core'));
const presetExpo = path.join(
  APP_NODE_MODULES,
  'expo',
  'node_modules',
  'babel-preset-expo'
);

const TMP = path.join(__dirname, '.tmp-catalogos');
const OUT = path.join(__dirname, 'catalogos');

const ARQUIVOS = [
  'catalogoEspecies',
  'faunaBrasileira',
  'faunaComplementar',
  'catalogoDoencas',
  'catalogoAlimentos',
  'produtos',
  'catalogoAlgas',
  'catalogoMicroorganismos',
];

function transpilar(nome) {
  const src = path.join(APP, 'src', 'data', `${nome}.js`);
  let code = fs.readFileSync(src, 'utf8');
  code = code
    .split(/\r?\n/)
    .filter((l) => !/^\s*import .*catalogosDinamicos/.test(l))
    .filter((l) => !/^\s*registrarBase\(/.test(l))
    .filter((l) => !/^\s*foto:\s*require\(/.test(l))
    .join('\n');
  const resultado = babel.transformSync(code, {
    presets: [[presetExpo, { jsxRuntime: 'classic' }]],
    babelrc: false,
    configFile: false,
    filename: src,
  });
  fs.writeFileSync(path.join(TMP, `${nome}.js`), resultado.code);
}

function carregar(nome) {
  const mod = require(path.join(TMP, `${nome}.js`));
  return mod;
}

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

ARQUIVOS.forEach(transpilar);

const especies = carregar('catalogoEspecies').catalogoEspecies;
const catalogos = {
  especies: especies.filter((e) => e.tipo !== 'flora'),
  flora: especies.filter((e) => e.tipo === 'flora'),
  faunaBrasileira: carregar('faunaBrasileira').faunaBrasileira,
  faunaComplementar: carregar('faunaComplementar').faunaComplementar,
  doencas: carregar('catalogoDoencas').catalogoDoencas || carregar('catalogoDoencas').default,
  produtos: carregar('produtos').default,
  algas: carregar('catalogoAlgas').catalogoAlgas || carregar('catalogoAlgas').default,
  microorganismos:
    carregar('catalogoMicroorganismos').catalogoMicroorganismos ||
    carregar('catalogoMicroorganismos').default,
};

for (const nome of Object.keys(catalogos)) {
  const lista = catalogos[nome];
  if (!Array.isArray(lista)) {
    console.error(`[gerarCatalogos] ${nome}: não é um array`);
    continue;
  }
  fs.writeFileSync(path.join(OUT, `${nome}.json`), JSON.stringify(lista, null, 1), 'utf8');
  console.log(`[gerarCatalogos] ${nome}.json -> ${lista.length} itens (${(fs.statSync(path.join(OUT, `${nome}.json`)).size / 1024).toFixed(1)} KB)`);
}

console.log('[gerarCatalogos] concluído.');
