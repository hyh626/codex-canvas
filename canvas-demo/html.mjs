import { parseFragment } from 'parse5';
const tags = new Set('article section div header footer main h1 h2 h3 h4 p span strong em small ul ol li br'.split(' '));
const properties = new Set('display flex-direction flex-wrap align-items justify-content gap padding margin background background-color color border border-radius font-size font-weight line-height text-align width max-width min-height grid-template-columns'.split(' '));
export const sampleHTML = `<article data-node-id="root" style="display:flex;flex-direction:column;gap:16px;padding:24px;background:#eef2ff;border-radius:16px">
  <header data-node-id="heading"><small data-node-id="eyebrow">SHARED CANVAS</small><h2 data-node-id="title">A real HTML component</h2></header>
  <section data-node-id="content"><p data-node-id="body">Edit this text, then ask the agent to change the layout.</p><ul data-node-id="features"><li data-node-id="feature-one">Stable comment anchors</li><li data-node-id="feature-two">Undo the whole transaction</li></ul></section>
</article>`;
export const escapeHTML = text => text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Restricted static HTML, parsed with the HTML5 parser. Source offsets preserve
// every byte outside the target span; HTML is authoritative, not a card projection.
export function inspectHTML(html) {
  if (typeof html !== 'string' || html.length > 12000) throw Error('HTML must be a string of at most 12000 characters');
  const errors = [];
  const tree = parseFragment(html, { sourceCodeLocationInfo: true, onParseError: e => errors.push(e) });
  if (errors.length) throw Error('Malformed HTML');
  const nodes = new Map();
  function visit(node) {
    if (node.nodeName === '#text') return;
    if (node.nodeName === '#document-fragment') return node.childNodes.forEach(visit);
    if (!tags.has(node.tagName) || !node.sourceCodeLocation?.startTag) throw Error('Unsupported HTML element');
    for (const a of node.attrs) {
      if (!['data-node-id','style'].includes(a.name)) throw Error('Unsupported HTML attribute');
      if (a.name === 'style') for (const declaration of a.value.split(';').filter(x => x.trim())) {
        const match = declaration.trim().match(/^([a-z-]+)\s*:\s*([a-zA-Z0-9#.,% ()-]+)$/);
        if (!match || !properties.has(match[1]) || /url|expression|var\s*\(/i.test(match[2])) throw Error('Unsupported CSS declaration');
      }
    }
    const id = node.attrs.find(a => a.name === 'data-node-id')?.value;
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(id || '') || nodes.has(id)) throw Error('Each HTML element needs a unique stable data-node-id');
    if (node.tagName !== 'br' && !node.sourceCodeLocation.endTag) throw Error('Explicit closing tags required');
    nodes.set(id, node);
    node.childNodes.forEach(visit);
  }
  visit(tree);
  if (!nodes.has('root') || tree.childNodes.filter(n => n.tagName).length !== 1 || nodes.get('root').parentNode !== tree) throw Error('One root element with data-node-id="root" required');
  if (nodes.size > 100) throw Error('At most 100 HTML nodes');
  return nodes;
}
export function textNodes(html) {
  return [...inspectHTML(html)].filter(([,n]) => n.tagName !== 'br' && n.childNodes.every(c => c.nodeName === '#text')).map(([id,n]) => ({id, text:n.childNodes.map(c => c.value).join('')}));
}
export function setHTMLText(html, nodeId, text) {
  if (typeof text !== 'string' || text.length > 2000) throw Error('Invalid node text');
  const node = inspectHTML(html).get(nodeId);
  if (!node || node.tagName === 'br' || !node.childNodes.every(n => n.nodeName === '#text')) throw Error('Only leaf text nodes are editable');
  const loc = node.sourceCodeLocation;
  const result = html.slice(0, loc.startTag.endOffset) + escapeHTML(text) + html.slice(loc.endTag.startOffset);
  inspectHTML(result);
  return result;
}
export function mockLayout(html) {
  const root = inspectHTML(html).get('root');
  const loc = root.sourceCodeLocation;
  const style = root.attrs.find(a => a.name === 'style')?.value || '';
  const next = style.replace(/(?:^|;)\s*flex-direction\s*:[^;]*/g, '') + ';display:flex;flex-direction:row;gap:24px';
  const attr = loc.attrs?.style;
  const result = attr ? html.slice(0, attr.startOffset) + `style="${escapeHTML(next)}"` + html.slice(attr.endOffset)
    : html.slice(0, loc.startTag.endOffset - 1) + ` style="${escapeHTML(next)}"` + html.slice(loc.startTag.endOffset - 1);
  inspectHTML(result);
  return result;
}
export function anchorExists(component, nodeId) {
  return component?.kind === 'html' ? inspectHTML(component.html).has(nodeId) : Boolean(component && ['title','body'].includes(nodeId));
}
