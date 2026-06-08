// Tiny helpers for reading/updating shell-style `name="value"` assignments in a
// config file's text (LinuxGSM instance configs are sourced shell scripts).
// Pure string functions — easy to unit-test, no I/O.

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineRe = (name) => new RegExp(`^[ \\t]*${escapeRe(name)}=.*$`, 'm');

/** Read a var's value (quotes stripped). Returns undefined if absent. */
export function getVar(text, name) {
  const m = text.match(lineRe(name));
  if (!m) return undefined;
  const eq = m[0].indexOf('=');
  let v = m[0].slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

/**
 * Return a copy of `text` with `name` set to `value` (double-quoted). Replaces
 * the existing assignment in place if present, otherwise appends a new line.
 */
export function setVar(text, name, value) {
  const line = `${name}="${value}"`;
  if (lineRe(name).test(text)) {
    // Function replacer so a value containing `$1`/`$&`/`` $` `` isn't interpreted
    // as a replacement backreference (e.g. a password like `p$1ss`).
    return text.replace(lineRe(name), () => line);
  }
  return text.replace(/\n*$/, '') + `\n${line}\n`;
}

/** Apply several {name: value} assignments in one pass. */
export function setVars(text, vars) {
  let out = text;
  for (const [name, value] of Object.entries(vars)) out = setVar(out, name, value);
  return out;
}
