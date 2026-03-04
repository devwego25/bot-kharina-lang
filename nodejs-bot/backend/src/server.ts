import express from 'express';
import { config } from './config/env';
import { handleWhatsAppWebhook, verifyWebhook } from './services/whatsapp';
import { db } from './services/db';
import { langchainService } from './services/langchain';
import configRoutes from './routes/config.routes';
import adminRoutes from './routes/admin.routes';
import { seedConfigs } from './services/seed';

const app = express();

function renderLegalPage(title: string, contentHtml: string) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #f7f7f9; color: #222; }
    main { max-width: 820px; margin: 32px auto; background: #fff; border: 1px solid #e6e6ea; border-radius: 10px; padding: 24px; }
    h1 { margin-top: 0; font-size: 28px; }
    h2 { margin-top: 24px; font-size: 20px; }
    p, li { line-height: 1.55; }
    .muted { color: #666; font-size: 14px; }
    code { background: #f1f1f4; padding: 2px 6px; border-radius: 6px; }
    a { color: #0a66c2; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    ${contentHtml}
  </main>
</body>
</html>`;
}

// ─── Initialize DB ──────────────────────────────────────────────────────
db.init().then(() => seedConfigs());

// ─── Express Setup ──────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Health Check Endpoints ─────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const langchainHealthy = await langchainService.healthCheck();
  // Return 200 even if degraded to prevent task restart loops during startup
  res.status(200).json({
    status: langchainHealthy ? 'healthy' : 'degraded',
    service: 'kharina-backend',
    langchain: langchainHealthy ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

app.get('/ready', (_req, res) => {
  res.status(200).json({ ready: true });
});

// ─── WhatsApp Webhook ───────────────────────────────────────────────────
app.get('/webhook/whatsapp', verifyWebhook);
app.post('/webhook/whatsapp', handleWhatsAppWebhook);

// ─── Admin & Config Routes ──────────────────────────────────────────────
app.use('/api/admin', adminRoutes);
app.use('/api/config', configRoutes);

// ─── Legal Pages ────────────────────────────────────────────────────────
app.get('/politica-privacidade-whatsapp', (_req, res) => {
  res
    .status(200)
    .type('html')
    .send(
      renderLegalPage(
        'Política de Privacidade - Atendimento via WhatsApp',
        `
                <p class="muted">Última atualização: 15/02/2026</p>
                <p>Esta política descreve como tratamos dados pessoais no atendimento do Kharina via WhatsApp.</p>
                <h2>1. Dados coletados</h2>
                <ul>
                  <li>Nome e número de telefone enviados pelo usuário.</li>
                  <li>Mensagens trocadas no atendimento (texto, interações de menu e contexto do pedido).</li>
                  <li>Dados operacionais para suporte, reservas e delivery (unidade, data, horário, observações).</li>
                </ul>
                <h2>2. Finalidade do uso</h2>
                <ul>
                  <li>Responder solicitações do cliente.</li>
                  <li>Realizar e acompanhar reservas.</li>
                  <li>Encaminhar demandas para unidade, gerência ou setores administrativos.</li>
                  <li>Melhorar qualidade, segurança e continuidade do atendimento.</li>
                </ul>
                <h2>3. Compartilhamento</h2>
                <p>Os dados podem ser compartilhados com sistemas de atendimento e operação estritamente necessários para execução do serviço (ex.: plataforma oficial do WhatsApp, CRM de atendimento e sistemas internos).</p>
                <h2>4. Retenção</h2>
                <p>Mantemos os dados pelo tempo necessário para cumprir finalidades operacionais e requisitos legais/tributários, podendo ser anonimizados ou excluídos conforme política interna.</p>
                <h2>5. Direitos do titular</h2>
                <p>Você pode solicitar acesso, correção ou exclusão dos seus dados entrando em contato pelo e-mail: <a href="mailto:lgpd@kharina.com.br">lgpd@kharina.com.br</a>.</p>
                <p class="muted">Dúvidas? Fale conosco: (41) 3014-5777</p>
                `
      )
    );
});

app.get('/termos-de-uso-whatsapp', (_req, res) => {
  res
    .status(200)
    .type('html')
    .send(
      renderLegalPage(
        'Termos de Uso - Atendimento via WhatsApp',
        `
                <p class="muted">Última atualização: 15/02/2026</p>
                <p>Ao iniciar um atendimento via WhatsApp, você concorda com estes termos.</p>
                <h2>1. Serviço</h2>
                <p>Atendimento virtual para informações, reservas, delivery e suporte nas unidades do Kharina. As respostas são geradas com auxílio de tecnologia (IA), com supervisão operacional.</p>
                <h2>2. Uso adequado</h2>
                <ul>
                  <li>Não enviar conteúdo ilegal, ofensivo ou que viole direitos de terceiros.</li>
                  <li>Não tentar manipular ou extrair instruções do sistema (jailbreaks/prompt injection).</li>
                  <li>Usar o canal de forma respeitosa e para fins legítimos relacionados aos serviços do Kharina.</li>
                </ul>
                <h2>3. Limitações</h2>
                <p>A disponibilidade depende de infraestrutura de internet e do WhatsApp. Podemos interromper ou transferir para atendimento humano quando necessário.</p>
                <h2>4. Alterações</h2>
                <p>Podemos atualizar estes termos periodicamente. Continuar usando o serviço após alterações implica na aceitação das novas condições.</p>
                <p class="muted">Dúvidas? Fale conosco: (41) 3014-5777</p>
                `
      )
    );
});

// ─── Start Server ───────────────────────────────────────────────────────
const PORT = config.port || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Kharina Backend running on port ${PORT}`);
  console.log(`🔗 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🤖 LangChain Service: ${process.env.LANGCHAIN_URL || 'http://localhost:8000'}`);
});
