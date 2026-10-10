// core/textwrap.ts
// 通用 TreeWalker 文本节点包裹器——划线/搜索共用。
//
// 用法：
//   wrapTextNodes(rootEl, (text, node) => ({
//     replace: `<mark>${esc(text)}</mark>`,
//   }));
//
// 设计：
// - 不破坏原有 DOM 结构
// - 仅操作文本节点，不动元素节点
// - 多次调用累积叠加（每个调用产生新的 wrapper 元素）

export interface WrapAction {
  /** 替换文本节点为 HTML 字符串（必须已转义） */
  replace?: string;
  /** 在文本节点外包裹 wrapper class（不替换原文本） */
  wrapperClass?: string;
}

export function wrapTextNodes(
  root: Element | Document,
  matcher: (text: string, node: Text) => WrapAction | null,
): number {
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      // 跳过 <script> / <style> 内容
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.tagName === 'SCRIPT' || p.tagName === 'STYLE') {
        return NodeFilter.FILTER_REJECT;
      }
      return node.textContent && node.textContent.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  let n: Node | null = walker.nextNode();
  while (n) {
    targets.push(n as Text);
    n = walker.nextNode();
  }

  for (const node of targets) {
    const text = node.textContent ?? '';
    const action = matcher(text, node);
    if (!action) continue;
    count++;

    if (action.replace) {
      const tmp = document.createElement('span');
      tmp.innerHTML = action.replace;
      const frag = document.createDocumentFragment();
      while (tmp.firstChild) frag.appendChild(tmp.firstChild);
      node.parentNode?.replaceChild(frag, node);
    } else if (action.wrapperClass) {
      const span = document.createElement('span');
      span.className = action.wrapperClass;
      span.textContent = text;
      node.parentNode?.replaceChild(span, node);
    }
  }

  return count;
}
