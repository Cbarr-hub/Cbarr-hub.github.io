export function numberValue(value) {
  return Number(value ?? 0);
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatWholeDollars(value) {
  return `$${Math.round(numberValue(value)).toLocaleString('en-US')}`;
}

export function formatSignedDollars(value) {
  const amount = Math.abs(Math.round(numberValue(value))).toLocaleString('en-US');
  return `${numberValue(value) < 0 ? '-' : '+'}$${amount}`;
}

export function percent(value, total) {
  return total ? Math.round((value / total) * 100) : 0;
}
