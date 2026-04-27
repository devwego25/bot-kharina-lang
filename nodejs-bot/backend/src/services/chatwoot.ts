import axios from 'axios';
import FormData from 'form-data';
import { config } from '../config/env';

const SOFT_HANDOFF_ROUTE_REASONS = new Set([
    'reservation_manual_review',
    'unit_contact',
    'unit_contact_offer'
]);

const HARD_HANDOFF_ROUTE_REASONS = new Set([
    'lost_found',
    'human_handoff',
    'unit_problem',
    'public_admin_compras',
    'public_admin_financeiro',
    'public_admin_rh_employee',
    'public_admin_rh_candidate'
]);

export class ChatwootService {
    private baseUrl: string;
    private accountId: string;
    private inboxId: string;
    private headers: any;
    private client: any;

    constructor() {
        this.baseUrl = config.chatwoot.url?.replace(/\/$/, '') || '';
        this.accountId = config.chatwoot.accountId || '';
        this.inboxId = config.chatwoot.inboxId || '';
        this.headers = {
            'api_access_token': config.chatwoot.token,
            'Content-Type': 'application/json'
        };
        this.client = axios.create({
            timeout: 5000
        });
    }

    /**
     * Sincroniza uma mensagem com o Chatwoot.
     * Cuida da criação do contato e da conversa automaticamente.
     */
    async syncMessage(phone: string, name: string, content: string, type: 'incoming' | 'outgoing', attributes: any = {}, isPrivate: boolean = false) {
        if (!this.baseUrl || !this.headers.api_access_token) {
            console.warn('[Chatwoot] Service not configured. Skipping sync.');
            return null;
        }

        try {
            const contactId = await this.getOrCreateContact(phone, name);
            if (!contactId) return null;

            const conversationId = await this.getOrCreateConversation(contactId, phone);
            if (!conversationId) return null;

            return await this.sendMessage(conversationId, content, type, attributes, isPrivate);
        } catch (err: any) {
            console.error('[Chatwoot] Sync Error:', err.response?.data || err.message);
            return null;
        }
    }

    /**
     * Sincroniza uma mensagem com anexo (mídia) com o Chatwoot.
     */
    async syncMediaMessage(phone: string, name: string, mediaBuffer: Buffer, fileName: string, mimeType: string, type: 'incoming' | 'outgoing', attributes: any = {}) {
        if (!this.baseUrl || !this.headers.api_access_token) {
            console.warn('[Chatwoot] Service not configured. Skipping media sync.');
            return null;
        }

        try {
            const contactId = await this.getOrCreateContact(phone, name);
            if (!contactId) return null;

            const conversationId = await this.getOrCreateConversation(contactId, phone);
            if (!conversationId) return null;

            const form = new FormData();
            form.append('content', attributes.source === 'whatsapp' ? '[Anexo do WhatsApp]' : '');
            form.append('message_type', type);
            form.append('private', 'false');
            form.append('attachments[]', mediaBuffer, { filename: fileName, contentType: mimeType });
            
            const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`;
            const response = await axios.post(url, form, {
                headers: {
                    ...form.getHeaders(),
                    'api_access_token': this.headers.api_access_token
                }
            });
            return response.data;
        } catch (err: any) {
            console.error('[Chatwoot] Sync Media Error:', err.response?.data || err.message);
            return null;
        }
    }

    /**
     * Verifica se o bot deve responder ou se um humano assumiu.
     * Retorna true se o bot estiver ATIVO (nenhum humano assumiu).
     * Retorna false se um humano assumiu ou se houver erro (na dúvida, pausa o bot).
     */
    async checkBotActive(phone: string, signal?: AbortSignal): Promise<boolean> {
        if (!this.baseUrl || !this.headers.api_access_token) return true;

        try {
            // 1. Buscar contato
            const searchUrl = `${this.baseUrl}/api/v1/accounts/${this.accountId}/contacts/search?q=${phone}`;
            const searchResp = await this.client.get(searchUrl, { headers: this.headers, signal });
            const searchData = searchResp.data as any;
            const contact = searchData.payload?.[0];

            if (!contact) return true; // Novo contato, bot ativo

            // 2. Buscar conversas
            const convsUrl = `${this.baseUrl}/api/v1/accounts/${this.accountId}/contacts/${contact.id}/conversations`;
            const convsResp = await this.client.get(convsUrl, { headers: this.headers, signal });
            const convsData = convsResp.data as any;
            const conversations = convsData.payload;

            // Procurar conversa ativa (não resolvida)
            const activeConv = conversations.find((c: any) => c.status !== 'resolved');

            if (!activeConv) {
                console.log(`[Chatwoot] checkBotActive: No active conversation found for ${phone}`);
                return true;
            }

            console.log(`[Chatwoot] checkBotActive: Found conversation ${activeConv.id}. Status: ${activeConv.status}. Assignee: ${JSON.stringify(activeConv.meta?.assignee)}`);

            const hasAssignee = activeConv.meta?.assignee !== null && activeConv.meta?.assignee !== undefined;
            const teamId = activeConv.meta?.team?.id;
            const hasBlockingTeam = teamId !== null && teamId !== undefined && teamId !== 8;
            const routeReason =
                activeConv.custom_attributes?.route_reason
                || activeConv.additional_attributes?.route_reason
                || activeConv.meta?.custom_attributes?.route_reason
                || null;
            const isSoftAutomationRoute = routeReason ? SOFT_HANDOFF_ROUTE_REASONS.has(routeReason) : false;
            const isHardHandoffRoute = routeReason ? HARD_HANDOFF_ROUTE_REASONS.has(routeReason) : false;

            console.log(`[Chatwoot] checkBotActive details for ${activeConv.id}: hasAssignee=${hasAssignee}, teamId=${teamId}, hasBlockingTeam=${hasBlockingTeam}, routeReason=${routeReason}, softRoute=${isSoftAutomationRoute}, hardRoute=${isHardHandoffRoute}, assignee=${JSON.stringify(activeConv.meta?.assignee)}`);

            // Handoffs leves não devem travar o bot; handoffs fortes continuam bloqueando.
            const isHumanHandled = isSoftAutomationRoute
                ? false
                : isHardHandoffRoute || hasAssignee || hasBlockingTeam;

            if (isHumanHandled) {
                console.log(`[Chatwoot] Humano/Equipe detectado na conversa ${activeConv.id}. Bot silenciado.`);
                return false;
            }

            return true;
        } catch (err: any) {
            console.error('[Chatwoot] Error checking bot status:', err.message);
            return true; // Na dúvida, deixa o bot ativo para não deixar o cliente no vácuo
        }
    }

    async updateConversation(phone: string, updates: any) {
        try {
            // 1. Buscar contato e conversa (reusando lógica interna se possível, ou refazendo busca rápida)
            const contactId = await this.getOrCreateContact(phone, '');
            if (!contactId) return null;

            const conversationId = await this.getOrCreateConversation(contactId, phone);
            if (!conversationId) return null;

            // HANDLE ASSIGNMENTS (Team / Agent) - Must use dedicated endpoint
            if (updates.team_id || updates.assignee_id) {
                const assignUrl = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/assignments`;
                const assignPayload: any = {};
                if (updates.team_id) assignPayload.team_id = updates.team_id;
                if (updates.assignee_id) assignPayload.assignee_id = updates.assignee_id;

                await this.client.post(assignUrl, assignPayload, { headers: this.headers });
                console.log(`[Chatwoot] Conversation ${conversationId} assigned:`, assignPayload);

                // Remove from updates object to avoid redundant/failed PATCH
                delete updates.team_id;
                delete updates.assignee_id;
            }

            // HANDLE OTHER UPDATES (Status, Attributes) - Use PATCH
            // Only verify if there are keys remaining
            if (Object.keys(updates).length > 0) {
                const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}`;
                await this.client.patch(url, updates, { headers: this.headers });
                console.log(`[Chatwoot] Conversation ${conversationId} updated (status/meta):`, updates);
            }

            return conversationId;
        } catch (err: any) {
            console.error('[Chatwoot] Error updating conversation:', err.response?.data || err.message);
            return null;
        }
    }

    private async getOrCreateContact(phone: string, name: string) {
        try {
            // 1. Buscar contato pelo telefone
            const searchUrl = `${this.baseUrl}/api/v1/accounts/${this.accountId}/contacts/search?q=${phone}`;
            const searchResp = await this.client.get(searchUrl, { headers: this.headers });
            const searchData = searchResp.data as any;

            if (searchData.payload.length > 0) {
                return searchData.payload[0].id;
            }

            // 2. Criar se não existir
            console.log(`[Chatwoot] Creating contact for ${phone}...`);
            const createUrl = `${this.baseUrl}/api/v1/accounts/${this.accountId}/contacts`;
            const createResp = await this.client.post(createUrl, {
                inbox_id: this.inboxId,
                name: name || phone,
                phone_number: `+${phone.replace(/\+/g, '')}`, // Formatar com +
                custom_attributes: { whatsapp_id: phone }
            }, { headers: this.headers });
            const createData = createResp.data as any;
            // Chatwoot v3+ wrapper check
            const contactId = createData.payload?.contact?.id || createData.contact?.id || createData.id;

            if (!contactId) {
                console.error('[Chatwoot] Could not find contact ID in response:', JSON.stringify(createData));
            }

            return contactId;
        } catch (err: any) {
            console.error('[Chatwoot] Error in getOrCreateContact:', err.response?.data || err.message);
            return null;
        }
    }

    private async getOrCreateConversation(contactId: number, phone: string) {
        try {
            // 1. Buscar conversas abertas do contato
            const convsUrl = `${this.baseUrl}/api/v1/accounts/${this.accountId}/contacts/${contactId}/conversations`;
            const convsResp = await this.client.get(convsUrl, { headers: this.headers });
            const convsData = convsResp.data as any;

            const openConv = convsData.payload.find((c: any) => c.status !== 'resolved');
            if (openConv) {
                return openConv.id;
            }

            // 2. Criar nova conversa se não houver aberta
            const sourceId = phone.replace(/\D/g, '');
            console.log(`[Chatwoot] Creating conversation for contact ${contactId} with source_id: ${sourceId}`);
            const createUrl = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations`;
            const createResp = await this.client.post(createUrl, {
                source_id: sourceId, // Usar o número limpo (apenas dígitos)
                inbox_id: this.inboxId,
                contact_id: contactId,
                status: 'pending' // Criar como pendente para o bot continuar ativo
            }, { headers: this.headers });
            const createData = createResp.data as any;
            // Chatwoot v3+ wrapper check
            const conversationId = createData.payload?.id || createData.id;

            if (!conversationId) {
                console.error('[Chatwoot] Could not find conversation ID in response:', JSON.stringify(createData));
            }

            return conversationId;
        } catch (err: any) {
            console.error('[Chatwoot] Error in getOrCreateConversation:', err.response?.data || err.message);
            return null;
        }
    }

    private async sendMessage(conversationId: number, content: string, type: 'incoming' | 'outgoing', attributes: any = {}, isPrivate: boolean = false) {
        try {
            const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`;
            await this.client.post(url, {
                content: content,
                message_type: type,
                private: isPrivate,
                content_attributes: attributes
            }, { headers: this.headers });

            console.log(`[Chatwoot] Message synced (${type}${isPrivate ? ' PRIVATE' : ''}) to conversation ${conversationId}`);
        } catch (err: any) {
            console.error('[Chatwoot] Error sending message:', err.response?.data || err.message);
        }
    }
}

export const chatwootService = new ChatwootService();
