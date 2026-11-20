// Genera un .xlsx di prova con export.js — poi verificato con openpyxl (python)
import { toXLSX, toCSV } from '../app/js/export.js';
import { writeFileSync } from 'node:fs';
const rows = [['t (s)', 'x (m)', 'valido'], [0, 0.25, true], [0.05, 0.2512, true], [0.1, NaN, false]];
const blob = toXLSX([{ name: 'Dati', rows }, { name: 'Info', rows: [['Esperimento', 'Moto'], ['a (m/s²)', '(0,45 ± 0,01)']] }]);
writeFileSync('/tmp/mosaicus_test.xlsx', Buffer.from(await blob.arrayBuffer()));
console.log(toCSV(rows[0], rows.slice(1)).slice(0, 80));
