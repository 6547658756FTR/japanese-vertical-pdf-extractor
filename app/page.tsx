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
  RefreshCw,
  RotateCcw,
  ScanText,
  Upload,
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
  extractJapanesePdf,
  type ExtractionMode,
  type ExtractionProgress,
  type ExtractionResult,
  type ExtractSettings,
} from '@/lib/pdf-extractor';
import type { LayoutMode } from '@/lib/vertical-text';

type AppStage = 'idle' | 'working' | 'done' | 'error';

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: () => unknown;
};

type ModelContext = {
  registerTool(tool: ToolDefinition, options?: { signal?: AbortSignal }): void | Promise<void>;
};

const initialSettings: ExtractSettings = {
  mode: 'auto',
  removeRuby: true,
  verticalOnly: true,
  pageBreaks: true,
  layout: 'paragraphs',
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function downloadName(filename: string) {
  return `${filename.replace(/\.pdf$/i, '')}_세로쓰기.txt`;
}

function readableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/password/i.test(message)) return '비밀번호로 잠긴 PDF는 먼저 잠금을 해제한 뒤 다시 시도해 주세요.';
  if (/fetch|network|load language|worker/i.test(message)) {
    return '일본어 OCR 모델을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
  }
  return `PDF를 처리하지 못했습니다. 파일이 손상되지 않았는지 확인해 주세요. (${message})`;
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const latestRef = useRef({ stage: 'idle' as AppStage, filename: '', text: '' });
  const [file, setFile] = useState<File | null>(null);
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

  useEffect(() => {
    latestRef.current = { stage, filename: file?.name ?? '', text };
  }, [file, stage, text]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const tool: ToolDefinition = {
      name: 'read_extracted_text',
      title: '추출된 텍스트 읽기',
      description: '현재 화면에서 변환이 끝난 일본어 PDF 텍스트와 파일 이름을 읽습니다.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute() {
        const current = latestRef.current;
        if (current.stage !== 'done') throw new Error('아직 추출된 텍스트가 없습니다.');
        return { filename: current.filename, text: current.text };
      },
    };
    try {
      void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined);
    } catch {
      // WebMCP is optional; the visible app remains fully functional without it.
    }
    return () => lifecycle.abort();
  }, []);

  const runExtraction = useCallback(async (target: File, nextSettings: ExtractSettings) => {
    setStage('working');
    setError('');
    setCopied(false);
    setResult(null);
    setText('');
    setProgress({ page: 0, total: 0, percent: 1, stage: 'analyzing', detail: '파일을 여는 중' });
    try {
      const extracted = await extractJapanesePdf(target, nextSettings, setProgress);
      if (!extracted.text) throw new Error('추출할 수 있는 문자가 없습니다');
      setResult(extracted);
      setText(extracted.text);
      setStage('done');
    } catch (nextError) {
      setError(readableError(nextError));
      setStage('error');
    }
  }, []);

  const acceptFile = useCallback((nextFile: File | undefined) => {
    if (!nextFile) return;
    if (nextFile.type !== 'application/pdf' && !nextFile.name.toLowerCase().endsWith('.pdf')) {
      setError('PDF 파일만 선택할 수 있습니다.');
      setStage('error');
      return;
    }
    if (nextFile.size > 100 * 1024 * 1024) {
      setError('파일이 100MB를 넘습니다. PDF를 나누거나 용량을 줄인 뒤 다시 시도해 주세요.');
      setStage('error');
      return;
    }
    setFile(nextFile);
    void runExtraction(nextFile, settings);
  }, [runExtraction, settings]);

  const reset = useCallback(() => {
    setFile(null);
    setStage('idle');
    setResult(null);
    setText('');
    setError('');
    setCopied(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const copyText = useCallback(async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }, [text]);

  const downloadText = useCallback(() => {
    if (!file) return;
    const blob = new Blob([`\ufeff${text}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadName(file.name);
    anchor.click();
    URL.revokeObjectURL(url);
  }, [file, text]);

  const characterCount = useMemo(() => Array.from(text).length, [text]);
  const isWorking = stage === 'working';

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-ink/10 bg-paper/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8 lg:px-10">
          <button type="button" className="flex items-center gap-3 text-left" onClick={reset}>
            <span className="grid size-10 place-items-center rounded-sm bg-vermilion text-lg font-bold text-white">縦</span>
            <span>
              <span className="block font-display text-lg font-semibold tracking-tight">縦読み</span>
              <span className="block text-xs text-muted-foreground">일본어 세로쓰기 PDF 추출기</span>
            </span>
          </button>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LockKeyhole className="size-3.5" />
            <span className="hidden sm:inline">문서는 이 기기에서만 처리됩니다</span>
            <span className="sm:hidden">로컬 처리</span>
          </div>
        </div>
      </header>

      {!file ? (
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
              PDF의 글자 위치를 분석해 세로쓰기 순서로 재배열합니다. 텍스트 PDF와 스캔 PDF를 자동으로 구분합니다.
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
                aria-label="PDF 파일 선택"
                className={`group grid min-h-[320px] w-full place-items-center rounded-sm border border-dashed p-8 text-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vermilion focus-visible:ring-offset-4 ${isDragging ? 'border-vermilion bg-vermilion/[.055]' : 'border-ink/25 bg-paper/55 hover:border-vermilion hover:bg-vermilion/[.025]'}`}
                onClick={() => fileInputRef.current?.click()}
                onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsDragging(false); }}
                onDrop={(event: DragEvent<HTMLButtonElement>) => {
                  event.preventDefault();
                  setIsDragging(false);
                  acceptFile(event.dataTransfer.files[0]);
                }}
              >
                <span>
                  <span className="mx-auto grid size-16 place-items-center rounded-full border border-ink/10 bg-card text-vermilion shadow-sm transition group-hover:-translate-y-1">
                    <Upload className="size-7" strokeWidth={1.7} />
                  </span>
                  <span className="mt-6 block font-display text-xl font-semibold">PDF를 여기에 놓으세요</span>
                  <span className="mt-2 block text-sm leading-6 text-muted-foreground">또는 눌러서 파일 선택 · 최대 100MB</span>
                  <span className="mt-6 inline-flex h-9 items-center justify-center gap-2 rounded-sm bg-ink px-6 text-sm font-medium text-paper transition group-hover:bg-vermilion">
                    <FileText className="size-4" /> PDF 선택
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
                <p className="truncate font-semibold">{file.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{formatBytes(file.size)} · {isWorking ? progress.detail : stage === 'done' ? '추출 완료' : '처리 중 오류'}</p>
              </div>
            </div>
            <Button variant="outline" className="rounded-sm" onClick={reset} disabled={isWorking}>
              <RotateCcw className="size-4" /> 다른 PDF
            </Button>
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
                  <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">자동은 글자가 없는 페이지만 OCR합니다.</span>
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
                </div>

                <SettingSwitch label="후리가나 제거" description="작은 글자의 루비를 제외합니다." checked={settings.removeRuby} disabled={isWorking} onCheckedChange={(checked) => setSettings((current) => ({ ...current, removeRuby: checked }))} />
                <SettingSwitch label="세로 본문만" description="가로 머리말·쪽 번호를 제외합니다." checked={settings.verticalOnly} disabled={isWorking} onCheckedChange={(checked) => setSettings((current) => ({ ...current, verticalOnly: checked }))} />
                <SettingSwitch label="페이지 사이 띄우기" description="쪽 사이에 빈 줄을 넣습니다." checked={settings.pageBreaks} disabled={isWorking} onCheckedChange={(checked) => setSettings((current) => ({ ...current, pageBreaks: checked }))} />
              </div>

              <Button className="mt-6 w-full rounded-sm bg-ink text-paper hover:bg-vermilion" disabled={isWorking} onClick={() => void runExtraction(file, settings)}>
                <RefreshCw className={`size-4 ${isWorking ? 'animate-spin' : ''}`} /> 설정으로 다시 추출
              </Button>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">OCR을 처음 사용할 때 일본어 모델을 내려받습니다. PDF 이미지는 외부로 전송되지 않습니다.</p>
            </aside>

            <section className="min-w-0 rounded-md border border-ink/10 bg-card p-5 sm:p-6">
              {isWorking && (
                <div className="grid min-h-[520px] place-items-center">
                  <div className="w-full max-w-md text-center">
                    <span className="mx-auto grid size-16 place-items-center rounded-full bg-vermilion/10 text-vermilion"><ScanText className="size-7 animate-pulse" /></span>
                    <h2 className="mt-5 font-display text-2xl font-semibold">세로쓰기 순서를 읽고 있습니다</h2>
                    <p aria-live="polite" className="mt-2 text-sm leading-6 text-muted-foreground">{progress.detail}</p>
                    <Progress value={progress.percent} className="mt-6 [&_[data-slot=progress-indicator]]:bg-vermilion" />
                    <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                      <span>{progress.total ? `${progress.page} / ${progress.total}쪽` : '분석 중'}</span>
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
                    <Button className="mt-6 rounded-sm" onClick={() => void runExtraction(file, settings)}><RefreshCw className="size-4" /> 다시 시도</Button>
                  </div>
                </div>
              )}

              {stage === 'done' && result && (
                <>
                  <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-full bg-emerald-700 text-white"><Check className="size-3.5" /></span><h2 className="font-semibold">추출된 텍스트</h2></div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {result.pages}쪽 · {characterCount.toLocaleString()}자 · 텍스트 {result.textPages}쪽{result.ocrPages ? ` · OCR ${result.ocrPages}쪽` : ''}{result.removedRuby ? ` · 후리가나 ${result.removedRuby}자 제외` : ''}
                      </p>
                    </div>
                    <div className="flex gap-2">
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
                  <p className="mt-3 text-xs leading-5 text-muted-foreground">결과를 직접 고친 뒤 복사하거나 저장할 수 있습니다. 인용문·표·복잡한 혼합 조판은 원문과 대조해 주세요.</p>
                </>
              )}
            </section>
          </div>
        </section>
      )}

      <input ref={fileInputRef} className="sr-only" type="file" accept="application/pdf,.pdf" onChange={(event) => acceptFile(event.target.files?.[0])} />
      <footer className="mx-auto flex max-w-7xl items-center justify-between border-t border-ink/10 px-5 py-5 text-xs text-muted-foreground sm:px-8 lg:px-10">
        <span>텍스트 레이어 우선 · 필요할 때만 OCR</span><span>縦書き対応</span>
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
