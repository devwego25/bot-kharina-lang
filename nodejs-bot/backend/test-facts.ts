import { extractReservationFacts } from './src/services/whatsapp';
console.log(extractReservationFacts("3 pessoas e 1 criança"));
console.log(extractReservationFacts("1 criança"));
console.log(extractReservationFacts("3 adultos e 1 criança"));
console.log(extractReservationFacts("1 adulto"));
