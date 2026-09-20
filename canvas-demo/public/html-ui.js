export function htmlNodes(html) {
  return [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('[data-node-id]')].map(n => ({id:n.dataset.nodeId, text:n.textContent, leaf:!n.children.length && n.tagName !== 'BR'}));
}
export function htmlPreview(component, choose, edit, anchor) {
  const frame = document.createElement('iframe');
  frame.title = `HTML component ${component.id}`;
  // Same-origin permits trusted parent event handlers. Scripts remain disabled;
  // no allow-scripts, forms, navigation, popups, or Electron bridge is granted.
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.className = 'html-preview';
  frame.onload = () => {
    const doc = frame.contentDocument;
    for (const node of doc.querySelectorAll('[data-node-id]')) {
      node.onclick = e => { e.stopPropagation(); choose(); anchor(node.dataset.nodeId); };
      node.ondblclick = e => {
        e.stopPropagation();
        if (!node.children.length && node.tagName !== 'BR') edit(component, node.dataset.nodeId);
      };
    }
  };
  frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'"><style>body{margin:0;font-family:system-ui;color:#202039}*{box-sizing:border-box}[data-node-id]:hover{outline:1px dashed #6366f1}</style>${component.html}`;
  return frame;
}
export function locateHTML(componentId, nodeId) {
  const card = [...document.querySelectorAll('[data-component-id]')].find(n => n.dataset.componentId === componentId);
  const root = card?.querySelector('iframe')?.contentDocument || card;
  const node = [...(root?.querySelectorAll('[data-node-id]') || [])].find(n => n.dataset.nodeId === nodeId);
  if (node) {
    node.scrollIntoView({block:'nearest'});
    node.style.outline = '3px solid #f59e0b';
    setTimeout(() => node.style.removeProperty('outline'), 1800);
  }
}
