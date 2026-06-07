// Shared formatting + coercion helpers for the gambling UI modules. Canonical
// home for the dollar/number/HTML-escape primitives — import these instead of
// redefining local copies (formatWholeDollars is the one-true money formatter).

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
