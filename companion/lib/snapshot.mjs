// These functions execute in a CDP-created isolated world. Their source is fixed here;
// request data is passed only through JSON serialization, never as executable source.
function snapshotPage(config) {
  const maxChars = config.maxChars;
  const maxElements = config.maxElements;
  const snapshotId = config.snapshotId;
  const refs = new Map();
  const elements = [];
  const textParts = [];
  let textLength = 0;
  let textTruncated = false;
  let elementsTruncated = false;
  let scanned = 0;
  const scanLimit = 100000;

  const clean = (value, limit = 300) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const intersect = (a, b) => {
    const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
    return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
  };
  const composedParent = (element) => element.parentElement || element.getRootNode?.().host || null;
  const visibleRect = (element, rawRect) => {
    let clipped = intersect(rawRect, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    if (!clipped) return null;
    for (let current = element; current instanceof Element; current = composedParent(current)) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
          style.contentVisibility === "hidden" || Number(style.opacity) === 0) return null;
      if (current !== element) {
        const overflowX = style.overflowX || style.overflow;
        const overflowY = style.overflowY || style.overflow;
        if (["hidden", "clip", "scroll", "auto"].includes(overflowX) || ["hidden", "clip", "scroll", "auto"].includes(overflowY)) {
          const bounds = current.getBoundingClientRect();
          const clip = {
            left: ["hidden", "clip", "scroll", "auto"].includes(overflowX) ? bounds.left : -Infinity,
            right: ["hidden", "clip", "scroll", "auto"].includes(overflowX) ? bounds.right : Infinity,
            top: ["hidden", "clip", "scroll", "auto"].includes(overflowY) ? bounds.top : -Infinity,
            bottom: ["hidden", "clip", "scroll", "auto"].includes(overflowY) ? bounds.bottom : Infinity
          };
          clipped = intersect(clipped, clip);
          if (!clipped) return null;
        }
      }
    }
    return clipped;
  };
  const visibleElement = (element) => element instanceof Element &&
    Array.from(element.getClientRects()).some((rect) => visibleRect(element, rect));
  const addText = (raw) => {
    if (textTruncated) return;
    const value = clean(raw, 2000);
    if (!value) return;
    const separator = textParts.length ? "\n" : "";
    const remaining = maxChars - textLength - separator.length;
    if (remaining <= 0) { textTruncated = true; return; }
    if (value.length > remaining) {
      textParts.push(separator + value.slice(0, remaining));
      textLength = maxChars;
      textTruncated = true;
    } else {
      textParts.push(separator + value);
      textLength += separator.length + value.length;
    }
  };
  const textVisible = (node) => {
    if (!node.parentElement || !clean(node.nodeValue)) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    return Array.from(range.getClientRects()).some((rect) => visibleRect(node.parentElement, rect));
  };
  const isActionable = (element) => {
    const tag = element.localName;
    if (["a", "button", "input", "select", "textarea", "summary"].includes(tag)) return true;
    if (element.isContentEditable) return true;
    if (element.hasAttribute("role") || element.hasAttribute("tabindex")) return true;
    return typeof element.onclick === "function";
  };
  const accessibleName = (element) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelled = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
      if (clean(labelled)) return clean(labelled, 300);
    }
    const aria = element.getAttribute("aria-label");
    if (aria) return clean(aria, 300);
    if (element.labels?.length) return clean(Array.from(element.labels).map((label) => label.textContent).join(" "), 300);
    return clean(element.alt || element.title || element.placeholder || element.innerText, 300);
  };
  const addElement = (element) => {
    if (!isActionable(element) || !visibleElement(element)) return;
    if (elements.length >= maxElements) { elementsTruncated = true; return; }
    const ref = `${snapshotId}.e${elements.length + 1}`;
    refs.set(ref, element);
    const rect = element.getBoundingClientRect();
    const item = {
      ref,
      tag: element.localName,
      role: clean(element.getAttribute("role"), 80) || undefined,
      name: accessibleName(element) || undefined,
      disabled: Boolean(element.disabled) || undefined,
      box: {
        x: Math.round(rect.x * 10) / 10,
        y: Math.round(rect.y * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10
      }
    };
    if (element instanceof HTMLInputElement) {
      item.type = clean(element.type, 40);
      if (element.type !== "password" && element.type !== "file") item.value = clean(element.value, 500) || undefined;
      if (["checkbox", "radio"].includes(element.type)) item.checked = element.checked;
    } else if (element instanceof HTMLTextAreaElement) {
      item.value = clean(element.value, 500) || undefined;
    } else if (element instanceof HTMLSelectElement) {
      item.values = [];
      for (const option of element.options) {
        if (!option.selected) continue;
        if (item.values.length >= 100) { item.valuesTruncated = true; break; }
        item.values.push(String(option.value).slice(0, 1000));
      }
    }
    for (const key of Object.keys(item)) if (item[key] === undefined) delete item[key];
    elements.push(item);
  };

  const stack = Array.from(document.childNodes || []).reverse();
  while (stack.length) {
    const node = stack.pop();
    if (++scanned > scanLimit) { textTruncated = true; elementsTruncated = true; break; }
    if (node.nodeType === Node.TEXT_NODE) {
      if (textVisible(node)) addText(node.nodeValue);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const element = node;
    if (["script", "style", "noscript", "template"].includes(element.localName)) continue;
    addElement(element);
    const children = Array.from(element.childNodes || []);
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
    if (element.shadowRoot) {
      const shadowChildren = Array.from(element.shadowRoot.childNodes || []);
      for (let index = shadowChildren.length - 1; index >= 0; index--) stack.push(shadowChildren[index]);
    }
  }
  globalThis.__PI_ARC_SNAPSHOT_REFS__ = { snapshotId, refs, createdAt: Date.now() };
  let content = textParts.join("");
  if (textTruncated) content += `${content ? "\n" : ""}… [text truncated]`;
  return {
    snapshotId,
    url: String(location.href).slice(0, 8192),
    title: clean(document.title, 1000),
    viewport: {
      width: innerWidth,
      height: innerHeight,
      deviceScaleFactor: devicePixelRatio,
      scrollX,
      scrollY
    },
    content,
    elements,
    truncated: { text: textTruncated, elements: elementsTruncated },
    elementMarker: elementsTruncated ? `… [elements truncated at ${maxElements}]` : null,
    notes: ["Top document and its open shadow roots only; iframe DOM is not included. Coordinate actions can target visible iframe content."]
  };
}

function inspectActiveElement() {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (element?.localName === "iframe") {
    return { forbidden: true, type: "iframe", reason: "Cannot type into a focused iframe because password/file focus cannot be verified" };
  }
  const forbidden = element instanceof HTMLInputElement && ["password", "file"].includes(element.type);
  return {
    forbidden,
    type: element instanceof HTMLInputElement ? element.type : "",
    reason: forbidden ? `${element.type} inputs must be filled manually` : ""
  };
}

function resolveSnapshotRef(config) {
  const store = globalThis.__PI_ARC_SNAPSHOT_REFS__;
  if (!store || store.snapshotId !== config.snapshotId) throw new Error("stale snapshot reference");
  const element = store.refs.get(config.ref);
  if (!element || !element.isConnected || element.ownerDocument !== document) throw new Error("stale or disconnected snapshot reference");
  const rect = element.getBoundingClientRect();
  const composedParent = (node) => node.parentElement || node.getRootNode?.().host || null;
  for (let current = element; current instanceof Element; current = composedParent(current)) {
    const currentStyle = getComputedStyle(current);
    if (currentStyle.display === "none" || currentStyle.visibility === "hidden" || currentStyle.visibility === "collapse" ||
        currentStyle.contentVisibility === "hidden" || Number(currentStyle.opacity) === 0) {
      throw new Error("referenced element is not visible");
    }
  }
  const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
  if (right <= left || bottom <= top) throw new Error("referenced element is outside the visible viewport");
  const x = left + (right - left) / 2;
  const y = top + (bottom - top) / 2;
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot?.elementFromPoint) {
    const deeper = hit.shadowRoot.elementFromPoint(x, y);
    if (!deeper || deeper === hit) break;
    hit = deeper;
  }
  const composedWithin = (node, ancestor) => {
    for (let current = node; current; current = current.parentElement || current.getRootNode?.().host || null) {
      if (current === ancestor) return true;
    }
    return false;
  };
  if (!hit || !composedWithin(hit, element)) throw new Error("referenced element is obscured at its visible center");
  const result = { x, y, platform: navigator.platform || "" };
  if (config.purpose === "fill" || config.purpose === "focused") {
    const isInput = element instanceof HTMLInputElement;
    const isTextArea = element instanceof HTMLTextAreaElement;
    const editable = element.isContentEditable;
    if (isInput && ["password", "file"].includes(element.type)) throw new Error(`${element.type} inputs must be filled manually`);
    const disallowedInput = isInput && !["text", "search", "email", "url", "tel", "number"].includes(element.type);
    if ((!isInput && !isTextArea && !editable) || disallowedInput || element.disabled || element.readOnly) {
      throw new Error("referenced element is not editable");
    }
    if (config.purpose === "focused") {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      if (active !== element && !(editable && composedWithin(active, element))) {
        throw new Error("referenced element did not receive focus; fill was cancelled");
      }
    }
  }
  if (config.purpose === "select") {
    if (!(element instanceof HTMLSelectElement) || element.disabled) throw new Error("referenced element is not an enabled select");
    const wanted = new Set(config.values);
    const available = new Set(Array.from(element.options).map((option) => option.value));
    for (const value of wanted) if (!available.has(value)) throw new Error(`select option not found: ${value}`);
    if (!element.multiple && wanted.size > 1) throw new Error("cannot choose multiple values in a single-select element");
    for (const option of element.options) option.selected = wanted.has(option.value);
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    result.values = Array.from(element.selectedOptions).map((option) => option.value);
  }
  return result;
}

export function createSnapshotId(random = crypto.getRandomValues(new Uint8Array(16))) {
  return `pi-${Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function createSnapshotExpression(config) {
  return `(${snapshotPage.toString()})(${JSON.stringify(config)})`;
}

export function createResolveRefExpression(config) {
  return `(${resolveSnapshotRef.toString()})(${JSON.stringify(config)})`;
}

export function createInspectActiveExpression() {
  return `(${inspectActiveElement.toString()})()`;
}

export function snapshotResult(value) {
  if (!value || typeof value !== "object" || typeof value.snapshotId !== "string" ||
      !Array.isArray(value.elements) || typeof value.content !== "string") {
    throw new Error("page returned an invalid snapshot result");
  }
  return value;
}
