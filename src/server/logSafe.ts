// ログに出すエラーの説明。エラーの文面には、Gemini の返事や学習者の発言が混ざることがあるので出さない。
// 種類と HTTP の状態コードだけを出し、原因の見当はつけられるようにする

export function describeErrorForLog(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const status = (err as { status?: unknown }).status;
  const code = (err as { code?: unknown }).code;
  const parts = [err.name];
  if (typeof status === 'number') parts.push(`status=${status}`);
  if (typeof code === 'string' || typeof code === 'number') parts.push(`code=${code}`);
  return parts.join(' ');
}
