export type LayoutMode = 'paragraphs' | 'columns';
export type FuriganaMode = 'omit' | 'parentheses';

export type VerticalTextOptions = {
  furiganaMode: FuriganaMode;
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
  furiganaCharacters: number;
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

/** Keep Japanese corner-bracket quotations intact even when extraction splits a column. */
export function keepCornerQuotesOnOneLine(value: string) {
  const source = value.replace(/\r\n?/g, '\n');
  let result = '';
  let quoteDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '「') quoteDepth += 1;

    if (character === '\n' && quoteDepth > 0) {
      result = result.replace(/[ \t]+$/g, '');
      while (source[index + 1] === ' ' || source[index + 1] === '\t') index += 1;
      continue;
    }

    result += character;
    if (character === '」' && quoteDepth > 0) quoteDepth -= 1;
  }

  return result;
}

/** Put each Japanese corner-bracket quotation on its own line. */
export function addCornerQuoteBoundaryBreaks(value: string) {
  return keepCornerQuotesOnOneLine(value)
    .replace(/([^\n])[ \t]*(?=「)/g, '$1\n')
    .replace(/」[ \t]*(?!\n|$)/g, '」\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
  if (!tokens.length) return { text: '', columns: 0, furiganaCharacters: 0 };

  const weightedSizes = tokens.flatMap((token) =>
    Array.from({ length: Math.min(8, Math.max(1, countVisible(token.text))) }, () => token.fontSize),
  );
  const referenceSize = Math.max(1, quantile(weightedSizes, 0.82));
  const rubyLimit = referenceSize * 0.68;
  const rubyTokens = tokens.filter(
    (token) => token.fontSize < rubyLimit && countJapanese(token.text) > 0,
  );
  const baseTokens = tokens.filter((token) => !rubyTokens.includes(token));
  const furiganaCharacters = rubyTokens.reduce(
    (sum, token) => sum + countVisible(token.text),
    0,
  );
  if (baseTokens.length) tokens = baseTokens;

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
  const rubyByBaseToken = new Map<TextToken, TextToken[]>();

  if (options.furiganaMode === 'parentheses' && baseTokens.length) {
    const rubyByColumn = new Map<(typeof columns)[number], TextToken[]>();
    for (const ruby of rubyTokens) {
      const columnsToLeft = columns.filter((column) => {
        const distance = ruby.x - column.x;
        return distance >= -tolerance * 0.2 && distance <= referenceSize * 2.1;
      });
      const candidates = columnsToLeft.length ? columnsToLeft : columns;
      const targetColumn = candidates.reduce((nearest, column) =>
        Math.abs(column.x - ruby.x) < Math.abs(nearest.x - ruby.x) ? column : nearest,
      );
      const assigned = rubyByColumn.get(targetColumn) ?? [];
      assigned.push(ruby);
      rubyByColumn.set(targetColumn, assigned);
    }

    for (const [column, assignedRuby] of rubyByColumn) {
      const rubyGroups: TextToken[][] = [];
      for (const ruby of [...assignedRuby].sort((a, b) => b.y - a.y || b.x - a.x)) {
        const currentGroup = rubyGroups.at(-1);
        const previous = currentGroup?.at(-1);
        const staysTogether = previous
          && previous.y - ruby.y <= referenceSize * 1.2
          && Math.abs(previous.x - ruby.x) <= tolerance;
        if (staysTogether && currentGroup) currentGroup.push(ruby);
        else rubyGroups.push([ruby]);
      }

      for (const rubyGroup of rubyGroups) {
        const rubyTop = Math.max(...rubyGroup.map((ruby) => ruby.y));
        const rubyBottom = Math.min(...rubyGroup.map((ruby) =>
          ruby.y - Math.max(
            ruby.height,
            ruby.fontSize * Math.max(1, countVisible(ruby.text)),
          ),
        ));
        const overlapping = column.tokens
          .filter((token) => token.y <= rubyTop + referenceSize * 0.55
            && token.y >= rubyBottom - referenceSize * 0.55)
          .sort((a, b) => b.y - a.y);
        const targetPool = overlapping.length ? overlapping : column.tokens;
        const target = [...targetPool].sort((a, b) => b.y - a.y).at(-1);
        if (!target) continue;
        rubyByBaseToken.set(target, [...(rubyByBaseToken.get(target) ?? []), ...rubyGroup]);
      }
    }
  }

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
      const attachedRuby = rubyByBaseToken.get(token);
      if (attachedRuby?.length) {
        const reading = attachedRuby
          .sort((a, b) => b.y - a.y)
          .map((ruby) => ruby.text)
          .join('');
        text += `（${normalizeJapaneseText(reading).replace(/\n/g, '')}）`;
      }
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

  return { text: normalizeJapaneseText(text), columns: rendered.length, furiganaCharacters };
}
