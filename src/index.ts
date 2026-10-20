import { KVNamespace, Ai, ScheduledController, ExecutionContext } from "@cloudflare/workers-types";

// ==========================================
// INTERFACES E TIPOS
// ==========================================
export interface Env {
  AI: Ai;
  NEWS_KV: KVNamespace;
}

interface SiteConfig {
  name: string;
  url: string;
}

interface Headline {
  title: string;
  url: string;
  source: string;
  score: number;
}

interface AIClusterRaw {
  cluster_title: string;
  total_score: number;
  original_titles: string[];
}

interface FinalArticle {
  title: string;
  url: string;
  source: string;
}

interface FinalCluster {
  cluster_title: string;
  total_score: number;
  articles: FinalArticle[];
}

// ==========================================
// HANDLER DO HTMLREWRITER
// ==========================================
class HeadlineHandler implements HTMLRewriterElementContentHandlers {
  private weight: number;
  private sourceName: string;
  private baseUrl: string;
  private resultsArray: Headline[];
  private isInside: boolean = false;
  private currentHref: string | null = null;
  private textBuffer: string = "";

  constructor(weight: number, sourceName: string, baseUrl: string, resultsArray: Headline[]) {
    this.weight = weight;
    this.sourceName = sourceName;
    this.baseUrl = baseUrl;
    this.resultsArray = resultsArray;
  }

  element(element: Element): void {
    this.isInside = true;
    this.textBuffer = "";
    this.currentHref = element.getAttribute("href");

    if (element.onEndTag) {
      element.onEndTag(() => {
        this.isInside = false;
        const cleanText = this.textBuffer.replace(/\s+/g, ' ').trim();

        if (cleanText.length > 15) {
          let finalUrl = this.baseUrl;
          if (this.currentHref) {
            try {
              finalUrl = new URL(this.currentHref, this.baseUrl).href;
            } catch (e) {
              // Mantém a baseUrl em caso de falha no parse do link
            }
          }

          this.resultsArray.push({
            title: cleanText,
            url: finalUrl,
            source: this.sourceName,
            score: this.weight
          });
        }
        this.textBuffer = "";
      });
    }
  }

  text(chunk: Text): void {
    if (this.isInside) {
      this.textBuffer += chunk.text;
    }
  }
}

// ==========================================
// FUNÇÃO DE EXTRAÇÃO POR SITE
// ==========================================
async function extractNewsFromSite(site: SiteConfig, allResultsArray: Headline[]): Promise<void> {
  console.log(`[INICIANDO] Buscando ${site.name} (${site.url})...`);

  try {
    const response = await fetch(site.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    if (!response.ok) {
      console.error(`[ERRO HTTP] Bloqueio ou falha em ${site.name}. Status HTTP: ${response.status}`);
      return;
    }

    console.log(`[SUCESSO] Lendo HTML de ${site.name}. Passando pelo HTMLRewriter...`);

    await new HTMLRewriter()
      .on("h1, h1 a", new HeadlineHandler(10, site.name, site.url, allResultsArray))
      .on("h2, h2 a, .destaque", new HeadlineHandler(5, site.name, site.url, allResultsArray))
      .on("h3, h3 a", new HeadlineHandler(2, site.name, site.url, allResultsArray))
      .transform(response)
      .arrayBuffer();

  } catch (error: any) {
    console.error(`[FALHA FATAL] O site ${site.name} não pôde ser acessado. Detalhe:`, error?.message || error);
  }
}

// ==========================================
// WORKER PRINCIPAL
// ==========================================
export default {
  // 1. ROTINA EM BACKGROUND (CRON TRIGGER)
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("[CRON] Iniciando rotina de extração de notícias...");

    const NEWS_SOURCES: SiteConfig[] = [
      { name: "G1", url: "https://g1.globo.com/" },
      { name: "UOL", url: "https://www.uol.com.br/" },
      { name: "Folha", url: "https://www.folha.uol.com.br/" },
      { name: "Estadão", url: "https://www.estadao.com.br/" },
      { name: "CNN Brasil", url: "https://www.cnnbrasil.com.br/" }
    ];

    const rawHeadlines: Headline[] = [];

    await Promise.all(NEWS_SOURCES.map(site => extractNewsFromSite(site, rawHeadlines)));

    console.log(`[EXTRAÇÃO CONCLUÍDA] Total bruto de manchetes lidas: ${rawHeadlines.length}`);

    if (rawHeadlines.length === 0) {
      console.warn("[AVISO] Nenhuma manchete foi capturada. Interrompendo processo.");
      return;
    }

    const uniqueLinks = new Set<string>();
    const cleanHeadlines: Headline[] = [];

    for (const item of rawHeadlines) {
      if (!item.url || item.url.includes("javascript:void") || item.url.endsWith("#")) continue;

      if (!uniqueLinks.has(item.url)) {
        uniqueLinks.add(item.url);
        cleanHeadlines.push(item);
      }
    }

    console.log(`[FILTRO] Manchetes únicas válidas: ${cleanHeadlines.length}`);

    cleanHeadlines.sort((a, b) => b.score - a.score);

    const topHeadlinesForAI = cleanHeadlines.slice(0, 60);
    const dataForAI = topHeadlinesForAI.map(h => ({ title: h.title, score: h.score }));

    console.log("[IA] Enviando para o Llama 3...");

    try {
      const aiResponse = (await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          {
            role: "system",
            content: `Você é um curador de notícias automático. 
Sua função é agrupar as manchetes que tratam do mesmo assunto.
Some os valores de "score" de cada grupo.
Retorne estritamente um JSON no formato:
[{ "cluster_title": "Título Resumido do Assunto", "total_score": 15, "original_titles": ["titulo original 1", "titulo 2"] }]`
          },
          {
            role: "user",
            content: JSON.stringify(dataForAI)
          }
        ]
      })) as { response?: string };

      if (!aiResponse.response) {
        throw new Error("Resposta inválida da API de IA.");
      }

      console.log("[IA] Resposta recebida. Salvando no banco de dados...");

      const jsonStr = aiResponse.response.replace(/```json/g, "").replace(/```/g, "").trim();
      const aiClusters: AIClusterRaw[] = JSON.parse(jsonStr);

      const finalRanking: FinalCluster[] = aiClusters.map(cluster => {
        const articlesInfo = cluster.original_titles
          .map(title => {
            const original = topHeadlinesForAI.find(h => h.title === title);
            return original ? { title: original.title, url: original.url, source: original.source } : null;
          })
          .filter((a): a is FinalArticle => a !== null);

        return {
          cluster_title: cluster.cluster_title,
          total_score: cluster.total_score,
          articles: articlesInfo
        };
      });

      await env.NEWS_KV.put("latest_ranking", JSON.stringify(finalRanking));

      console.log("[SUCESSO] Ranking final salvo no Cloudflare KV!");

    } catch (error: any) {
      console.error("[FALHA IA / KV] Erro durante o processamento da IA ou salvamento:", error?.message || error);
    }
  },

  // 2. ROTA WEB PARA VISITANTES (HACKER NEWS STYLE)
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }

    try {
      console.log("[WEB] Recebendo requisição de visitante...");

      const dataString = await env.NEWS_KV.get("latest_ranking");

      if (!dataString) {
        return new Response(
          "<html><body style='font-family: sans-serif; padding: 20px;'>Ainda processando as notícias. O Cron deve rodar em breve. Volte em alguns minutos!</body></html>",
          { headers: { "Content-Type": "text/html;charset=UTF-8" } }
        );
      }

      const ranking: FinalCluster[] = JSON.parse(dataString);

      const htmlContent = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agregador de Notícias</title>
    <style>
        body {
            font-family: Verdana, Geneva, sans-serif;
            background-color: #f6f6ef;
            color: #222222;
            margin: 0;
            padding: 0;
        }
        .container {
            max-width: 850px;
            margin: 0 auto;
            background-color: #f6f6ef;
        }
        .header {
            background-color: #ff6600;
            color: #000000;
            padding: 8px 10px;
            font-weight: bold;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .header-logo {
            border: 1px solid white;
            padding: 2px 5px;
            color: white;
            text-decoration: none;
        }
        .header-title {
            text-decoration: none;
            color: #000;
        }
        .news-list {
            padding: 15px 10px 30px 10px;
            list-style-type: none;
            margin: 0;
            counter-reset: hn-counter;
        }
        .news-item {
            margin-bottom: 12px;
            position: relative;
            padding-left: 25px;
        }
        .news-item::before {
            counter-increment: hn-counter;
            content: counter(hn-counter) ".";
            position: absolute;
            left: 0;
            top: 2px;
            color: #828282;
            font-size: 14px;
        }
        .cluster-title {
            font-size: 14px;
            color: #000;
            text-decoration: none;
            font-weight: normal;
        }
        .meta-data {
            font-size: 11px;
            color: #828282;
            margin-top: 3px;
        }
        .source-link {
            color: #828282;
            text-decoration: none;
        }
        .source-link:hover {
            text-decoration: underline;
        }
        .footer {
            border-top: 2px solid #ff6600;
            text-align: center;
            padding: 15px;
            font-size: 11px;
            color: #828282;
        }
    </style>
</head>
<body>
    <div class="container">
        <header class="header">
            <a href="/" class="header-logo">N</a>
            <a href="/" class="header-title">Top Notícias Agrupadas</a>
        </header>

        <ul class="news-list">
            ${ranking.map(cluster => `
                <li class="news-item">
                    <span class="cluster-title">${cluster.cluster_title}</span>
                    <div class="meta-data">
                        ${cluster.total_score} pontos de relevância | Fontes:
                        ${cluster.articles.map(article => `
                            <a href="${article.url}" class="source-link" target="_blank" rel="noopener noreferrer">
                                [${article.source}]
                            </a>
                        `).join(' ')}
                    </div>
                </li>
            `).join('')}
        </ul>

        <footer class="footer">
            Atualizado automaticamente de hora em hora pelo Cloudflare Workers AI.
        </footer>
    </div>
</body>
</html>`;

      return new Response(htmlContent, {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          "Cache-Control": "public, max-age=300"
        }
      });

    } catch (error) {
      console.error("[FALHA WEB] Erro ao renderizar a página:", error);
      return new Response("Ocorreu um erro interno ao carregar as notícias.", { status: 500 });
    }
  }
};