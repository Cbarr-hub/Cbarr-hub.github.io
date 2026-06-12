// One line-oriented config get/set engine for the two dialects we edit:
//   cvar     — Source-engine console cvars:   `name "value"`   (game .cfg files)
//   shellVar — LinuxGSM shell assignments:    `name="value"`   (instance .cfg files)
// Pure string functions — no I/O. Replaces a matching line in place, else appends.

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function makeLineGetSet({ lineRe, parse, render }) {
  const get = (text, name) => {
    const m = text.match(lineRe(name));
    return m ? parse(m) : undefined;
  };
  const set = (text, name, value) => {
    const line = render(name, value);
    // Function replacer so a value with `$1`/`$&`/`` $` `` isn't a backreference.
    if (lineRe(name).test(text)) return text.replace(lineRe(name), () => line);
    return text.replace(/\n*$/, '') + `\n${line}\n`;
  };
  const setMany = (text, vars) => {
    let out = text;
    for (const [name, value] of Object.entries(vars)) out = set(out, name, value);
    return out;
  };
  return { get, set, setMany };
}

// Source cvar lines: the `name + whitespace-or-eol` rule means `map` won't match
// `mapcyclefile`. Value is the rest of the line, double quotes stripped;
// undefined if the line is absent, '' if present with no value.
const cvar = makeLineGetSet({
  lineRe: (name) => new RegExp(`^[ \\t]*${escapeRe(name)}([ \\t].*)?$`, 'm'),
  parse: (m) => {
    let v = (m[1] ?? '').trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v;
  },
  render: (name, value) => `${name} "${value}"`,
});

// Shell `name="value"` assignments (LinuxGSM instance configs are sourced shell
// scripts). Value is everything after `=`, double or single quotes stripped.
const shellVar = makeLineGetSet({
  lineRe: (name) => new RegExp(`^[ \\t]*${escapeRe(name)}=.*$`, 'm'),
  parse: (m) => {
    const eq = m[0].indexOf('=');
    let v = m[0].slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  },
  render: (name, value) => `${name}="${value}"`,
});

export const getCvar = cvar.get;
export const setCvar = cvar.set;
export const setCvars = cvar.setMany;
export const getVar = shellVar.get;
export const setVar = shellVar.set;
export const setVars = shellVar.setMany;
