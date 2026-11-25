/**
 * Escapes a single CSV cell per RFC 4180 and neutralizes spreadsheet formula injection
 * (cells starting with =, +, -, @, tab, or carriage return).
 */
export function escapeCsvCell(value: unknown): string {
  let raw = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(raw)) {
    raw = `'${raw}`;
  }
  const escaped = raw.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Generates and downloads a UTF-8 CSV file safely using Blob + ObjectURL.
 */
export function downloadSafeCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<unknown>>
): void {
  const headerLine = headers.map(escapeCsvCell).join(',');
  const dataLines = rows.map(row => row.map(escapeCsvCell).join(','));
  const csvContent = [headerLine, ...dataLines].join('\r\n');
  const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
