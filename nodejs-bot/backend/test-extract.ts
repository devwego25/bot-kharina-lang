import { extractReservationFacts } from './src/services/whatsapp';
console.log("TEST 1", extractReservationFacts("Guilherme Giorgi, para amanha, as 19h, 3 pessoas"));
console.log("TEST 2", extractReservationFacts("ja confirmei, Guilherme Giorgi"));
console.log("TEST 3", extractReservationFacts("sou o Guilherme Silva"));
console.log("TEST 4", extractReservationFacts("meu nome é João Pedro"));
console.log("TEST 5", extractReservationFacts("sim, Guilherme"));
