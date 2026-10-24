'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import {
  Check,
  Clipboard,
  Download,
  FileText,
  LockKeyhole,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanText,
  TextQuote,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  combineExtractionResults,
  extractJapaneseSource,
  type ExtractionMode,
  type ExtractionProgress,
  type ExtractionResult,
  type ExtractSettings,
} from '@/lib/pdf-extractor';
import {
  addCornerQuoteBoundaryBreaks,
  keepCornerQuotesOnOneLine,
  type FuriganaMode,
  type LayoutMode,
  type PageLayoutMode,
} from '@/lib/vertical-text';

type AppStage = 'idle' | 'ready' | 'working' | 'done' | 'error';

const MAX_BATCH_FILES = 50;
const MAX_BATCH_BYTES = 300 * 1024 * 1024;

const initialSettings: ExtractSettings = {
  mode: 'auto',
  furiganaMode: 'omit',
  verticalOnly: true,
  pageBreaks: true,
  layout: 'paragraphs',
  pageLayout: 'single',
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function downloadName(files: File[]) {
  if (files.length > 1) return `세로쓰기_${files.length}개파일.txt`;
  const sanitized = (files[0]?.name ?? '추출결과')
    .normalize('NFC')
    .replace(/\.(?:pdf|png|jpe?g)$/i, '')
    .replace(/[<>:"/\\|?*]/g, '_');
  const stem = Array.from(sanitized, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? '_' : character;
  }).join('')
    .replace(/[. ]+$/g, '')
    .slice(0, 100);
  return `${stem || '추출결과'}_세로쓰기.txt`;
}

function readableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/password/i.test(message)) return '비밀번호로 잠긴 PDF는 먼저 잠금을 해제한 뒤 다시 시도해 주세요.';
  if (/PDF_SIZE_NOT_ALLOWED|SOURCE_SIZE_NOT_ALLOWED/i.test(message)) return '비어 있거나 100MB를 넘는 파일은 처리할 수 없습니다.';
  if (/INVALID_PDF_SIGNATURE|INVALID_IMAGE_SIGNATURE|INVALID_SOURCE_SIGNATURE|invalid pdf/i.test(message)) return '유효한 PDF, PNG 또는 JPG 파일이 아닙니다.';
  if (/IMAGE_DIMENSIONS_NOT_ALLOWED/i.test(message)) return '이미지 해상도가 너무 큽니다. 가로·세로 16,384픽셀 및 총 6천만 픽셀 이하로 줄여 주세요.';
  if (/IMAGE_DECODE_FAILED/i.test(message)) return '이미지를 열지 못했습니다. 손상되지 않은 PNG 또는 JPG인지 확인해 주세요.';
  if (/PDF_PAGE_LIMIT/i.test(message)) return '페이지 수가 너무 많습니다. 2,000쪽 이하로 나눈 뒤 다시 시도해 주세요.';
  if (/fetch|network|load language|worker|ocr/i.test(message)) {
    return '내장 일본어 OCR 구성 요소를 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.';
  }
  return '파일을 처리하지 못했습니다. 파일이 손상되지 않았는지 확인해 주세요.';
}

function prepareInputFile(file: File, index: number) {
  if (/\.(?:pdf|png|jpe?g)$/i.test(file.name)) return file;
  const extension = file.type === 'image/png'
    ? 'png'
    : file.type === 'image/jpeg'
      ? 'jpg'
      : file.type === 'application/pdf'
        ? 'pdf'
        : undefined;
  if (!extension) return file;
  return new File([file], `붙여넣기-${Date.now()}-${index + 1}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [stage, setStage] = useState<AppStage>('idle');
  const [settings, setSettings] = useState<ExtractSettings>(initialSettings);
  const [progress, setProgress] = useState<ExtractionProgress>({
    page: 0,
    total: 0,
    percent: 0,
    stage: 'analyzing',
    detail: '',
  });
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const runExtraction = useCallback(async (targets: File[], nextSettings: ExtractSettings) => {
    if (!targets.length) return;
    setStage('working');
    setError('');
    setCopied(false);
    setResult(null);
    setText('');
    setProgress({ page: 0, total: 0, percent: 1, stage: 'analyzing', detail: '파일을 여는 중' });
    let activeFilename = '';
    try {
      const extractedItems: ExtractionResult[] = [];
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        activeFilename = target.name;
        const extracted = await extractJapaneseSource(target, nextSettings, (nextProgress) => {
          setProgress({
            ...nextProgress,
            percent: Math.min(100, Math.round(((index + nextProgress.percent / 100) / targets.length) * 100)),
            detail: targets.length > 1
              ? `${index + 1}/${targets.length} · ${target.name} · ${nextProgress.detail}`
              : nextProgress.detail,
          });
        });
        extractedItems.push(extracted);
      }

      const combinedResult = combineExtractionResults(extractedItems, nextSettings.pageBreaks);
      if (!combinedResult.text) throw new Error('추출할 수 있는 문자가 없습니다');
      setResult(combinedResult);
      setText(combinedResult.text);
      setStage('done');
    } catch (nextError) {
      setError(`${targets.length > 1 && activeFilename ? `${activeFilename}: ` : ''}${readableError(nextError)}`);
      setStage('error');
    }
  }, []);

  const acceptFiles = useCallback((incomingFiles: File[]) => {
    if (!incomingFiles.length) return;
    const prepared = incomingFiles.map(prepareInputFile);
    const invalid = prepared.find((file) => !/\.(?:pdf|png|jpe?g)$/i.test(file.name));
    if (invalid) {
      setError('PDF, PNG 또는 JPG 파일만 선택할 수 있습니다.');
      if (!files.length) setStage('error');
      return;
    }
    const oversized = prepared.find((file) => file.size <= 0 || file.size > 100 * 1024 * 1024);
    if (oversized) {
      setError('파일이 100MB를 넘습니다. 파일을 나누거나 용량을 줄인 뒤 다시 시도해 주세요.');
      if (!files.length) setStage('error');
      return;
    }
    const nextFiles = [...files, ...prepared];
    if (nextFiles.length > MAX_BATCH_FILES) {
      setError(`한 번에 최대 ${MAX_BATCH_FILES}개까지 처리할 수 있습니다.`);
      return;
    }
    if (nextFiles.reduce((sum, file) => sum + file.size, 0) > MAX_BATCH_BYTES) {
      setError('선택한 파일의 총용량은 300MB 이하여야 합니다.');
      return;
    }
    setFiles(nextFiles);
    setStage('ready');
    setResult(null);
    setText('');
    setError('');
    setCopied(false);
  }, [files]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) return;
      const pastedImages = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === 'file' && /^image\/(?:png|jpeg)$/i.test(item.type))
        .flatMap((item) => {
          const file = item.getAsFile();
          return file ? [file] : [];
        });
      if (!pastedImages.length) return;
      event.preventDefault();
      acceptFiles(pastedImages);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [acceptFiles]);

  const reset = useCallback(() => {
    setFiles([]);
    setStage('idle');
    setResult(null);
    setText('');
    setError('');
    setCopied(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const removeFile = useCallback((index: number) => {
    const nextFiles = files.filter((_, fileIndex) => fileIndex !== index);
    setFiles(nextFiles);
    setResult(null);
    setText('');
    setError('');
    setCopied(false);
    setStage(nextFiles.length ? 'ready' : 'idle');
  }, [files]);

  const copyText = useCallback(async () => {
    const safeText = keepCornerQuotesOnOneLine(text);
    setText(safeText);
    try {
      await navigator.clipboard.writeText(safeText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('클립보드 권한이 없어 복사하지 못했습니다. 결과를 직접 선택해 복사해 주세요.');
    }
  }, [text]);

  const downloadText = useCallback(() => {
    if (!files.length) return;
    const safeText = keepCornerQuotesOnOneLine(text);
    setText(safeText);
    const blob = new Blob([`\ufeff${safeText}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadName(files);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [files, text]);

  const addQuoteBreaks = useCallback(() => {
    setText((current) => addCornerQuoteBoundaryBreaks(current));
  }, []);

  const characterCount = useMemo(() => Array.from(text).length, [text]);
  const isWorking = stage === 'working';
  const selectedFilesAreImages = files.length > 0 && files.every((file) => /\.(?:png|jpe?g)$/i.test(file.name));
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-ink/10 bg-paper/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8 lg:px-10">
          <button type="button" className="flex items-center gap-3 text-left" onClick={reset}>
            <span className="grid size-10 place-items-center rounded-sm bg-vermilion text-lg font-bold text-white">縦</span>
            <span>
              <span className="block font-display text-lg font-semibold tracking-tight">縦読み</span>
              <span className="block text-xs text-muted-foreground">일본어 세로쓰기 PDF·이미지 추출기</span>
            </span>
          </button>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LockKeyhole className="size-3.5" />
            <span className="hidden sm:inline">문서는 이 기기에서만 처리됩니다</span>
            <span className="sm:hidden">로컬 처리</span>
          </div>
        </div>
      </header>

      {!files.length ? (
        <section className="mx-auto grid max-w-7xl gap-10 px-5 py-10 sm:px-8 lg:grid-cols-[1.05fr_.95fr] lg:items-center lg:px-10 lg:py-16">
          <div className="max-w-xl">
            <div className="mb-6 flex items-center gap-3 text-xs font-semibold tracking-[.16em] text-vermilion">
              <span className="h-px w-8 bg-vermilion" />
              RIGHT TO LEFT · TOP TO BOTTOM
            </div>
            <h1 className="font-display text-4xl font-semibold leading-[1.18] tracking-[-.035em] sm:text-5xl">
              오른쪽 열부터 읽어내려
              <br />
              깔끔한 일본어 텍스트로
            </h1>
            <p className="mt-5 max-w-lg text-base leading-7 text-muted-foreground sm:text-lg">
              PDF의 글자 위치를 분석해 세로쓰기 순서로 재배열합니다. 스캔 PDF와 PNG·JPG 이미지는 내장 OCR로 읽습니다.
            </p>
            <dl className="mt-8 grid grid-cols-3 gap-3 border-t border-ink/10 pt-5 text-sm">
              <div><dt className="text-muted-foreground">방향</dt><dd className="mt-1 font-semibold">右 → 左</dd></div>
              <div><dt className="text-muted-foreground">언어</dt><dd className="mt-1 font-semibold">日本語</dd></div>
              <div><dt className="text-muted-foreground">출력</dt><dd className="mt-1 font-semibold">UTF-8 TXT</dd></div>
            </dl>
          </div>

          <div className="relative">
            <div aria-hidden="true" className="absolute -right-3 -top-3 h-full w-full rounded-md border border-vermilion/30" />
            <div className="relative rounded-md border border-ink/15 bg-card p-4 shadow-[0_24px_70px_rgba(35,31,28,.09)] sm:p-6">
              <button
                type="button"
                aria-label="PDF 또는 이미지 파일 선택"
                className={`group grid min-h-[320px] w-full place-items-center rounded-sm border border-dashed p-8 text-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vermilion focus-visible:ring-offset-4 ${isDragging ? 'border-vermilion bg-vermilion/[.055]' : 'border-ink/25 bg-paper/55 hover:border-vermilion hover:bg-vermilion/[.025]'}`}
                onClick={() => fileInputRef.current?.click()}
                onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsDragging(false); }}
                onDrop={(event: DragEvent<HTMLButtonElement>) => {
                  event.preventDefault();
                  setIsDragging(false);
                  acceptFiles(Array.from(event.dataTransfer.files));
                }}
              >
                <span>
                  <span className="mx-auto grid size-16 place-items-center rounded-full border border-ink/10 bg-card text-vermilion shadow-sm transition group-hover:-translate-y-1">
                    <Upload className="size-7" strokeWidth={1.7} />
                  </span>
                  <span className="mt-6 block font-display text-xl font-semibold">PDF·PNG·JPG를 여기에 놓으세요</span>
                  <span className="mt-2 block text-sm leading-6 text-muted-foreground">여러 파일 선택 또는 Ctrl+V로 이미지 붙여넣기 · 파일당 최대 100MB</span>
                  <span className="mt-6 inline-flex h-9 items-center justify-center gap-2 rounded-sm bg-ink px-6 text-sm font-medium text-paper transition group-hover:bg-vermilion">
                    <FileText className="size-4" /> 파일 선택
                  </span>
                </span>
              </button>
              {stage === 'error' && error && (
                <p role="alert" className="mt-4 rounded-sm bg-destructive/10 px-4 py-3 text-sm leading-6 text-destructive">{error}</p>
              )}
            </div>
          </div>
        </section>
      ) : (
        <section className="mx-auto max-w-7xl px-5 py-7 sm:px-8 lg:px-10 lg:py-9">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-ink/10 pb-5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-sm bg-vermilion/10 text-vermilion"><FileText className="size-5" /></span>
              <div className="min-w-0">
                <p className="truncate font-semibold">{files.length === 1 ? files[0].name : `${files.length}개 파일 선택됨`}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{formatBytes(totalBytes)} · {isWorking ? progress.detail : stage === 'done' ? '추출 완료' : stage === 'ready' ? '인식 대기' : '처리 중 오류'}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="rounded-sm" onClick={() => fileInputRef.current?.click()} disabled={isWorking}>
                <Plus className="size-4" /> 파일 추가
              </Button>
              <Button variant="outline" className="rounded-sm" onClick={reset} disabled={isWorking}>
                <RotateCcw className="size-4" /> 전체 비우기
              </Button>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
            <aside className="h-fit rounded-md border border-ink/10 bg-card p-5">
              <div className="mb-5 flex items-center gap-2"><ScanText className="size-4 text-vermilion" /><h2 className="font-semibold">추출 설정</h2></div>
              <div className="space-y-5">
                <div>
                  <span className="mb-2 block text-sm font-medium">처리 방식</span>
                  <Select value={settings.mode} onValueChange={(value) => setSettings((current) => ({ ...current, mode: value as ExtractionMode }))} disabled={isWorking}>
                    <SelectTrigger className="h-10 w-full rounded-sm bg-paper"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">자동 감지</SelectItem>
                      <SelectItem value="text">텍스트 레이어만</SelectItem>
                      <SelectItem value="ocr">모든 페이지 OCR</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">자동은 글자가 없는 PDF 페이지만 OCR하며, 이미지는 항상 OCR합니다.</span>
                </div>

                <div>
                  <span className="mb-2 block text-sm font-medium">페이지 구성</span>
                  <Select value={settings.pageLayout} onValueChange={(value) => setSettings((current) => ({ ...current, pageLayout: value as PageLayoutMode }))} disabled={isWorking}>
                    <SelectTrigger className="h-10 w-full rounded-sm bg-paper"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="single">일반 한 단</SelectItem>
                      <SelectItem value="split-horizontal">상·하 두 단</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">두 단은 상단 전체를 우→좌로 읽은 다음 하단 전체를 우→좌로 읽습니다.</span>
                </div>

                <div>
                  <span className="mb-2 block text-sm font-medium">줄바꿈</span>
                  <Select value={settings.layout} onValueChange={(value) => setSettings((current) => ({ ...current, layout: value as LayoutMode }))} disabled={isWorking}>
                    <SelectTrigger className="h-10 w-full rounded-sm bg-paper"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="paragraphs">문단 위주로 연결</SelectItem>
                      <SelectItem value="columns">세로 열마다 줄바꿈</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">끝까지 찬 세로 열은 다음 열과 이어 붙이고, 실제 문단만 줄을 바꿉니다.</span>
                </div>

                <div className="border-t border-ink/10 pt-4">
                  <span className="mb-2 block text-sm font-medium">후리가나 처리</span>
                  <Select value={settings.furiganaMode} onValueChange={(value) => setSettings((current) => ({ ...current, furiganaMode: value as FuriganaMode }))} disabled={isWorking}>
                    <SelectTrigger className="h-10 w-full rounded-sm bg-paper"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="omit">제거</SelectItem>
                      <SelectItem value="parentheses">괄호로 표시</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">괄호 모드(텍스트 PDF): 漢字（かんじ）</span>
                </div>
                <SettingSwitch label="세로 본문만" description="가로 머리말·쪽 번호를 제외합니다." checked={settings.verticalOnly} disabled={isWorking} onCheckedChange={(checked) => setSettings((current) => ({ ...current, verticalOnly: checked }))} />
                <SettingSwitch label="페이지 사이 띄우기" description="이어지는 문장은 붙이고, 나머지 쪽 사이에 빈 줄을 넣습니다." checked={settings.pageBreaks} disabled={isWorking} onCheckedChange={(checked) => setSettings((current) => ({ ...current, pageBreaks: checked }))} />
              </div>

              <Button className="mt-6 w-full rounded-sm bg-ink text-paper hover:bg-vermilion" disabled={isWorking} onClick={() => void runExtraction(files, settings)}>
                {stage === 'ready' ? <Play className="size-4" /> : <RefreshCw className={`size-4 ${isWorking ? 'animate-spin' : ''}`} />}
                {stage === 'ready' ? '인식 시작' : '설정으로 다시 추출'}
              </Button>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">선택·붙여넣기한 파일과 추출 결과는 브라우저 메모리에서만 처리되며 업로드·저장되지 않습니다.</p>
            </aside>

            <section className="min-w-0 rounded-md border border-ink/10 bg-card p-5 sm:p-6">
              {stage === 'ready' && (
                <div className="mx-auto flex min-h-[520px] max-w-2xl flex-col justify-center">
                  <div className="text-center">
                    <span className="mx-auto grid size-16 place-items-center rounded-full bg-vermilion/10 text-vermilion"><Clipboard className="size-7" /></span>
                    <h2 className="mt-5 font-display text-2xl font-semibold">파일을 확인한 뒤 인식을 시작하세요</h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">아래 순서대로 처리합니다. 이 화면에서 Ctrl+V로 PNG·JPG 이미지를 더 붙여넣을 수 있습니다.</p>
                  </div>
                  <div className="mt-6 max-h-64 space-y-2 overflow-y-auto rounded-sm border border-ink/10 bg-paper/60 p-3">
                    {files.map((selectedFile, index) => (
                      <div key={`${selectedFile.name}-${selectedFile.size}-${selectedFile.lastModified}-${index}`} className="flex items-center gap-3 rounded-sm bg-card px-3 py-2.5">
                        <span className="grid size-8 shrink-0 place-items-center rounded-sm bg-vermilion/10 text-xs font-semibold text-vermilion">{index + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{selectedFile.name}</span>
                          <span className="block text-xs text-muted-foreground">{formatBytes(selectedFile.size)}</span>
                        </span>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={`${selectedFile.name} 제거`} onClick={() => removeFile(index)}>
                          <X className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  {error && <p role="alert" className="mt-3 rounded-sm bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}
                  <Button className="mx-auto mt-6 rounded-sm bg-vermilion px-8 text-white hover:bg-vermilion/90" onClick={() => void runExtraction(files, settings)}>
                    <Play className="size-4" /> {files.length}개 파일 인식 시작
                  </Button>
                </div>
              )}

              {isWorking && (
                <div className="grid min-h-[520px] place-items-center">
                  <div className="w-full max-w-md text-center">
                    <span className="mx-auto grid size-16 place-items-center rounded-full bg-vermilion/10 text-vermilion"><ScanText className="size-7 animate-pulse" /></span>
                    <h2 className="mt-5 font-display text-2xl font-semibold">세로쓰기 순서를 읽고 있습니다</h2>
                    <p aria-live="polite" className="mt-2 text-sm leading-6 text-muted-foreground">{progress.detail}</p>
                    <Progress value={progress.percent} className="mt-6 [&_[data-slot=progress-indicator]]:bg-vermilion" />
                    <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                      <span>{files.length > 1 ? `${files.length}개 파일 순차 처리` : progress.total ? `${progress.page} / ${progress.total}${selectedFilesAreImages ? '장' : '쪽'}` : '분석 중'}</span>
                      <span>{progress.percent}%</span>
                    </div>
                  </div>
                </div>
              )}

              {stage === 'error' && (
                <div className="grid min-h-[520px] place-items-center text-center">
                  <div className="max-w-md">
                    <span className="font-display text-5xl text-vermilion">読</span>
                    <h2 className="mt-5 text-xl font-semibold">추출을 마치지 못했습니다</h2>
                    <p role="alert" className="mt-3 text-sm leading-6 text-muted-foreground">{error}</p>
                    <Button className="mt-6 rounded-sm" onClick={() => void runExtraction(files, settings)}><RefreshCw className="size-4" /> 다시 시도</Button>
                  </div>
                </div>
              )}

              {stage === 'done' && result && (
                <>
                  <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-full bg-emerald-700 text-white"><Check className="size-3.5" /></span><h2 className="font-semibold">추출된 텍스트</h2></div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {files.length}개 파일 · {result.pages}{result.sourceKind === 'image' ? '장' : result.sourceKind === 'pdf' ? '쪽' : '개 면'} · {characterCount.toLocaleString()}자{result.sourceKind === 'pdf' ? ` · 텍스트 ${result.textPages}쪽${result.ocrPages ? ` · OCR ${result.ocrPages}쪽` : ''}` : result.sourceKind === 'image' ? ' · 이미지 OCR' : ` · 텍스트 ${result.textPages}쪽 · OCR ${result.ocrPages}개 면`}{result.furiganaCharacters ? ` · 후리가나 ${result.furiganaCharacters}자 ${settings.furiganaMode === 'omit' ? '제외' : '표시'}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" className="rounded-sm" onClick={addQuoteBreaks} title="「 앞과 」 뒤에 빠진 줄바꿈을 넣습니다">
                        <TextQuote className="size-4" /> 「」 앞뒤 줄바꿈
                      </Button>
                      <Button variant="outline" className="rounded-sm" onClick={() => void copyText()}>
                        {copied ? <Check className="size-4" /> : <Clipboard className="size-4" />} {copied ? '복사됨' : '복사'}
                      </Button>
                      <Button className="rounded-sm bg-vermilion text-white hover:bg-vermilion/90" onClick={downloadText}>
                        <Download className="size-4" /> TXT 저장
                      </Button>
                    </div>
                  </div>
                  <Textarea
                    aria-label="추출된 일본어 텍스트"
                    lang="ja"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    spellCheck={false}
                    className="min-h-[500px] resize-y rounded-sm border-ink/15 bg-paper/65 p-5 font-display text-base leading-8 shadow-inner focus-visible:border-vermilion focus-visible:ring-vermilion/30"
                  />
                  <p className="mt-3 text-xs leading-5 text-muted-foreground">기본 규칙으로 「부터 」까지는 한 줄로 유지됩니다. 결과를 직접 고친 뒤 복사하거나 저장할 수 있습니다.</p>
                </>
              )}
            </section>
          </div>
        </section>
      )}

      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        multiple
        accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"
        onChange={(event) => {
          acceptFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <footer className="mx-auto flex max-w-7xl items-center justify-between border-t border-ink/10 px-5 py-5 text-xs text-muted-foreground sm:px-8 lg:px-10">
        <span>텍스트 레이어 우선 · 이미지/스캔 OCR</span>
        <span>최종 업데이트 · v1.0.0</span>
      </footer>
    </main>
  );
}

function SettingSwitch({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-ink/10 pt-4">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      <Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} className="mt-0.5 data-checked:bg-vermilion" />
    </div>
  );
}
