import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '縦読み | 일본어 세로쓰기 PDF·이미지 추출기',
  description: '오른쪽에서 왼쪽으로 읽는 일본어 세로쓰기 PDF·PNG·JPG를 UTF-8 텍스트로 정리합니다.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content="default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'"
        />
        <meta name="referrer" content="no-referrer" />
        <meta name="robots" content="noindex, nofollow, noarchive" />
      </head>
      <body>{children}</body>
    </html>
  );
}
