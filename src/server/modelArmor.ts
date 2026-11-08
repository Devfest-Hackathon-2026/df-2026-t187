// 学習者の発言を Gemini に送る前に調べ、個人情報らしき内容や、AIへの指示を乗っ取ろうとする入力を止める。
// 1. コードの規則で、メールアドレスと電話番号を見つける。Model Armor がなくても働く
// 2. Model Armor（Sensitive Data Protection と連携）で、個人情報・プロンプトインジェクション・有害な内容を調べる
// 止めた発言は、どこにも保存しない

import { getGcpAccessToken } from './store.ts';
import { describeErrorForLog } from './logSafe.ts';

export type PromptRejectReason = 'personal_info' | 'prompt_injection' | 'harmful';

/** 学習者に返す文。何が引っかかったかだけを伝え、引っかかった文字そのものは繰り返さない */
const REJECT_MESSAGES: Record<PromptRejectReason, string> = {
  personal_info:
    '名前や連絡先など、個人を特定できる情報が含まれているようなので、送りませんでした。その部分を消して、もう一度送ってください。',
  prompt_injection:
    'お助けAIへの決まりを変えようとする内容が含まれているようなので、送りませんでした。画面の直し方や質問を書いてください。',
  harmful: '送れない内容が含まれているようなので、送りませんでした。言い方を変えて、もう一度送ってください。',
};

export class PromptRejectedError extends Error {
  readonly statusCode = 422;
  readonly code = 'input_rejected';
  readonly reason: PromptRejectReason;
  constructor(reason: PromptRejectReason) {
    super(REJECT_MESSAGES[reason]);
    this.name = 'PromptRejectedError';
    this.reason = reason;
  }
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
/** 0 から始まり、区切りを除いて10〜11けたの数字。値段や時刻は 0 から始まらないので当たらない */
const PHONE_CANDIDATE_RE = /(?<![\d０-９])[0０][\d０-９]{1,4}[-‐ー－\s]?[\d０-９]{1,4}[-‐ー－\s]?[\d０-９]{3,4}(?![\d０-９])/g;

/** コードの規則で、メールアドレスと電話番号らしいものがあるかを見る */
export function findPersonalInfoByRules(text: string): boolean {
  if (EMAIL_RE.test(text)) return true;
  for (const m of text.matchAll(PHONE_CANDIDATE_RE)) {
    const digits = m[0].replace(/[^\d０-９]/g, '');
    if (digits.length === 10 || digits.length === 11) return true;
  }
  return false;
}

interface FilterResultShape {
  matchState?: string;
  inspectResult?: { matchState?: string };
}

/** Model Armor の結果から、どのフィルタに引っかかったかを読む */
export function reasonFromModelArmorResult(result: unknown): PromptRejectReason | null {
  const sanitization = (result as { sanitizationResult?: Record<string, unknown> })?.sanitizationResult;
  if (!sanitization || sanitization.filterMatchState !== 'MATCH_FOUND') return null;
  const filters = (sanitization.filterResults ?? {}) as Record<string, Record<string, FilterResultShape>>;
  const matched = (key: string, inner: string) => {
    const r = filters[key]?.[inner];
    return r?.matchState === 'MATCH_FOUND' || r?.inspectResult?.matchState === 'MATCH_FOUND';
  };
  if (matched('sdp', 'sdpFilterResult')) return 'personal_info';
  if (matched('pi_and_jailbreak', 'piAndJailbreakFilterResult')) return 'prompt_injection';
  // 有害な内容・危険なURLなど、そのほかのフィルタ
  return 'harmful';
}

/**
 * Model Armor で発言を調べる。設定がないとき、通信に失敗したときは null（調べられなかった）を返す。
 * 調べられなかったときも体験は止めず、コードの規則による確認だけで進める
 */
async function screenWithModelArmor(text: string): Promise<PromptRejectReason | null> {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.MODEL_ARMOR_LOCATION;
  const templateId = process.env.MODEL_ARMOR_TEMPLATE_ID;
  if (!project || project === 'your-gcp-project-id' || !location || !templateId) return null;
  try {
    const token = await getGcpAccessToken();
    if (!token) return null;
    const url = `https://modelarmor.${encodeURIComponent(location)}.rep.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/templates/${encodeURIComponent(templateId)}:sanitizeUserPrompt`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        userPromptData: { text: text.slice(0, 4000) },
        // 日本語の発言なので、言語を自動で見分けて調べてもらう
        multiLanguageDetectionMetadata: { enableMultiLanguageDetection: true },
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.warn('[modelArmor] 調べられなかったため、規則による確認だけで進めます:', `status=${res.status}`);
      return null;
    }
    return reasonFromModelArmorResult(await res.json());
  } catch (err) {
    console.warn('[modelArmor] 調べられなかったため、規則による確認だけで進めます:', describeErrorForLog(err));
    return null;
  }
}

/** 発言を Gemini に送ってよいかを確かめ、止めるときは PromptRejectedError を投げる */
export async function assertPromptAllowed(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (findPersonalInfoByRules(trimmed)) throw new PromptRejectedError('personal_info');
  const reason = await screenWithModelArmor(trimmed);
  if (reason) throw new PromptRejectedError(reason);
}
