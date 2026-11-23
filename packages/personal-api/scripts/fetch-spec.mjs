// Fetch Garmin's Personal API OpenAPI spec and save it as JSON.
//
//   node packages/personal-api/scripts/fetch-spec.mjs
//
// Garmin publishes the spec only inside the Swagger page's JavaScript bundle, as one
// single-quoted string literal. This finds that bundle from the page's HTML, cuts the
// literal out and decodes it by hand. It never evaluates Garmin's JavaScript.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://developer.garmin.com';
const PAGE = `${ORIGIN}/gc-developer-program/personal/swagger-docs/`;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec', 'personal-api.v1.json');

const html = await (await fetch(PAGE)).text();
const chunk = html.match(/component---src-pages-gc-developer-program-personal-swagger-docs-js-[a-f0-9]+\.js/)?.[0];
if (!chunk) throw new Error('Could not find the Swagger bundle in the page HTML; the page layout changed.');
const js = await (await fetch(`${ORIGIN}/${chunk}`)).text();

// Find the literal: it starts at '{"openapi' right after an opening quote.
const start = js.indexOf('{"openapi');
if (start < 1) throw new Error('No OpenAPI document found in the bundle.');
const quote = js[start - 1];
if (quote !== "'" && quote !== '"' && quote !== '`') throw new Error(`Unexpected character before the spec: ${quote}`);

// Decode until the matching unescaped quote.
let out = '';
let i = start;
for (; i < js.length; i++) {
  const c = js[i];
  if (c === quote) break;
  if (c !== '\\') { out += c; continue; }
  const n = js[++i];
  switch (n) {
    case 'n': out += '\n'; break;
    case 'r': out += '\r'; break;
    case 't': out += '\t'; break;
    case 'b': out += '\b'; break;
    case 'f': out += '\f'; break;
    case 'v': out += '\v'; break;
    case '0': out += '\0'; break;
    case 'x': out += String.fromCharCode(parseInt(js.slice(i + 1, i + 3), 16)); i += 2; break;
    case 'u':
      if (js[i + 1] === '{') { const end = js.indexOf('}', i); out += String.fromCodePoint(parseInt(js.slice(i + 2, end), 16)); i = end; }
      else { out += String.fromCharCode(parseInt(js.slice(i + 1, i + 5), 16)); i += 4; }
      break;
    case '\r': if (js[i + 1] === '\n') i++; break; // line continuation
    case '\n': break;
    default: out += n; // \' \" \\ \/ and any other escaped character
  }
}
if (i >= js.length) throw new Error('Unterminated spec string.');

const spec = JSON.parse(out);
if (!spec.openapi || !spec.paths) throw new Error('Decoded text is not an OpenAPI document.');
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(spec, null, 2) + '\n');
console.log(`Saved ${spec.info?.title} ${spec.info?.version} (OpenAPI ${spec.openapi}): ` +
  `${Object.keys(spec.paths).length} paths, ${Object.keys(spec.components?.schemas ?? {}).length} schemas -> ${OUT}`);
console.log(`Source: ${ORIGIN}/${chunk}`);
