// Helpers for reading/updating Source-engine console-config cvars in a .cfg
// file's text, e.g. lines like:
//     map "de_anubis"
//     game_alias "competitive"
//     host_workshop_map "3071005299"
//     host_workshop_collection
// Pure string functions — no I/O. (Distinct from cfgvars.js, which handles
// shell-style name="value" LinuxGSM configs.)

// Matches a cvar line: leading ws, the exact name, then ws+value or end-of-line.
// The `name + whitespace-or-eol` rule means `map` won't match `mapcyclefile`.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineRe = (name) => new RegExp(`^[ \\t]*${escapeRe(name)}([ \\t].*)?$`, 'm');

/** Read a cvar's value (surrounding quotes stripped). undefined if the cvar
 *  line is absent; '' if present with no value. */
export function getCvar(text, name) {
  const m = text.match(lineRe(name));
  if (!m) return undefined;
  let v = (m[1] ?? '').trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v;
}

/** Return text with `name` set to `value` (double-quoted). Replaces the line in
 *  place if present, else appends. */
export function setCvar(text, name, value) {
  const line = `${name} "${value}"`;
  // Function replacer so a value with `$1`/`$&`/`` $` `` isn't treated as a backreference.
  if (lineRe(name).test(text)) return text.replace(lineRe(name), () => line);
  return text.replace(/\n*$/, '') + `\n${line}\n`;
}

export function setCvars(text, cvars) {
  let out = text;
  for (const [name, value] of Object.entries(cvars)) out = setCvar(out, name, value);
  return out;
}
