// core/frontmatter.ts
// 解析 markdown 文档开头的 YAML frontmatter。
// 容错：解析失败返回空对象，不抛错。

export interface Frontmatter {
  [key: string]: string | number | boolean | string[];
}

export interface FrontmatterResult {
  meta: Frontmatter;
  /** frontmatter 之后的内容（不含 --- 边界） */
  body: string;
}

export function parseFrontmatter(md: string): FrontmatterResult {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { meta: {}, body: md };
  }

  // 找结束 ---
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) {
    return { meta: {}, body: md };
  }

  const yamlText = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');

  return { meta: parseSimpleYaml(yamlText), body };
}

/** 简化版 YAML 解析——只支持 key: value 单行 / 数组 */
function parseSimpleYaml(text: string): Frontmatter {
  const meta: Frontmatter = {};
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let value: string | number | boolean | string[] = m[2].trim();

    // 去掉引号
    if (
      typeof value === 'string' &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // 数字
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
      value = Number(value);
    }
    // 布尔
    if (value === 'true') value = true;
    if (value === 'false') value = false;
    // 数组（行内 [a, b, c]）
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }

    meta[key] = value;
  }

  return meta;
}
