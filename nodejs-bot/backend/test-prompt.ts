import { promptService } from './src/services/promptService';

async function test() {
    console.log('--- TESTING PROMPT SERVICE ---');
    try {
        const prompt = await promptService.getSystemPrompt();
        console.log('PROMPT LENGTH:', prompt.length);
        console.log('PROMPT PREVIEW (first 200 chars):');
        console.log(prompt.substring(0, 200));
        console.log('\nPROMPT SEARCH FOR MENU_PRINCIPAL:');
        console.log(prompt.includes('MENU_PRINCIPAL') ? 'FOUND' : 'NOT FOUND');
        console.log('\n--- END TEST ---');
    } catch (err) {
        console.error('TEST FAILED:', err);
    }
}

test();
