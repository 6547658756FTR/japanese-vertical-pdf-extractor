export type LayoutMode = 'paragraphs' | 'columns';

export type VerticalTextOptions = {
  removeRuby: boolean;
  verticalOnly: boolean;
  layout: LayoutMode;
};

export type TextToken = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  direction?: string;
};

export type OrderedPage = {
  text: string;
  columns: number;
  removedRuby: number;
};

const verticalPunctuation: Record<string, string> = {
  '︐': '、', '︑': '、', '︒': '。', '︓': '：', '︔': '；',
  '︕': '！', '︖': '？', '︵': '（', '︶': '）', '︷': '｛',
  '︸': '｝', '︹': '〔', '︺': '〕', '︻': '【', '︼': '】',
  '︽': '《', '︾': '》', '︿': '〈', '﹀': '〉', '﹁': '「',
  '﹂': '」', '﹃': '『', '﹄': '』', '﹇': '［', '﹈': '］',
  '︙': '…', '︰': '…',
};

const japaneseChar = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
const japaneseBeforeSpace = /([\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff])[ \t]+(?=[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff])/g;

function quantile(values: number[], q: number) {
  if (!values.length) return 12;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

function countVisible(text: string) {
  return Array.from(text.replace(/\s/g, '')).length;
}

function countJapanese(text: string) {
  return Array.from(text).filter((char) => japaneseChar.test(char)).length;
}

export function normalizeJapaneseText(value: string) {
  let text = value.normalize('NFC');
  text = Array.from(text, (char) => verticalPunctuation[char] ?? char).join('');
  text = text
    .replaceAll(String.fromCharCode(0), '')
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(japaneseBeforeSpace, '$1')
    .replace(/\s*([、。，．！？：；])\s*/g, '$1')
    .replace(/([「『（【〈《〔［])\s+/g, '$1')
    .replace(/\s+([」』）】〉》〕］])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function cleanOcrText(value: string, layout: LayoutMode) {
  const blocks = value
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean));

  const separator = layout === 'columns' ? '\n' : '';
  return normalizeJapaneseText(
    blocks.map((lines) => lines.join(separator)).filter((block) => block.length).join('\n'),
  );
}

export function orderVerticalPage(
  rawTokens: TextToken[],
  options: VerticalTextOptions,
): OrderedPage {
  let tokens = rawTokens.filter((token) => countVisible(token.text) > 0 && token.fontSize > 0);
  if (!tokens.length) return { text: '', columns: 0, removedRuby: 0 };

  const weightedSizes = tokens.flatMap((token) =>
    Array.from({ length: Math.min(8, Math.max(1, countVisible(token.text))) }, () => token.fontSize),
  );
  const referenceSize = Math.max(1, quantile(weightedSizes, 0.72));
  let removedRuby = 0;

  if (options.removeRuby) {
    const rubyLimit = referenceSize * 0.68;
    const kept = tokens.filter((token) => {
      const isRuby = token.fontSize < rubyLimit && countJapanese(token.text) > 0;
      if (isRuby) removedRuby += countVisible(token.text);
      return !isRuby;
    });
    if (kept.length) tokens = kept;
  }

  const tolerance = Math.max(2, referenceSize * 0.7);
  const sorted = [...tokens].sort((a, b) => b.x - a.x || b.y - a.y);
  const grouped: Array<{ x: number; tokens: TextToken[] }> = [];

  for (const token of sorted) {
    let nearest: (typeof grouped)[number] | undefined;
    let distance = Number.POSITIVE_INFINITY;
    for (const column of grouped) {
      const nextDistance = Math.abs(column.x - token.x);
      if (nextDistance <= tolerance && nextDistance < distance) {
        nearest = column;
        distance = nextDistance;
      }
    }
    if (nearest) {
      nearest.tokens.push(token);
      nearest.x = nearest.tokens.reduce((sum, item) => sum + item.x, 0) / nearest.tokens.length;
    } else {
      grouped.push({ x: token.x, tokens: [token] });
    }
  }

  grouped.sort((a, b) => b.x - a.x);
  const likelyVertical = grouped.filter((column) => {
    const ys = column.tokens.map((token) => token.y);
    const spanY = Math.max(...ys) - Math.min(...ys);
    const chars = column.tokens.reduce((sum, token) => sum + countVisible(token.text), 0);
    return column.tokens.some((token) => token.direction === 'ttb')
      || spanY >= referenceSize * 1.15
      || column.tokens.some((token) => token.height > token.width * 1.2 && chars >= 2)
      || (column.tokens.length >= 2 && chars >= 3);
  });
  const columns = options.verticalOnly && likelyVertical.length ? likelyVertical : grouped;
  const pageTop = Math.max(...columns.flatMap((column) => column.tokens.map((token) => token.y)));

  const rendered = columns.map((column) => {
    const ordered = [...column.tokens].sort((a, b) => b.y - a.y || b.x - a.x);
    let text = '';
    let previous: TextToken | undefined;
    for (const token of ordered) {
      if (previous) {
        const gap = previous.y - token.y;
        const expectedStep = Math.max(previous.fontSize, token.fontSize);
        if (gap > expectedStep * 2.35) text += '\n';
      }
      text += token.text;
      previous = token;
    }
    return {
      text: normalizeJapaneseText(text),
      top: Math.max(...ordered.map((token) => token.y)),
    };
  }).filter((column) => column.text.length);

  let text = '';
  rendered.forEach((column, index) => {
    if (index > 0) {
      const startsIndented = pageTop - column.top > referenceSize * 0.7;
      text += options.layout === 'columns' || startsIndented ? '\n' : '';
    }
    text += column.text;
  });

  return { text: normalizeJapaneseText(text), columns: rendered.length, removedRuby };
}
