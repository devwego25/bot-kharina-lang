
import { db } from './src/services/db';

async function updateKidsInfo() {
    const newVal = `Aqui estão os horários e valores do nosso Espaço Kids — os pequenos AMAM brincar por aqui! 😄

1️⃣ *Kharina Cabral — R$ 23,00*
* Segunda a Quinta: 18h às 22h
* Sexta: 18h às 23h
* Sábado: 12h às 23h
* Domingo: 12h30 às 21h30

2️⃣ *Kharina Batel — R$ 23,00*
* Segunda a Quinta: 18h às 22h
* Sexta: 18h às 23h
* Sábado: 12h às 23h
* Domingo: 12h30 às 21h30

3️⃣ *Kharina Água Verde — R$ 10,00*
* Sexta: 18h às 22h
* Sábado: 12h às 22h
* Domingo: 12h30 às 21h30

4️⃣ *Kharina Botânico — R$ 23,00*
* Segunda a Quinta: 18h às 22h
* Sexta: 18h às 23h
* Sábado: 12h às 23h
* Domingo: 12h às 22h

5️⃣ *Kharina Portão — R$ 23,00*
* Segunda a Quinta: 18h às 22h
* Sexta: 18h às 23h
* Sábado: 12h às 23h
* Domingo: 12h às 22h

6️⃣ *Kharina Londrina (Higienópolis) — R$ 15,00*
* Segunda a Quinta: 18h às 22h
* Sexta: 18h às 23h
* Sábado: 12h às 23h
* Domingo: 12h às 22h`;

    console.log('Updating kids_info_content...');
    await db.upsertConfig('kids_info_content', newVal);
    console.log('Done!');
    process.exit(0);
}

updateKidsInfo().catch(err => {
    console.error(err);
    process.exit(1);
});
