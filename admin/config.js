// Configuração do painel. Nenhum segredo aqui: este arquivo é público.
// O painel fala só com o servidor do painel (Cloudflare Worker), nunca direto com o GitHub.
(function () {
  'use strict';
  var host = location.hostname;
  var local = host === 'localhost' || host === '127.0.0.1';
  window.HG_CMS = {
    // Em desenvolvimento local: wrangler dev na porta 8787.
    // Produção: A CONFIRMAR (placeholder abaixo). CSP E apiBase MUDAM JUNTOS: ao trocar o endereço do
    // Worker aqui, troque o MESMO host no connect-src da CSP em admin/index.html (host exato, sem
    // curinga *.workers.dev). Se só um mudar, o navegador bloqueia todas as chamadas do painel.
    // O E2E (cenário 1) confere que os dois batem.
    apiBase: local ? 'http://127.0.0.1:8787' : 'https://hg-cms-api.seu-subdominio.workers.dev',
    page: 'index.html',
    // Cloudflare Turnstile (anti-robô no login). Chave PÚBLICA do site (sitekey), não é segredo.
    // Vazio = sem verificação (dev). Produção: A CONFIRMAR; só preencher junto com o
    // secret TURNSTILE_SECRET no Worker, senão o login recusa todo mundo (ou ninguém é verificado).
    turnstileSiteKey: local ? '' : '',
    // Limites do /publish (os mesmos do servidor; o servidor confere de novo).
    maxImageMB: 3,      // cada foto, já reduzida
    maxImages: 6,       // fotos por publicação
    maxPublishMB: 12,   // corpo inteiro do pedido (fotos vão em base64, ~4/3 do tamanho)
    maxImageWidth: 2000
  };
})();
