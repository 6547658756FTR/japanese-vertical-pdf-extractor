import {
  cleanOcrText,
  orderVerticalPage,
  type LayoutMode,
  type TextToken,
} from './vertical-text';

export type ExtractionMode = 'auto' | 'text' | 'ocr';

export type ExtractSettings = {
  mode: ExtractionMode;
  removeRuby: boolean;
  verticalOnly: boolean;
  pageBreaks: boolean;
  layout: LayoutMode;
};

export type ExtractionProgress = {
  page: number;
  total: number;
  percent: number;
  stage: 'analyzing' | 'text' | 'ocr';
  detail: string;
};

export type ExtractionResult = {
  text: string;
  pages: number;
  characters: number;
  ocrPages: number;
  textPages: number;
  columns: number;
  removedRuby: number;
};

type PdfTextItem = {
  str: string;
  dir?: string;
  transform: number[];
  width: number;
  height: number;
};

function isTextItem(item: unknown): item is PdfTextItem {
  if (!item || typeof item !== 'object') return false;
  const value = item as Partial<PdfTextItem>;
  return typeof value.str === 'string' && Array.isArray(value.transform);
}

function toToken(item: PdfTextItem): TextToken {
  const transform = item.transform;
  const fontSize = Math.max(
    Math.hypot(transform[0] ?? 0, transform[1] ?? 0),
    Math.hypot(transform[2] ?? 0, transform[3] ?? 0),
  );
  return {
    text: item.str,
    direction: item.dir,
    x: transform[4] ?? 0,
    y: transform[5] ?? 0,
    width: Math.abs(item.width ?? 0),
    height: Math.abs(item.height ?? 0),
    fontSize,
  };
}

function usefulCharacterCount(tokens: TextToken[]) {
  return tokens.reduce((sum, token) => sum + Array.from(token.text.replace(/\s/g, '')).length, 0);
}

async function ocrPage(
  page: {
    getViewport(options: { scale: number }): { width: number; height: number };
    render(options: unknown): { promise: Promise<void> };
  },
  worker: { recognize(image: HTMLCanvasElement): Promise<{ data: { text: string } }> },
  layout: LayoutMode,
) {
  const base = page.getViewport({ scale: 1 });
  const maxDimension = 3200;
  const scale = Math.min(3, Math.max(1.8, maxDimension / Math.max(base.width, base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('페이지 이미지를 만들 수 없습니다.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const result = await worker.recognize(canvas);
  canvas.width = 1;
  canvas.height = 1;
  return cleanOcrText(result.data.text, layout);
}

export async function extractJapanesePdf(
  file: File,
  settings: ExtractSettings,
  onProgress: (progress: ExtractionProgress) => void,
): Promise<ExtractionResult> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('/pdf.worker.min.mjs', window.location.href).toString();

  onProgress({ page: 0, total: 0, percent: 2, stage: 'analyzing', detail: 'PDF 구조를 확인하는 중' });
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;
  const pageTexts: string[] = [];
  let worker: Awaited<ReturnType<(typeof import('tesseract.js'))['createWorker']>> | undefined;
  let ocrPages = 0;
  let textPages = 0;
  let columns = 0;
  let removedRuby = 0;

  try {
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = settings.mode === 'ocr' ? null : await page.getTextContent();
      const tokens = content
        ? content.items.flatMap((item) => (isTextItem(item) ? [toToken(item)] : []))
        : [];
      const shouldOcr = settings.mode === 'ocr'
        || (settings.mode === 'auto' && usefulCharacterCount(tokens) < 12);

      if (shouldOcr) {
        ocrPages += 1;
        onProgress({
          page: pageNumber,
          total: totalPages,
          percent: Math.round(((pageNumber - 0.65) / totalPages) * 100),
          stage: 'ocr',
          detail: worker ? `${pageNumber}쪽 일본어 OCR 중` : '일본어 OCR 모델을 준비하는 중 · 최초 1회는 시간이 걸립니다',
        });
        if (!worker) {
          const tesseract = await import('tesseract.js');
          worker = await tesseract.createWorker('jpn_vert', tesseract.OEM.LSTM_ONLY, {
            logger(message) {
              if (message.status === 'recognizing text') {
                const pageBase = pageNumber - 1;
                onProgress({
                  page: pageNumber,
                  total: totalPages,
                  percent: Math.min(99, Math.round(((pageBase + message.progress) / totalPages) * 100)),
                  stage: 'ocr',
                  detail: `${pageNumber}쪽 일본어 OCR ${Math.round(message.progress * 100)}%`,
                });
              }
            },
          });
          await worker.setParameters({
            tessedit_pageseg_mode: tesseract.PSM.SINGLE_BLOCK_VERT_TEXT,
            preserve_interword_spaces: '0',
            user_defined_dpi: '300',
          });
        }
        pageTexts.push(await ocrPage(page, worker, settings.layout));
      } else {
        textPages += 1;
        onProgress({
          page: pageNumber,
          total: totalPages,
          percent: Math.round(((pageNumber - 0.4) / totalPages) * 100),
          stage: 'text',
          detail: `${pageNumber}쪽 글자 위치를 재정렬하는 중`,
        });
        const ordered = orderVerticalPage(tokens, settings);
        pageTexts.push(ordered.text);
        columns += ordered.columns;
        removedRuby += ordered.removedRuby;
      }

      page.cleanup();
    }
  } finally {
    await worker?.terminate();
    await loadingTask.destroy();
  }

  const separator = settings.pageBreaks ? '\n\n' : '';
  const text = pageTexts.filter(Boolean).join(separator).trim();
  onProgress({ page: totalPages, total: totalPages, percent: 100, stage: 'text', detail: '추출 완료' });
  return {
    text,
    pages: totalPages,
    characters: Array.from(text).length,
    ocrPages,
    textPages,
    columns,
    removedRuby,
  };
}
