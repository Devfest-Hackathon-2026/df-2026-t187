// チャットの吹き出しに関する文字の扱い

const SENTENCE_END = '。！？!?';

/**
 * 長い発言を句点や改行で短く区切り、チャットらしく1文ずつ送れるようにする。
 * 「★今だけ！今すぐ購入★」のように、★や括弧の内側にある！や。では区切らない。
 * 「のかい！？」のように句点が続くときは、続く句点までを同じ吹き出しに入れる
 */
export function splitIntoChatChunks(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inStar = false;
  let bracketDepth = 0;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\n') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
    if (ch === '★') inStar = !inStar;
    else if ('「『（('.includes(ch)) bracketDepth++;
    else if ('」』）)'.includes(ch)) bracketDepth = Math.max(0, bracketDepth - 1);
    else if (SENTENCE_END.includes(ch) && !inStar && bracketDepth === 0) {
      if (SENTENCE_END.includes(chars[i + 1] ?? '')) continue;
      parts.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length > 0 ? parts : [text.trim()];
}
