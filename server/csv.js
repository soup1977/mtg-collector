// Archidekt collection CSV helpers, shared by backups and the Changes export.
export const ARCHIDEKT_HEADER =
  'Quantity,Name,Finish,Condition,Date Added,Language,Purchase Price,Tags,Edition Name,Edition Code,Multiverse Id,Scryfall ID,Collector Number';

export const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const csvRow = (cells) => cells.map(csvCell).join(',');
