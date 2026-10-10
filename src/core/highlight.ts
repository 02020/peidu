// core/highlight.ts
// 转义红线：原始 HTML 字符必须先转义，再插入高亮 span，否则会产生 XSS 风险。
// marked 产出的 HTML 默认已转义，但保险起见再过一遍。
// 注意：microlighter 包名 npm 上可能不存在——D2 阶段再补真实高亮库。

/** 通用转义——和 reader.html 中的 esc() 一致 */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 代码高亮——关键字/字符串/数字/注释四类 */
export function highlightCode(code: string, lang = ''): string {
  const safe = esc(code);
  const cmt = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g;
  const str = /("[^"\n]*"|'[^'\n]*'|`[^`\n]*`)/g;
  const kw = /\b(function|const|let|var|return|if|else|for|while|class|extends|new|this|import|export|from|async|await|try|catch|throw|interface|type|enum|public|private|protected|static|void|null|true|false)\b/g;
  const num = /\b(\d+\.?\d*)\b/g;
  const masked = safe
    .replace(cmt, (m) => `<span class="hl-c">${m}</span>`)
    .replace(str, (m) => `<span class="hl-s">${m}</span>`)
    .replace(kw, (m) => `<span class="hl-k">${m}</span>`)
    .replace(num, (m) => `<span class="hl-n">${m}</span>`);
  return `<pre data-lang="${esc(lang)}"><code class="hljs">${masked}</code></pre>`;
}

/**
 * 在 HTML 文本中包裹高亮——对搜索匹配、划线恢复都通用。
 * 关键：插入 span 之前必须先转义原始字符串，否则会破坏 HTML 结构。
 */
export function wrapHighlight(text: string, className: string): string {
  return `<span class="${className}">${esc(text)}</span>`;
}
