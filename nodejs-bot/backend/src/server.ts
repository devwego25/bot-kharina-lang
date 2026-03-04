import express from 'express';
import { config } from './config/env';
import { handleWhatsAppWebhook, verifyWebhook } from './services/whatsapp';
import { db } from './services/db';
import { connectMcpClients, getToolsForAgent, cardapioMcp, reservasMcp } from './agent/tools';
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

// ─── Connect MCP Clients ONCE ───────────────────────────────────────────
connectMcpClients();

// Pre-warm tool cache after giving clients time to connect
setTimeout(async () => {
    await getToolsForAgent();
    console.log('[Server] MCP Tools pre-warmed.');
}, 15000);

// ─── Periodic health check — reconnect dropped MCP clients ─────────────
setInterval(() => {
    if (!cardapioMcp.ready) {
        console.log('[Server] Cardapio MCP not ready, attempting reconnect...');
        cardapioMcp.connect();
    }
    if (!reservasMcp.ready) {
        console.log('[Server] Reservas MCP not ready, attempting reconnect...');
        reservasMcp.connect();
    }
}, 60000);

// ─── Periodic Keep-Alive Ping for n8n (Prevent Cold Starts) ─────────────
setInterval(() => {
    if (reservasMcp.ready) {
        // Ping the server to keep the n8n container/workflow warm
        reservasMcp.listTools().catch(e => console.warn('[KeepAlive] n8n Reservas ping failed:', e.message));
    }
}, 3 * 60 * 1000);

// ─── Express Setup ──────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

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
                <p>Os dados são mantidos pelo período necessário para atendimento, cumprimento de obrigações legais e prevenção a fraudes.</p>
                <h2>5. Direitos do titular</h2>
                <p>Você pode solicitar acesso, correção ou exclusão dos seus dados pelos canais indicados abaixo.</p>
                <h2>6. Contato para privacidade</h2>
                <p>E-mail: <a href="mailto:contato@kharina.com.br">contato@kharina.com.br</a></p>
                <p>Procedimento de exclusão: <a href="/exclusao-dados-whatsapp">/exclusao-dados-whatsapp</a></p>
                `
            )
        );
});

app.get('/termos-whatsapp', (_req, res) => {
    res
        .status(200)
        .type('html')
        .send(
            renderLegalPage(
                'Termos de Uso - Atendimento via WhatsApp',
                `
                <p class="muted">Última atualização: 15/02/2026</p>
                <p>Ao utilizar o atendimento do Kharina via WhatsApp, você concorda com estes termos.</p>
                <h2>1. Escopo do serviço</h2>
                <p>O canal é destinado a informações de cardápio, reservas, delivery, Espaço Kids e suporte relacionado às unidades.</p>
                <h2>2. Conduta do usuário</h2>
                <p>O usuário se compromete a fornecer informações verdadeiras e utilizar o canal de forma respeitosa e lícita.</p>
                <h2>3. Limitação</h2>
                <p>Podem ocorrer indisponibilidades temporárias por fatores técnicos, incluindo serviços de terceiros.</p>
                <h2>4. Alterações</h2>
                <p>Estes termos podem ser atualizados a qualquer momento, com publicação nesta página.</p>
                <h2>5. Contato</h2>
                <p>E-mail: <a href="mailto:contato@kharina.com.br">contato@kharina.com.br</a></p>
                `
            )
        );
});

app.get('/exclusao-dados-whatsapp', (_req, res) => {
    res
        .status(200)
        .type('html')
        .send(
            renderLegalPage(
                'Exclusão de Dados - Atendimento via WhatsApp',
                `
                <p class="muted">Última atualização: 15/02/2026</p>
                <p>Para solicitar exclusão de dados pessoais relacionados ao atendimento via WhatsApp:</p>
                <ol>
                  <li>Envie e-mail para <a href="mailto:contato@kharina.com.br">contato@kharina.com.br</a> com assunto <code>Exclusão de dados - WhatsApp</code>.</li>
                  <li>Informe o número de telefone usado no atendimento e, se possível, data aproximada da conversa.</li>
                  <li>Nossa equipe pode solicitar confirmação de titularidade para segurança.</li>
                </ol>
                <p>Após validação, a solicitação será processada conforme exigências legais aplicáveis.</p>
                `
            )
        );
});

// Meta Data Deletion Callback (fallback when "instructions URL" validation fails in dashboard UI).
app.post('/meta/data-deletion', (_req, res) => {
    const code = `kha-${Date.now()}`;
    res.status(200).json({
        url: `https://chatbot.kharina.com.br/meta/data-deletion-status/${code}`,
        confirmation_code: code
    });
});

app.get('/meta/data-deletion-status/:code', (req, res) => {
    const { code } = req.params;
    res
        .status(200)
        .type('html')
        .send(
            renderLegalPage(
                'Confirmação de Solicitação de Exclusão de Dados',
                `
                <p>Recebemos a solicitação de exclusão de dados do usuário via integração Meta.</p>
                <p>Código de confirmação: <code>${code}</code></p>
                <p>Para dúvidas, entre em contato: <a href="mailto:contato@kharina.com.br">contato@kharina.com.br</a></p>
                `
            )
        );
});

// Root endpoint (useful for uptime checks and quick manual domain validation)
app.get('/', (req, res) => {
    res.status(200).json({
        name: 'kharina-backend',
        status: 'ok',
        health: '/health'
    });
});

// Health Check
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        mcp: {
            cardapio: cardapioMcp.ready ? 'connected' : 'disconnected',
            reservas: reservasMcp.ready ? 'connected' : 'disconnected'
        }
    });
});

// WhatsApp Webhook Verification
app.get('/webhook/whatsapp', verifyWebhook);

// WhatsApp Webhook Event Handling
app.post('/webhook/whatsapp', handleWhatsAppWebhook);

import whatsappRoutes from './routes/whatsapp.routes';

// Configuration & Prompt API (for Dashboard)
app.use('/api', configRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/whatsapp', whatsappRoutes);

app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
});
