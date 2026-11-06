// 学習者の発言の振り分け。サーバーと画面の両方で使う（画面では、改造の作業ログをすぐ出すかの判断や宛先の自動切替に使う）

import type { ReviewerPersona } from './types.ts';

const QUESTION_PATTERN =
  /なぜ|なんで|どうして|どうなって|どうすれば|どうしたら|何から|何これ|なにこれ|何の|しくみ|仕組み|教えて|説明|意味|とは|原因|どこ|だれ|誰|べき|[?？]$/;
const CHANGE_REQUEST_PATTERN =
  /(直|消|外|変え|足|加え|入れ|作|動か|移|並べ替え|まとめ|大きく|小さく|目立たなく|戻)(して|す|る|したい|しておいて|ておいて)|手直しして|改造して|ほしい|にして/;

const AT_MENTION_RE =
  /(?:^|[\s、,，。！？!?])[@＠](店長|お助けAI|お助けエージェント|お?客(?:さん)?[ABCＡＢＣ])(?:さん|くん|ちゃん|様)?(?=[、,，：:！!？?\s]|$)/i;

const VOCATIVE_START_RE =
  /^(?:(?:ねえ|ねぇ|あの|すみません|すいません|ちょっと|おい|なあ|もしもし|こんにちは|どうも)[、,，\s！!]*)*(店長|お助けAI|お助けエージェント|お?客(?:さん)?[ABCＡＢＣ])(?:さん|くん|ちゃん|様)?(?:(?:[、,，：:！!]+|\s+)|(?:へ|に(?:質問|聞きたい|聞くけど|聞くね|聞きます|相談|お願い|確認))(?:[、,，：:！!\s]|$|だけど|なんだけど)|[！!？?]*$)/i;

/**
 * 発言の中で別の相手を「明確にメンション（呼びかけ・宛先指定）」しているか判定する。
 * 「店長が付けた広告」「客Aはどこで困った？」のように文中に名前が入っているだけ（第三者への言及）では反応しない。
 *
 * @returns 'assistant' | 'owner' | ペルソナID（または '客A'〜'客C'） | null（明確なメンションなし）
 */
export function detectExplicitRecipientMention(
  message: string,
  cohortPersonas: Pick<ReviewerPersona, 'id' | 'name'>[] = [],
): string | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const rawTarget = (AT_MENTION_RE.exec(trimmed)?.[1] ?? VOCATIVE_START_RE.exec(trimmed)?.[1])
    ?.replace(/[Ａ-Ｃ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toUpperCase();

  if (!rawTarget) return null;

  if (rawTarget === '店長') return 'owner';
  if (rawTarget.startsWith('お助け')) return 'assistant';

  const customerMatch = rawTarget.match(/[ABC]$/);
  if (customerMatch) {
    const customerName = `客${customerMatch[0]}`;
    const matchedPersona = cohortPersonas.find((p) => p.name === customerName);
    return matchedPersona ? matchedPersona.id : customerName;
  }
  return null;
}

/**
 * チャットで「画面全体を1つ前に戻す」「最初の画面に戻す」と指示しているか判定する。
 * 「定期便を戻して」「ボタンの色を元に戻して」のように特定の部品名を含む場合は null を返し、AIの部品パッチに任せる。
 */
const SPECIFIC_PART_KEYWORDS =
  /ボタン|広告|バナー|ポップアップ|定期|チェック|金額|合計|送料|手数料|カウントダウン|タイマー|文字|色|見出し|説明|確認|選択|入力|欄|枠|画像|写真/;

const RESET_SCREEN_RE =
  /^(?:やっぱり|ちょっと|すみません|お助けAI[、,\s]*)?(?:一番)?(?:最初|初期|はじめ)(?:の画面|の状態)?(?:に|から|へ)?(?:戻して|戻す|やり直して|やり直す|リセットして)[！!。？?]*$/;

const UNDO_SCREEN_RE =
  /^(?:やっぱり|ちょっと|すみません|お助けAI[、,\s]*)?(?:(?:1つ|ひとつ|一歩)?前の(?:画面|状態)に?(?:戻して|戻す)|さっきの(?:変更|手直し|画面|状態)?を?(?:戻して|取り消して|やめて|キャンセルして)|(?:画面を)?(?:元に|もとに)?戻して|変更を取り消して|手直しを取り消して|アンドゥ(?:して)?)[！!。？?]*$/;

export function detectCheckpointRevertCommand(message: string): 'undo' | 'reset' | null {
  const msg = message.trim();
  if (!msg || SPECIFIC_PART_KEYWORDS.test(msg)) return null;
  if (RESET_SCREEN_RE.test(msg)) return 'reset';
  if (UNDO_SCREEN_RE.test(msg)) return 'undo';
  return null;
}

/**
 * 発言をAIに渡す前の振り分け。
 * 何をどう変えるかがはっきりした改造の指示だけをそのまま改修（apply）に回し、
 * 質問・感想・あいさつ・変え方が決まらない発言は、お助けエージェント（triage）に判断させる。
 * 言い回しは無数にあるため、迷うものは必ず triage 側に倒す。
 */
export function classifyUserMessageIntent(message: string): 'apply' | 'triage' {
  const msg = message.trim();
  if (CHANGE_REQUEST_PATTERN.test(msg) && !QUESTION_PATTERN.test(msg)) {
    return 'apply';
  }
  return 'triage';
}
