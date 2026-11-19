// Generates src/design/tokens.css from src/design/tokens.json (copied from the design system).
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../src/design/', import.meta.url);
const tokens = JSON.parse(readFileSync(new URL('tokens.json', dir), 'utf8'));
const themes = tokens.color.themes.map((t) => t.id);
const first = themes[0];

const valueFor = (value, theme) => (typeof value === 'string' ? value : (value[theme] ?? value[first]));
const resolve = (v) => v.replace(/^\{(.+)\}$/, 'var(--$1)');

const themed = [...tokens.color.tokens, ...(tokens.shadow?.tokens ?? [])];
const flat = ['spacing', 'radius'].flatMap((k) => tokens[k]?.tokens ?? []);

const block = (theme) => themed.map((t) => `  --${t.name}: ${resolve(valueFor(t.value, theme))};`).join('\n');

let css = `/* ${tokens.name} — generated from tokens.json by scripts/build-tokens.mjs */\n\n`;
css += `:root {\n${Object.entries(tokens.type.families).map(([k, v]) => `  --font-${k}: ${v};`).join('\n')}\n`;
css += `${flat.map((t) => `  --${t.name}: ${t.value};`).join('\n')}\n}\n\n`;
css += `:root,\n:root[data-theme="${first}"] {\n${block(first)}\n  color-scheme: ${first};\n}\n`;
for (const theme of themes.slice(1)) {
  css += `\n:root[data-theme="${theme}"] {\n${block(theme)}\n  color-scheme: ${theme};\n}\n`;
}
for (const group of tokens.type.groups) {
  for (const s of group.styles) {
    css += `\n.t-${s.name} {\n  font-family: var(--font-${group.family});\n  font-size: ${s.fontSize};\n  line-height: ${s.lineHeight};\n  font-weight: ${s.fontWeight};${s.letterSpacing ? `\n  letter-spacing: ${s.letterSpacing};` : ''}\n}\n`;
  }
}
writeFileSync(new URL('tokens.css', dir), css);
console.log('wrote src/design/tokens.css');
