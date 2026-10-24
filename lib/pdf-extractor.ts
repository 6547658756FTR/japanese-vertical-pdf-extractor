import {
  cleanOcrText,
  keepCornerQuotesOnOneLine,
  orderVerticalPage,
  type FuriganaMode,
  type LayoutMode,
  type PageLayoutMode,
  type TextToken,
} from './vertical-text';

export type ExtractionMode = 'auto' | 'text' | 'ocr';

export type ExtractSettings = {
  mode: ExtractionMode;
  furiganaMode: FuriganaMode;
  verticalOnly: boolean;
  pageBreaks: boolean;
  layout: LayoutMode;
  pageLayout: PageLayoutMode;
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
  sourceKind: 'pdf' | 'image' | 'mixed';
  pages: number;
  characters: number;
  ocrPages: number;
  textPages: number;
  columns: number;
  furiganaCharacters: number;
};

type OcrWorker = Awaited<ReturnType<(typeof import('tesseract.js'))['createWorker']>>;

type PdfTextItem = {
  str: string;
  dir?: string;
  transform: number[];
  width: number;
  height: number;
};

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_PDF_PAGES = 2_000;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_IMAGE_PIXELS = 60_000_000;
const MAX_OCR_DIMENSION = 4_000;
const MIN_OCR_LONG_EDGE = 2_600;
const OCR_BORDER_PIXELS = 24;

const PAGE_SENTENCE_END = /[。．.!！?？」』）】〉》〕］]$/u;
const PAGE_CLOSING_PUNCTUATION = /^[、。，．!！?？：；」』）】〉》〕］]/u;

function clearBytes(bytes: Uint8Array) {
  // PDF.js transfers the underlying buffer to its worker in browsers. A
  // transferred buffer is already inaccessible here and cannot be overwritten.
  if (bytes.byteLength > 0) bytes.fill(0);
}

function isPdfSignature(bytes: Uint8Array) {
  return String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
}

function isPngSignature(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((value, index) => bytes[index] === value);
}

function isJpegSignature(bytes: Uint8Array) {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function readPngDimensions(bytes: Uint8Array) {
  if (!isPngSignature(bytes) || bytes.byteLength < 24) throw new Error('INVALID_IMAGE_SIGNATURE');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpegDimensions(bytes: Uint8Array) {
  if (!isJpegSignature(bytes)) throw new Error('INVALID_IMAGE_SIGNATURE');
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.byteLength) break;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) break;
    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += segmentLength;
  }
  throw new Error('INVALID_IMAGE_SIGNATURE');
}

function validateImageDimensions(width: number, height: number) {
  if (
    width <= 0
    || height <= 0
    || width > MAX_IMAGE_DIMENSION
    || height > MAX_IMAGE_DIMENSION
    || width * height > MAX_IMAGE_PIXELS
  ) {
    throw new Error('IMAGE_DIMENSIONS_NOT_ALLOWED');
  }
}

export function isLikelyPageContinuation(previousPage: string, nextPage: string) {
  const previous = previousPage.trimEnd();
  const next = nextPage.trimStart();
  if (!previous || !next) return false;
  if (PAGE_CLOSING_PUNCTUATION.test(next)) return true;
  return !PAGE_SENTENCE_END.test(previous);
}

export function joinExtractedPages(pageTexts: string[], pageBreaks: boolean) {
  const pages = pageTexts.map((page) => page.trim()).filter(Boolean);
  if (pages.length === 0) return '';
  return pages.slice(1).reduce((joined, page) => {
    const separator = !pageBreaks || isLikelyPageContinuation(joined, page) ? '' : '\n\n';
    return `${joined}${separator}${page}`;
  }, pages[0]);
}

export function combineExtractionResults(
  items: ExtractionResult[],
  pageBreaks: boolean,
): ExtractionResult {
  const text = keepCornerQuotesOnOneLine(
    joinExtractedPages(items.map((item) => item.text), pageBreaks),
  ).trim();
  const sourceKinds = new Set(items.map((item) => item.sourceKind));
  return {
    text,
    sourceKind: sourceKinds.size === 1 ? items[0]?.sourceKind ?? 'image' : 'mixed',
    pages: items.reduce((sum, item) => sum + item.pages, 0),
    characters: Array.from(text).length,
    ocrPages: items.reduce((sum, item) => sum + item.ocrPages, 0),
    textPages: items.reduce((sum, item) => sum + item.textPages, 0),
    columns: items.reduce((sum, item) => sum + item.columns, 0),
    furiganaCharacters: items.reduce((sum, item) => sum + item.furiganaCharacters, 0),
  };
}

async function createVerticalOcrWorker(onRecognizing: (progress: number) => void): Promise<OcrWorker> {
  const tesseract = await import('tesseract.js');
  const assetUrl = (path: string) => new URL(path, document.baseURI).toString();
  const worker = await tesseract.createWorker('jpn_vert', tesseract.OEM.LSTM_ONLY, {
    workerPath: assetUrl('tesseract/worker.min.js'),
    corePath: assetUrl('tesseract/core'),
    langPath: assetUrl('tesseract/lang'),
    cacheMethod: 'none',
    gzip: true,
    logger(message) {
      if (message.status === 'recognizing text') onRecognizing(message.progress);
    },
  });
  await worker.setParameters({
    tessedit_pageseg_mode: tesseract.PSM.SINGLE_BLOCK_VERT_TEXT,
    preserve_interword_spaces: '0',
    user_defined_dpi: '300',
  });
  return worker;
}

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
  pageLayout: PageLayoutMode,
) {
  const base = page.getViewport({ scale: 1 });
  const maxDimension = 4000;
  const scale = Math.min(3.6, Math.max(2.2, maxDimension / Math.max(base.width, base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('페이지 이미지를 만들 수 없습니다.');
  try {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return recognizeOcrCanvas(canvas, worker, layout, pageLayout);
  } finally {
    context.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 1;
    canvas.height = 1;
  }
}

function addOcrBorder(source: HTMLCanvasElement) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width + OCR_BORDER_PIXELS * 2;
  canvas.height = source.height + OCR_BORDER_PIXELS * 2;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('OCR 이미지를 준비할 수 없습니다.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, OCR_BORDER_PIXELS, OCR_BORDER_PIXELS);
  return canvas;
}

function disposeCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d');
  context?.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 1;
  canvas.height = 1;
}

async function recognizeOcrCanvas(
  canvas: HTMLCanvasElement,
  worker: { recognize(image: HTMLCanvasElement): Promise<{ data: { text: string } }> },
  layout: LayoutMode,
  pageLayout: PageLayoutMode,
) {
  if (pageLayout === 'single') {
    const bordered = addOcrBorder(canvas);
    try {
      const result = await worker.recognize(bordered);
      return cleanOcrText(result.data.text, layout);
    } finally {
      disposeCanvas(bordered);
    }
  }

  const splitY = findHorizontalSplit(canvas);
  const regions = [
    { sourceY: 0, height: splitY },
    { sourceY: splitY, height: Math.max(1, canvas.height - splitY) },
  ];
  const texts: string[] = [];
  for (const region of regions) {
    const cropped = document.createElement('canvas');
    cropped.width = canvas.width;
    cropped.height = region.height;
    const context = cropped.getContext('2d', { alpha: false });
    if (!context) throw new Error('페이지 이미지를 나눌 수 없습니다.');
    try {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, cropped.width, cropped.height);
      context.drawImage(
        canvas,
        0,
        region.sourceY,
        canvas.width,
        region.height,
        0,
        0,
        cropped.width,
        cropped.height,
      );
      const bordered = addOcrBorder(cropped);
      try {
        const result = await worker.recognize(bordered);
        const text = cleanOcrText(result.data.text, layout);
        if (text) texts.push(text);
      } finally {
        disposeCanvas(bordered);
      }
    } finally {
      context.clearRect(0, 0, cropped.width, cropped.height);
      cropped.width = 1;
      cropped.height = 1;
    }
  }
  return texts.join(layout === 'columns' ? '\n' : '');
}

function findHorizontalSplit(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const fallback = Math.max(1, Math.floor(canvas.height / 2));
  if (!context || canvas.height < 20 || canvas.width < 20) return fallback;

  const startY = Math.floor(canvas.height * 0.28);
  const endY = Math.max(startY + 1, Math.ceil(canvas.height * 0.72));
  const height = endY - startY;
  const pixels = context.getImageData(0, startY, canvas.width, height).data;
  const stepX = Math.max(1, Math.floor(canvas.width / 500));
  const samplesPerRow = Math.ceil(canvas.width / stepX);
  const darkCounts: number[] = [];
  for (let y = 0; y < height; y += 1) {
    let dark = 0;
    for (let x = 0; x < canvas.width; x += stepX) {
      const offset = (y * canvas.width + x) * 4;
      const luminance = pixels[offset] * 0.2126
        + pixels[offset + 1] * 0.7152
        + pixels[offset + 2] * 0.0722;
      if (luminance < 205) dark += 1;
    }
    darkCounts.push(dark);
  }

  const minimumInk = Math.min(...darkCounts);
  const blankThreshold = minimumInk + Math.max(1, Math.floor(samplesPerRow * 0.006));
  let bestStart = 0;
  let bestLength = 0;
  let runStart = -1;
  for (let index = 0; index <= darkCounts.length; index += 1) {
    const isBlank = index < darkCounts.length && darkCounts[index] <= blankThreshold;
    if (isBlank && runStart < 0) runStart = index;
    if ((!isBlank || index === darkCounts.length) && runStart >= 0) {
      const length = index - runStart;
      const runMiddle = runStart + length / 2;
      const bestMiddle = bestStart + bestLength / 2;
      const isBetter = length > bestLength
        || (length === bestLength
          && Math.abs(runMiddle - darkCounts.length / 2) < Math.abs(bestMiddle - darkCounts.length / 2));
      if (isBetter) {
        bestStart = runStart;
        bestLength = length;
      }
      runStart = -1;
    }
  }
  if (bestLength < 2) return fallback;
  return Math.max(1, Math.min(canvas.height - 1, startY + Math.floor(bestStart + bestLength / 2)));
}

export async function extractJapanesePdf(
  file: File,
  settings: ExtractSettings,
  onProgress: (progress: ExtractionProgress) => void,
): Promise<ExtractionResult> {
  const pdfjs = await import('pdfjs-dist');
  const assetUrl = (path: string) => new URL(path, document.baseURI).toString();
  pdfjs.GlobalWorkerOptions.workerSrc = assetUrl('pdf.worker.min.mjs');

  onProgress({ page: 0, total: 0, percent: 2, stage: 'analyzing', detail: 'PDF 구조를 확인하는 중' });
  if (file.size <= 0 || file.size > MAX_SOURCE_BYTES) {
    throw new Error('PDF_SIZE_NOT_ALLOWED');
  }
  const data = new Uint8Array(await file.arrayBuffer());
  if (!isPdfSignature(data)) {
    clearBytes(data);
    throw new Error('INVALID_PDF_SIGNATURE');
  }

  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
  });
  const pageTexts: string[] = [];
  let worker: OcrWorker | undefined;
  let activeOcrPage = 0;
  let totalPages = 0;
  let ocrPages = 0;
  let textPages = 0;
  let columns = 0;
  let furiganaCharacters = 0;

  try {
    const pdf = await loadingTask.promise;
    totalPages = pdf.numPages;
    if (totalPages <= 0 || totalPages > MAX_PDF_PAGES) {
      throw new Error('PDF_PAGE_LIMIT');
    }

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = settings.mode === 'ocr' ? null : await page.getTextContent();
        const tokens = content
          ? content.items.flatMap((item) => (isTextItem(item) ? [toToken(item)] : []))
          : [];
        const shouldOcr = settings.mode === 'ocr'
          || (settings.mode === 'auto' && usefulCharacterCount(tokens) < 12);

        if (shouldOcr) {
          ocrPages += 1;
          activeOcrPage = pageNumber;
          onProgress({
            page: pageNumber,
            total: totalPages,
            percent: Math.round(((pageNumber - 0.65) / totalPages) * 100),
            stage: 'ocr',
            detail: worker ? `${pageNumber}쪽 일본어 OCR 중` : '내장 일본어 OCR 모델을 준비하는 중 · 최초 실행은 시간이 걸립니다',
          });
          if (!worker) {
            worker = await createVerticalOcrWorker((ocrProgress) => {
              const pageBase = activeOcrPage - 1;
              onProgress({
                page: activeOcrPage,
                total: totalPages,
                percent: Math.min(99, Math.round(((pageBase + ocrProgress) / totalPages) * 100)),
                stage: 'ocr',
                detail: `${activeOcrPage}쪽 일본어 OCR ${Math.round(ocrProgress * 100)}%`,
              });
            });
          }
          pageTexts.push(await ocrPage(page, worker, settings.layout, settings.pageLayout));
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
          furiganaCharacters += ordered.furiganaCharacters;
        }
      } finally {
        page.cleanup();
      }
    }
  } finally {
    try {
      await worker?.terminate();
    } finally {
      try {
        await loadingTask.destroy();
      } finally {
        clearBytes(data);
      }
    }
  }

  const text = keepCornerQuotesOnOneLine(joinExtractedPages(pageTexts, settings.pageBreaks)).trim();
  onProgress({ page: totalPages, total: totalPages, percent: 100, stage: 'text', detail: '추출 완료' });
  return {
    text,
    sourceKind: 'pdf',
    pages: totalPages,
    characters: Array.from(text).length,
    ocrPages,
    textPages,
    columns,
    furiganaCharacters,
  };
}

export async function extractJapaneseImage(
  file: File,
  settings: ExtractSettings,
  onProgress: (progress: ExtractionProgress) => void,
): Promise<ExtractionResult> {
  onProgress({ page: 0, total: 1, percent: 2, stage: 'analyzing', detail: '이미지 형식과 크기를 확인하는 중' });
  if (file.size <= 0 || file.size > MAX_SOURCE_BYTES) throw new Error('SOURCE_SIZE_NOT_ALLOWED');

  const data = new Uint8Array(await file.arrayBuffer());
  let bitmap: ImageBitmap | undefined;
  let worker: OcrWorker | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    const dimensions = isPngSignature(data)
      ? readPngDimensions(data)
      : isJpegSignature(data)
        ? readJpegDimensions(data)
        : undefined;
    if (!dimensions) throw new Error('INVALID_IMAGE_SIGNATURE');
    validateImageDimensions(dimensions.width, dimensions.height);

    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('IMAGE_DECODE_FAILED');
    }
    validateImageDimensions(bitmap.width, bitmap.height);

    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(
      MAX_OCR_DIMENSION / longEdge,
      Math.max(1, MIN_OCR_LONG_EDGE / longEdge),
    );
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('IMAGE_DECODE_FAILED');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    onProgress({
      page: 1,
      total: 1,
      percent: 8,
      stage: 'ocr',
      detail: '내장 일본어 OCR 모델을 준비하는 중 · 최초 실행은 시간이 걸립니다',
    });
    worker = await createVerticalOcrWorker((ocrProgress) => {
      onProgress({
        page: 1,
        total: 1,
        percent: Math.min(99, Math.max(8, Math.round(ocrProgress * 100))),
        stage: 'ocr',
        detail: `이미지 일본어 OCR ${Math.round(ocrProgress * 100)}%`,
      });
    });
    const recognized = await recognizeOcrCanvas(canvas, worker, settings.layout, settings.pageLayout);
    const text = keepCornerQuotesOnOneLine(recognized).trim();
    onProgress({ page: 1, total: 1, percent: 100, stage: 'text', detail: '추출 완료' });
    return {
      text,
      sourceKind: 'image',
      pages: 1,
      characters: Array.from(text).length,
      ocrPages: 1,
      textPages: 0,
      columns: 0,
      furiganaCharacters: 0,
    };
  } finally {
    await worker?.terminate();
    bitmap?.close();
    if (canvas) {
      const context = canvas.getContext('2d');
      context?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 1;
      canvas.height = 1;
    }
    clearBytes(data);
  }
}

export async function extractJapaneseSource(
  file: File,
  settings: ExtractSettings,
  onProgress: (progress: ExtractionProgress) => void,
) {
  if (file.size <= 0 || file.size > MAX_SOURCE_BYTES) throw new Error('SOURCE_SIZE_NOT_ALLOWED');
  const header = new Uint8Array(await file.slice(0, 24).arrayBuffer());
  try {
    if (isPdfSignature(header)) return extractJapanesePdf(file, settings, onProgress);
    if (isPngSignature(header) || isJpegSignature(header)) {
      return extractJapaneseImage(file, settings, onProgress);
    }
    throw new Error('INVALID_SOURCE_SIGNATURE');
  } finally {
    clearBytes(header);
  }
}
