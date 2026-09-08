import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '縦読み | 일본어 세로쓰기 PDF 추출기',
  description: '오른쪽에서 왼쪽으로 읽는 일본어 세로쓰기 PDF를 UTF-8 텍스트로 정리합니다.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
