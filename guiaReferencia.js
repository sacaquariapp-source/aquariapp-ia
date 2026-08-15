// Base de conhecimento extraída de "Seu Novo Aquário — fazendo certo desde o início"
// (manual da Alcon, PDF adicionado pelo usuário). Usada como fonte de enriquecimento
// dos prompts de IA (cronograma, sugestões e diagnóstico).

const GUIA_REFERENCIA = `GUIA DE REFERÊNCIA (manual "Seu Novo Aquário" — Alcon):

[MONTAGEM]
- Para iniciar, prefira aquários de 80 a 100 litros: o equilíbrio biológico é mais fácil de manter. Evite aquários globo (dificultam manutenção e estressam os peixes); o formato retangular é o melhor.
- O aquário deve ficar sobre placa de isopor de pelo menos 1 cm para nivelar imperfeições do móvel. Cada litro de água pesa ~1 kg.
- A água de torneira contém cloro, que é tóxico aos peixes: SEMPRE trate com condicionador (anticloro) antes de usar.
- Deixe o aquário passar por MATURAÇÃO (ciclagem) de pelo menos 1 semana antes de introduzir os primeiros peixes, com os equipamentos ligados e a água monitorada.
- Aclimatação: flutue o saco fechado 15 minutos, adicione um pouco de água do aquário ao saco, aguarde, e transfira o peixe com puçá descartando a água do transporte.

[LOTAÇÃO / POVOAMENTO]
- Regra empírica de lotação: aproximadamente 1 litro de água para cada 1 cm de comprimento de peixe.
- Evite misturar peixes de tamanhos muito distintos (os menores podem ser devorados) e espécies incompatíveis (ex.: pH muito diferentes ou dóceis com agressivos).
- Ao comprar, evite peixes parados, com nadadeiras encolhidas ou manchas: podem contaminar o aquário.

[EQUIPAMENTOS / ILUMINAÇÃO]
- Temperatura de aquário comunitário tropical: entre 22 e 28 °C (para espécies específicas, respeitar a faixa da espécie).
- Iluminação: 8 a 12 horas por dia, de preferência de dia. NUNCA deixe a luz acesa à noite — os peixes precisam de escuridão para dormir. Excesso de luz causa estresse e proliferação de algas.
- Filtro e oxigenação devem ficar sempre ligados (exceto na manutenção). Na falta de energia, um aquário sem superpopulação aguenta algumas horas.
- Lave as mídias do filtro com água retirada do próprio aquário (nunca com água da torneira com cloro, que mata as bactérias benéficas).

[MANUTENÇÃO]
- Trocas parciais de água (TPA): cerca de 20% do volume a cada 2 semanas, com sifonagem de fundo para retirar matéria orgânica. A água nova deve ser tratada e estar na mesma temperatura/pH da água do aquário. Aplique condicionador a cada TPA.
- Pequenas quantidades de algas verdes no vidro indicam boa qualidade de água; crescimento excessivo indica excesso de luz.

[ALIMENTAÇÃO]
- Forneça quantidade que os peixes consumam em no máximo 5 minutos, idealmente 2 ou mais vezes ao dia. Excesso de comida altera a qualidade da água (compostos nitrogenados) e causa problemas hepáticos.
- Alimente com o aquário iluminado; peixes noturnos recebem um pouco de ração à noite.
- Prefira rações industriais balanceadas; alimentos vivos podem introduzir doenças.

[CICLO DO NITROGÊNIO / QUALIDADE DA ÁGUA]
- A matéria orgânica vira AMÔNIA (tóxica), que é oxidada a NITRITO (tóxico) e depois a NITRATO (menos tóxico, usado por plantas e algas). Bactérias do filtro biológico fazem esse ciclo.
- Amônia ou nitrito altos: verifique filtragem, sifonagem + TPA, excesso de comida e superpopulação.
- Meça o pH ao menos 1x por semana. Correções de pH SEMPRE graduais (mudanças bruscas causam choque químico).

[PLANTAS]
- Plantas absorvem nitrato e ajudam no equilíbrio. Plantas maiores vão atrás; menores/rasteiras na frente.
- Pode periodicamente; desinfete novas plantas (evita caramujos e doenças). Ferro é nutriente importante.

[DOENÇAS]
- Prevenção é o melhor remédio: água limpa e observação dos peixes. A maioria das doenças vem de manutenção inadequada ou peixes doentes introduzidos.
- PARASITOSES (ex.: Íctio/Ponto Branco, Ichthyophthirius multifiliis): pontos brancos como sal no corpo e nadadeiras, peixe esfregando-se, nadadeiras fechadas. Tratar com medicamento antiparasitário mantendo a temperatura entre 28 e 30 °C durante o tratamento.
- MICOSES (fungos, ex.: Saprolegnia): manchas brancas com tufos semelhantes a algodão no corpo, nadadeiras ou boca. Usar fungicida; fungos aproveitam lesões existentes.
- BACTERIOSES: nadadeiras roídas, necroses no corpo (externas); hidropsia (ventre volumoso) ou "barriga seca" (internas). Usar antibiótico para peixes.`;

module.exports = { GUIA_REFERENCIA };
