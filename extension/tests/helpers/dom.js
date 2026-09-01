/**
 * Just enough DOM for `el()` and the painters to run under Node.
 *
 * Not a browser. There is no layout, no CSS, no event propagation and no
 * selector engine — a handler is stored under its type and called directly.
 * What it buys is that grid arithmetic can be *run* rather than checked by
 * reading the source for the right-looking regular expression, which is what
 * every UI test in this suite had to do until now. An off-by-one in an append
 * draws a duplicate row or skips a photo, and no amount of source matching
 * sees that.
 *
 * Install it before importing anything that touches `document`.
 */

export class Node {
  constructor(tag) {
    this.tagName = tag;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.handlers = {};
    this.className = '';
  }

  /** Concatenated text of the subtree, replaced wholesale when assigned. */
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = value === '' ? [] : [new Text(String(value))];
    if (this.childNodes[0]) this.childNodes[0].parentNode = this;
  }

  append(...nodes) {
    for (const n of nodes) {
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }

  /** Insert before this node, among its parent's children. */
  before(...nodes) {
    const parent = this.parentNode;
    if (!parent) throw new Error('before() on a node with no parent');
    const at = parent.childNodes.indexOf(this);
    for (const n of nodes) n.parentNode = parent;
    parent.childNodes.splice(at, 0, ...nodes);
  }

  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }

  addEventListener(type, fn) { this.handlers[type] = fn; }

  /** Call a handler directly. No bubbling, because nothing here needs it. */
  fire(type, event = {}) { return this.handlers[type]?.(event); }

  /** Every node in the subtree whose className contains `cls`. */
  findAll(cls, out = []) {
    for (const c of this.childNodes) {
      if (typeof c.className === 'string' && c.className.split(/\s+/).includes(cls)) out.push(c);
      c.findAll?.(cls, out);
    }
    return out;
  }
}

export class Text extends Node {
  constructor(value) {
    super('#text');
    this.value = String(value);
  }
  get textContent() { return this.value; }
  set textContent(v) { this.value = String(v); }
}

/** Put `document` and `Node` where the panel expects to find them. */
export function installDom() {
  globalThis.Node = Node;
  globalThis.document = {
    createElement: (tag) => new Node(tag),
    createTextNode: (v) => new Text(v)
  };
}
