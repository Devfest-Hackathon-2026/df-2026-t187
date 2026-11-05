import { GoogleGenAI, Type, type FunctionDeclaration, type Schema, type ThinkingLevel } from '@google/genai';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTIVE_THEME, getReviewersByCohort } from '../shared/initialTheme.ts';
import { hasCompletionAction } from '../shared/appRuntime.ts';
import { buildOwnerChangeReaction, buildOwnerReport } from '../shared/owner.ts';
import {
  simulatePersonaComputerUse,
  validateSandboxSpec,
} from '../shared/sandboxValidator.ts';
import { applySpecPatches } from '../shared/specPatch.ts';
import type {
  AppComponent,
  ApplyRequest,
  ApplyResponse,
  AppSpec,
  ChatHistoryEntry,
  ChatRequest,
  ChatResponse,
  EvaluateRequest,
  EvaluationResponse,
  HumanDecisionRecord,
  RecordDecisionRequest,
  RecordDecisionResponse,
  ReviewerEvaluation,
  SpecPatch,
} from '../shared/types.ts';
import { saveHumanDecision } from './store.ts';

let envLoaded = false;

// ローカルの .env / .env.local を外部パッケージなしで初回のみ読み込む
function loadLocalEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  for (const file of ['.env.local', '.env']) {
    const fullPath = resolve(process.cwd(), file);
    if (!existsSync(fullPath)) continue;
    try {
      const content = readFileSync(fullPath, 'utf-8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (!(key in process.env) && val) {
          process.env[key] = val;
        }
      }
    } catch {
      // 読み込み失敗時は無視
    }
  }
}

loadLocalEnv();

let cachedClientInfo: {
  cacheKey: string;
  client: GoogleGenAI;
  model: string;
  mode: string;
} | null = null;

type GenAIClientInfo = { client: GoogleGenAI; model: string; mode: string };

/** Gemini の接続先（APIキー または Google Cloud プロジェクト）が未設定のときに投げるエラー */
export class AiNotConfiguredError extends Error {
  readonly statusCode = 503;
  constructor() {
    super(
      'Gemini の接続設定がありません。.env.local に GEMINI_API_KEY または GOOGLE_CLOUD_PROJECT を設定してください。',
    );
    this.name = 'AiNotConfiguredError';
  }
}

function createGenAIClient(): GenAIClientInfo | null {
  loadLocalEnv();
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const apiKey = process.env.GEMINI_API_KEY;
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'global';

  if (apiKey) {
    const cacheKey = `key:${apiKey}:${model}`;
    if (cachedClientInfo?.cacheKey !== cacheKey) {
      cachedClientInfo = {
        cacheKey,
        client: new GoogleGenAI({ apiKey }),
        model,
        mode: 'gemini-api-key',
      };
    }
    return cachedClientInfo;
  }
  if (project && project !== 'your-gcp-project-id') {
    const cacheKey = `vertex:${project}:${location}:${model}`;
    if (cachedClientInfo?.cacheKey !== cacheKey) {
      cachedClientInfo = {
        cacheKey,
        client: new GoogleGenAI({
          vertexai: true,
          project,
          location,
        }),
        model,
        mode: `Gemini Enterprise Agent Platform (${project}/${location})`,
      };
    }
    return cachedClientInfo;
  }
  return null;
}

function requireGenAIClient(): GenAIClientInfo {
  const info = createGenAIClient();
  if (!info) {
    throw new AiNotConfiguredError();
  }
  return info;
}

/**
 * Gemini が答えを考える量。どの呼び出しも短い構造化データを返すだけなので、既定は LOW にする。
 * 計測では既定の設定に比べて、改修の正確さは変わらずに待ち時間が数分の1に縮み、ばらつきも小さくなった。
 * GEMINI_THINKING_LEVEL で変えられ、空文字にするとモデルの既定に任せる（考える量を指定できないモデル向け）。
 */
function thinkingConfig(): { thinkingConfig?: { thinkingLevel: ThinkingLevel } } {
  const level = process.env.GEMINI_THINKING_LEVEL ?? 'LOW';
  return level ? { thinkingConfig: { thinkingLevel: level as ThinkingLevel } } : {};
}

const MAX_HISTORY_ENTRIES = 12;

/** 直近の会話をプロンプト用の文字列にする */
function formatHistory(history: ChatHistoryEntry[] | undefined): string {
  const recent = (history ?? []).slice(-MAX_HISTORY_ENTRIES);
  if (recent.length === 0) return 'なし';
  return recent.map((h) => `${h.speaker}: ${h.text}`).join('\n');
}

function parseJsonResponse<T>(text: string | undefined, label: string): T {
  if (!text) {
    throw new Error(`AIの応答が空でした (${label})`);
  }
  return JSON.parse(text) as T;
}

export function getAiConnectionStatus(): { configured: boolean; mode: string; model: string } {
  const info = createGenAIClient();
  if (!info) {
    return {
      configured: false,
      mode: '未設定',
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    };
  }
  return {
    configured: true,
    mode: info.mode,
    model: info.model,
  };
}

function extractBase64Png(dataUrl?: string): string | null {
  if (!dataUrl) return null;
  const prefix = 'base64,';
  const idx = dataUrl.indexOf(prefix);
  if (idx !== -1) {
    return dataUrl.slice(idx + prefix.length);
  }
  return dataUrl;
}

// 企画書 2章「関数呼び出しによる判断の記録 (Own the Why)」用 Function Declaration
const RECORD_HUMAN_DECISION_DECLARATION: FunctionDeclaration = {
  name: 'record_human_decision',
  description:
    '学習者が決めた顧客層・画面の改造指示・レビュー指摘の採否と、その理由を構造化して記録する。',
  parameters: {
    type: Type.OBJECT,
    properties: {
      stage: {
        type: Type.STRING,
        enum: ['select_cohort', 'apply_change', 'review_disposition'],
        description: '判断を行ったフェーズ',
      },
      targetId: {
        type: Type.STRING,
        description: '選択対象のID（顧客層ID・改造した部品ID・レビュアーID）',
      },
      chosenLabel: {
        type: Type.STRING,
        description: '人間が選んだ方針の表示名',
      },
      reason: {
        type: Type.STRING,
        description: 'なぜその選択をしたかの人間自身の理由',
      },
    },
    required: ['stage', 'targetId', 'chosenLabel', 'reason'],
  },
};

/**
 * 学習者の判断（顧客層選択・トレードオフ選択・レビュー採否）を Gemini Function Calling で構造化記録する。
 */
export async function recordHumanDecisionWithFunctionCalling(
  req: RecordDecisionRequest,
): Promise<RecordDecisionResponse> {
  const aiInfo = createGenAIClient();
  let recordedVia: 'gemini_function_call' | 'local_function_call' = 'local_function_call';
  // 理由は任意。空のまま記録し、AIが勝手に理由を補わないようにする
  const originalReason = (req.reason ?? '').trim();
  let normalizedReason = originalReason;

  if (aiInfo) {
    try {
      const response = await aiInfo.client.models.generateContent({
        model: aiInfo.model,
        contents: [
          '学習者がアプリ改造スタジオで以下の判断を行いました。関数 record_human_decision を呼び出して判断と理由をそのまま記録してください。人間の判断を上書きしないでください。',
          `フェーズ: ${req.stage}`,
          `対象ID: ${req.targetId}`,
          `選んだ内容: ${req.chosenLabel}`,
          `学習者の理由: ${originalReason || 'なし'}`,
        ].join('\n'),
        config: {
          tools: [{ functionDeclarations: [RECORD_HUMAN_DECISION_DECLARATION] }],
          temperature: 0,
          ...thinkingConfig(),
        },
      });

      const fnCall = response.functionCalls?.[0];
      if (fnCall && fnCall.name === 'record_human_decision') {
        recordedVia = 'gemini_function_call';
        const args = fnCall.args as Record<string, unknown> | undefined;
        if (originalReason && args && typeof args.reason === 'string' && args.reason.trim()) {
          normalizedReason = args.reason.trim();
        }
      }
    } catch (err) {
      // 判断の記録はAIの成否に左右されないよう、AI呼び出しに失敗しても人間の入力どおりに保存する
      console.error('[gemini:functionCall] AI経由の記録に失敗したため入力どおりに保存します:', err);
    }
  }

  const decision: HumanDecisionRecord = {
    id: `dec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    stage: req.stage,
    targetId: req.targetId,
    chosenLabel: req.chosenLabel,
    reason: normalizedReason,
    recordedVia,
    createdAt: new Date().toISOString(),
  };

  const { persistedToFirestore } = await saveHumanDecision(decision);
  return {
    decision,
    persistedToFirestore,
  };
}

const EVALUATE_COMMENTS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    comments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          reviewerId: { type: Type.STRING },
          frictionPoint: {
            type: Type.STRING,
            description: 'どこで迷ったか・何が良かったかの短い要点（18文字以内）',
          },
          comment: {
            type: Type.STRING,
            description: 'ペルソナ本人になりきった一言感想（30文字以内、直し方や改善指示は絶対に言わない）',
          },
        },
        required: ['reviewerId', 'frictionPoint', 'comment'],
      },
    },
  },
  required: ['comments'],
};

const CONDITION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    stateKey: { type: Type.STRING },
    operator: { type: Type.STRING, enum: ['eq', 'neq', 'gt', 'lt'] },
    value: { type: Type.STRING },
  },
  required: ['stateKey', 'operator', 'value'],
};

const COMPONENT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    id: { type: Type.STRING },
    type: {
      type: Type.STRING,
      enum: [
        'heading',
        'text',
        'product_hero',
        'product_card',
        'progress_steps',
        'choice_cards',
        'summary',
        'input',
        'select',
        'checkbox',
        'toggle',
        'slider',
        'button',
        'status_banner',
        'popup',
      ],
    },
    role: {
      type: Type.STRING,
      enum: [
        'primary_action',
        'decoy',
        'danger',
        'required_input',
        'distraction',
        'trap',
        'total',
        'popup',
        'info',
      ],
    },
    label: { type: Type.STRING },
    icon: { type: Type.STRING },
    badge: { type: Type.STRING },
    caption: { type: Type.STRING },
    priceLabel: { type: Type.STRING },
    optionDetails: { type: Type.ARRAY, items: { type: Type.STRING } },
    rows: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          value: { type: Type.STRING },
        },
        required: ['label', 'value'],
      },
    },
    placeholder: { type: Type.STRING },
    options: { type: Type.ARRAY, items: { type: Type.STRING } },
    stateKey: { type: Type.STRING },
    style: {
      type: Type.OBJECT,
      properties: {
        size: { type: Type.STRING, enum: ['xs', 'sm', 'md', 'lg', 'xl'] },
        variant: {
          type: Type.STRING,
          enum: ['default', 'primary', 'danger', 'warning', 'success', 'muted'],
        },
        align: { type: Type.STRING, enum: ['left', 'center', 'right'] },
        fullWidth: { type: Type.BOOLEAN },
        noisyAnimation: { type: Type.BOOLEAN },
        rotateDeg: { type: Type.NUMBER },
        numberFormat: { type: Type.STRING, enum: ['arabic', 'kanji'] },
        sticky: { type: Type.BOOLEAN },
        skin: { type: Type.STRING, enum: ['native', 'intrusive'] },
      },
      required: ['size', 'variant'],
    },
    behavior: {
      type: Type.OBJECT,
      properties: {
        effect: {
          type: Type.STRING,
          enum: ['none', 'escape_on_hover', 'require_3_clicks', 'confirm_dialog'],
        },
        confirmText: { type: Type.STRING },
      },
      required: ['effect'],
    },
    visibleWhen: CONDITION_SCHEMA,
    trapWhen: CONDITION_SCHEMA,
    trapSafeValue: { type: Type.STRING },
    popupDelayMs: {
      type: Type.OBJECT,
      properties: {
        min: { type: Type.NUMBER },
        max: { type: Type.NUMBER },
      },
      required: ['min', 'max'],
    },
    actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: {
            type: Type.STRING,
            enum: [
              'set_state',
              'toggle_state',
              'increment_state',
              'reset_all',
              'show_toast',
              'open_page',
              'complete_task',
            ],
          },
          targetKey: { type: Type.STRING },
          value: { type: Type.STRING },
          message: { type: Type.STRING },
        },
        required: ['type'],
      },
    },
  },
  required: ['id', 'type', 'role', 'label', 'style', 'actions'],
};

const PATCH_ITEM_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    op: {
      type: Type.STRING,
      enum: [
        'remove_component',
        'replace_component',
        'insert_component',
        'move_component',
        'upsert_state',
        'upsert_derived',
      ],
    },
    id: {
      type: Type.STRING,
      description: 'remove_component または move_component の対象部品ID',
    },
    afterId: {
      type: Type.STRING,
      description: 'insert_component または move_component で直前に置く部品ID。先頭に置くときは空文字',
    },
    component: COMPONENT_SCHEMA,
    variable: {
      type: Type.OBJECT,
      properties: {
        key: { type: Type.STRING },
        label: { type: Type.STRING },
        type: { type: Type.STRING, enum: ['string', 'number', 'boolean'] },
        initialValue: { type: Type.STRING },
      },
      required: ['key', 'label', 'type', 'initialValue'],
    },
    key: {
      type: Type.STRING,
      description: 'upsert_derived の計算値キー',
    },
    expression: {
      type: Type.STRING,
      description: 'upsert_derived の計算式',
    },
  },
  required: ['op'],
};

export const APPLY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    commitMessage: {
      type: Type.STRING,
      description: '何を変えたかを「〜しました」で終わる1文。30文字以内、括弧なし',
    },
    patches: {
      type: Type.ARRAY,
      description: '変更する部品や状態に対する最小限の差分操作リスト。触らない部品は一切含めない',
      items: PATCH_ITEM_SCHEMA,
    },
  },
  required: ['commitMessage', 'patches'],
};

export function normalizeUpdatedSpec(rawSpec: AppSpec, previousSpec: AppSpec): AppSpec {
  const normalizedState = (rawSpec.state || previousSpec.state).map((s) => {
    let initialValue: string | number | boolean = s.initialValue;
    if (s.type === 'boolean') {
      initialValue = s.initialValue === true || s.initialValue === 'true';
    } else if (s.type === 'number') {
      const n = Number(s.initialValue);
      initialValue = Number.isFinite(n) ? n : 0;
    } else {
      initialValue = String(s.initialValue ?? '');
    }
    return { ...s, initialValue };
  });

  // 計算値の型は分からないため、数値として読めれば数値、true/false なら真偽値として扱う
  const stateTypeMap = new Map(normalizedState.map((s) => [s.key, s.type]));

  const coerceByStateKey = (key: string | undefined, val: unknown): string | number | boolean => {
    const t = key ? stateTypeMap.get(key) : undefined;
    if (t === 'boolean' || val === 'true' || val === 'false' || typeof val === 'boolean') {
      return val === true || val === 'true';
    }
    if (t === 'number' || (t === undefined && val !== '' && Number.isFinite(Number(val)))) {
      const n = Number(val);
      return Number.isFinite(n) ? n : 0;
    }
    return String(val ?? '');
  };

  const coerceCondition = (cond: AppComponent['visibleWhen']) =>
    cond ? { ...cond, value: coerceByStateKey(cond.stateKey, cond.value) } : undefined;

  const normalizedComponents: AppComponent[] = (rawSpec.components || []).map((c) => {
    const visibleWhen = coerceCondition(c.visibleWhen);
    const trapWhen = coerceCondition(c.trapWhen);
    const actions = (c.actions || []).map((a) => ({
      ...a,
      ...(a.value !== undefined ? { value: coerceByStateKey(a.targetKey, a.value) } : {}),
    }));

    const normalized: AppComponent = {
      ...c,
      role: c.role ?? 'info',
      actions,
    };
    if (visibleWhen) normalized.visibleWhen = visibleWhen;
    else delete normalized.visibleWhen;
    if (trapWhen) normalized.trapWhen = trapWhen;
    else delete normalized.trapWhen;
    if (c.trapSafeValue !== undefined) {
      normalized.trapSafeValue = coerceByStateKey(c.stateKey, c.trapSafeValue);
    }
    return normalized;
  });

  return {
    ...rawSpec,
    state: normalizedState,
    derived: rawSpec.derived ?? previousSpec.derived,
    components: normalizedComponents,
  };
}

/**
 * Gemini が返した差分パッチを現在の仕様に適用し、正規化・整合性検証・店長のリアクション生成を行う。
 */
export function applyPatchesToSpecWithValidation(
  currentSpec: AppSpec,
  commitMessage: string,
  rawPatches: SpecPatch[],
): Omit<ApplyResponse, 'decisionRecord'> {
  if (!Array.isArray(rawPatches) || rawPatches.length === 0) {
    return {
      commitMessage: 'どこをどう変えるか、もう少し詳しく教えてください',
      updatedSpec: structuredClone(currentSpec),
      patches: [],
      rolledBack: true,
      validation: {
        valid: false,
        canRenderHtml: true,
        hasTaskCompletionEvent: false,
        errors: ['変更差分が空でした'],
      },
    };
  }

  const { spec: patchedSpec, touchedComponentIds } = applySpecPatches(currentSpec, rawPatches);
  const updatedSpec = normalizeUpdatedSpec(patchedSpec, currentSpec);

  const prevHadCompletion = currentSpec.components.some(
    (c) => c.type === 'button' && hasCompletionAction(c),
  );
  const touchedPrimaryButton = currentSpec.components.some(
    (c) => c.role === 'primary_action' && touchedComponentIds.has(c.id),
  );

  const validation = validateSandboxSpec(updatedSpec, {
    requireTaskCompletionEvent: prevHadCompletion || touchedPrimaryButton,
    previousSpec: currentSpec,
    touchedComponentIds,
  });

  if (!validation.valid) {
    console.warn('[gemini:apply] 検証失敗のためロールバックします:', validation.errors);
    return {
      commitMessage: 'うまく動かなかったので元に戻しました',
      updatedSpec: structuredClone(currentSpec),
      patches: rawPatches,
      validation,
      rolledBack: true,
    };
  }

  const ownerReaction = buildOwnerChangeReaction(ACTIVE_THEME.owner, currentSpec, updatedSpec);

  return {
    commitMessage,
    updatedSpec,
    patches: rawPatches,
    ownerReaction,
    validation,
    rolledBack: false,
  };
}

/**
 * 実装AI:
 * 人間が指示した変更内容だけで、最小限の差分パッチ（patches）を生成してアプリを更新する。
 * 触っていない部品は一切変更せず、検証失敗時は直前の版へ自動ロールバックする。
 */
export async function applyOptionToSpec(req: ApplyRequest): Promise<ApplyResponse> {
  const aiInfo = requireGenAIClient();
  const reason = req.selectionReason?.trim() ?? '';
  const targetComponents = req.currentSpec.components.filter((c) =>
    req.targetComponentIds.includes(c.id),
  );
  const chosenLabel = req.userInstruction;
  const targetId =
    req.targetComponentIds.length > 0 ? req.targetComponentIds.join(',') : 'chat_instruction';

  const decisionPromise = recordHumanDecisionWithFunctionCalling({
    stage: 'apply_change',
    targetId,
    chosenLabel,
    reason,
    cohortId: req.cohortId,
  }).then((r) => r.decision);

  const prompt = [
    'あなたは開発スタジオの実装AI（お助けエージェント）です。人間が指示した変更だけに従って、最小限の差分操作（patches）を返してください。自分の勝手なアイデアは足さないでください。',
    '【差分操作（patches）の絶対ルール】',
    '1. 変更しない部品は patches に一切含めないでください。元の部品の型（product_card, choice_cards, summary, progress_steps など）を勝手に select や text 等の別部品へ作り変えないでください。',
    '2. 使える操作 op は次の6つだけです：',
    '   - remove_component: 部品を消す（id を指定）',
    '   - replace_component: 既存の部品1つを同じ id のまま書き換える（component に更新後の部品全体を指定。badge, caption, priceLabel, optionDetails, rows, style.sticky 等の元の設定を勝手に消さないこと）',
    '   - insert_component: 新しい部品を追加する（afterId に直前の部品ID、component に新しい部品を指定）',
    '   - move_component: 部品の位置を動かす（id と afterId を指定）',
    '   - upsert_state: 状態変数を追加または初期値を変更する（variable を指定。チェックボックスなどの最初の状態を変えるときは、その部品の stateKey の initialValue を変える）',
    '   - upsert_derived: 計算式を追加または変更する（key と expression を指定）',
    '3. 画面の見た目だけでなく、裏側の処理（actions, behavior, state, visibleWhen）も整合するように更新してください。',
    '4. 押しても何も起きない本物のボタン（role が primary_action で actions が空）を動くように直すときは、replace_component でその部品の actions に complete_task を設定してください。style.sticky など元の見た目の設定はそのまま残してください。',
    ...ACTIVE_THEME.implementerNotes.map((note, i) => `${i + 5}. ${note}`),
    `${ACTIVE_THEME.implementerNotes.length + 5}. commitMessage は何を変えたかを「〜しました」で終わる1文、30文字以内で書いてください。括弧・記号・英語は使わないでください。`,
    '',
    `【現在のアプリ仕様】\n${JSON.stringify(req.currentSpec)}`,
    `【赤ペンで囲まれた話題の部品】\n${
      targetComponents.length > 0 ? JSON.stringify(targetComponents) : '特定の部品は指していません'
    }`,
    `【直近の会話】\n${formatHistory(req.history)}`,
    `【人間の改造指示】\n${req.userInstruction}`,
    reason ? `【人間がこの改造を選んだ理由】\n${reason}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
  ];
  const b64 = extractBase64Png(req.annotatedImageBase64);
  if (b64) {
    parts.push({
      inlineData: {
        mimeType: 'image/png',
        data: b64,
      },
    });
  }

  const specUpdatePromise = aiInfo.client.models
    .generateContent({
      model: aiInfo.model,
      contents: parts,
      config: {
        responseMimeType: 'application/json',
        responseSchema: APPLY_SCHEMA,
        temperature: 0.2,
        ...thinkingConfig(),
      },
    })
    .then((response) => {
      const parsed = parseJsonResponse<{ commitMessage: string; patches: SpecPatch[] }>(
        response.text,
        'apply',
      );
      return applyPatchesToSpecWithValidation(
        req.currentSpec,
        parsed.commitMessage,
        parsed.patches,
      );
    });

  const [decisionRecord, candidate] = await Promise.all([decisionPromise, specUpdatePromise]);

  return {
    ...candidate,
    decisionRecord,
  };
}

/**
 * レビューAI:
 * 改修意図も議論も一切知らず、画面と Computer Use 実操作シミュレーション結果（制約変数適用済み）のみを受け取る。
 * 達成/離脱はアプリのタスク完了イベントでコード判定し、Geminiは各ペルソナの感想の言葉だけを担う（直し方は言わない）。
 */
export async function evaluateAppWithPersonas(req: EvaluateRequest): Promise<EvaluationResponse> {
  const aiInfo = requireGenAIClient();
  const reviewers = getReviewersByCohort(req.cohortId);

  // 1. まずコード側で、各ペルソナの制約変数（視力ぼかし・指のズレ・手数上限・待てる時間）をかけた
  //    Computer Use 実操作シミュレーションを実行し、タスク完了イベント発火の有無で達成/離脱を確定する。
  const simMap = new Map(
    reviewers.map((persona) => [
      persona.id,
      simulatePersonaComputerUse(req.currentSpec, persona, req.componentBounds),
    ]),
  );

  const simulationSummary = reviewers.map((p) => {
    const sim = simMap.get(p.id)!;
    return {
      reviewerId: p.id,
      name: p.name,
      role: p.role,
      trait: p.traitLabel,
      appliedConstraints: sim.appliedConstraintNote,
      actionTrace: sim.actionTrace,
      codeDeterminedOutcome: sim.outcome,
    };
  });

  const prompt = [
    `あなたは${ACTIVE_THEME.appName}で${ACTIVE_THEME.taskLabel}ことを試した3人の顧客です。改修の意図やこれまでの議論は一切知りません。`,
    '各顧客が実際に画面を操作したログと結果（codeDeterminedOutcome）に基づき、本人になりきった感想（comment）と困った点・良かった点（frictionPoint）を生成してください。',
    '結果は achieved が達成、abandoned が途中でやめた、regretted が完了はできたが余計な契約などにあとで気づいて後悔した、です。regretted の人は、あとから気づいたがっかりした気持ちを話してください。',
    '',
    '【絶対ルール：短く・直し方は絶対に言わない・括弧は使わない】',
    '1. comment は30文字以内の、独り言のような自然な話し言葉にしてください。',
    '2. frictionPoint は18文字以内で要点だけ書いてください。',
    '3. こう直してほしい・ボタンを大きくして等の改善指示は絶対に言わず、自分が体験した感想だけを述べてください。',
    '',
    `【操作ログと判定結果】\n${JSON.stringify(simulationSummary)}`,
  ].join('\n');

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
  ];
  const b64 = extractBase64Png(req.screenshotBase64);
  if (b64) {
    parts.push({
      inlineData: {
        mimeType: 'image/png',
        data: b64,
      },
    });
  }

  const response = await aiInfo.client.models.generateContent({
    model: aiInfo.model,
    contents: parts,
    config: {
      responseMimeType: 'application/json',
      responseSchema: EVALUATE_COMMENTS_SCHEMA,
      temperature: 0.4,
      ...thinkingConfig(),
    },
  });

  const parsed = parseJsonResponse<{
    comments: Array<{ reviewerId: string; frictionPoint: string; comment: string }>;
  }>(response.text, 'evaluate');

  const results: ReviewerEvaluation[] = reviewers.map((p) => {
    const sim = simMap.get(p.id)!;
    const aiComment = parsed.comments.find((c) => c.reviewerId === p.id);
    return {
      reviewerId: p.id,
      // 達成/離脱はコード側のタスク完了イベント判定を厳守し、AIが甘く判定するのを防ぐ
      outcome: sim.outcome,
      // AIが特定の人の感想を返し忘れた場合は、シミュレーターが記録した体験をそのまま使う
      frictionPoint: aiComment?.frictionPoint || sim.frictionPoint,
      comment: aiComment?.comment || sim.simulatedComment,
      actionTrace: sim.actionTrace,
      appliedConstraintNote: sim.appliedConstraintNote,
    };
  });

  // お店の側の結果（注文数や、題材で決めた数字）はコードで数え、店長の一言にする
  const owner = buildOwnerReport(
    ACTIVE_THEME.owner,
    req.currentSpec,
    reviewers.map((p) => ({
      outcome: simMap.get(p.id)!.outcome,
      finalState: simMap.get(p.id)!.finalState,
    })),
  );

  return {
    evaluatedAt: new Date().toISOString(),
    cohortId: req.cohortId,
    results,
    owner,
  };
}

const QUESTION_PATTERN =
  /なぜ|なんで|どうして|どうなって|どうすれば|どうしたら|何から|何これ|なにこれ|何の|しくみ|仕組み|教えて|説明|意味|とは|原因|どこ|だれ|誰|べき|[?？]$/;
const CHANGE_REQUEST_PATTERN =
  /(直|消|外|変え|足|加え|入れ|作|動か|移|並べ替え|まとめ|大きく|小さく|目立たなく|戻)(して|す|る|したい|しておいて|ておいて)|改造して|ほしい|にして/;

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

const TRIAGE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      enum: ['question', 'change', 'unclear'],
      description:
        'question は画面や部品について聞いている、change は何をどう変えるかが1通りに決まる改造の指示、unclear は感想・不満・あいさつや、変え方が何通りも考えられる発言',
    },
    reply: {
      type: Type.STRING,
      description:
        'question なら仕様にある事実だけの説明とどう変えたいかの問いかけ、unclear なら受け止めとどう変えるかの聞き返し。change なら空文字。70文字以内、括弧なし',
    },
    pointedComponentIds: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        '学習者が自分で指した部品のID。赤ペンで囲んだ部品、発言で名前や見た目を挙げた部品、直前に自分で押して画面通知が出た部品だけ。お客さんの発言にだけ出てくる部品は含めない',
    },
    suggestedFollowUps: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'pointedComponentIds の部品をどう変えるかの具体的な短い指示を2個、各14文字以内。方向性の異なる2つにする。指した部品がないときと change のときは空配列',
    },
  },
  required: ['intent', 'reply', 'pointedComponentIds', 'suggestedFollowUps'],
};

async function applyFromChat(req: ChatRequest): Promise<ChatResponse> {
  const applied = await applyOptionToSpec({
    currentSpec: req.currentSpec,
    targetComponentIds: req.targetComponentIds,
    userInstruction: req.userMessage,
    cohortId: req.cohortId,
    annotatedImageBase64: req.annotatedImageBase64,
    history: req.history,
  });
  return {
    intent: 'apply',
    reply: applied.commitMessage,
    suggestedFollowUps: [],
    applied,
  };
}

/**
 * 自由対話の入口。
 * - はっきりした改造の指示は、改造案カードを出さずに差分パッチ（applyOptionToSpec）を適用して結果を返す。
 * - それ以外はお助けエージェントが1回の呼び出しで、質問・改造・曖昧な発言のどれかを判断する。
 *   質問には仕様にある事実だけで答え、曖昧な発言にはどう変えるかを聞き返す。改造と判断したら改修に進む。
 */
export async function chatWithStudio(req: ChatRequest): Promise<ChatResponse> {
  if (classifyUserMessageIntent(req.userMessage) === 'apply') {
    return applyFromChat(req);
  }

  const aiInfo = requireGenAIClient();
  const targets = req.currentSpec.components.filter((c) =>
    req.targetComponentIds.includes(c.id),
  );
  const componentFacts = req.currentSpec.components.map((c) => ({
    id: c.id,
    type: c.type,
    role: c.role,
    label: c.label,
    stateKey: c.stateKey,
    actions: c.actions,
    behavior: c.behavior,
    trapWhen: c.trapWhen,
    size: c.style.size,
    skin: c.style.skin,
  }));

  const prompt = [
    `あなたは開発スタジオの進行役・実装担当であるお助けエージェントです。ユーザーが${ACTIVE_THEME.appName}についてチャットで発言しました。`,
    '【まず発言を次の3つのどれかに分けてください】',
    '- question: 画面や部品の仕組み・原因・お客さんの反応について聞いている。',
    '- change: 何をどう変えるかが1通りに決まる改造の指示。例：広告を消して、注文ボタンを動くように直す。',
    '- unclear: 感想・不満・あいさつ・相づち、または変え方が何通りも考えられる発言。例：赤いボタンが邪魔、うーん、使いにくい。',
    '迷ったら unclear にしてください。勝手に変え方を決めて change にしないでください。',
    '【question のときの絶対ルール】',
    '1. 画面の現在の仕様（componentFacts と state）にある事実だけを根拠に答えてください。',
    '   - ボタンの actions が空配列 [] の場合は、押しても何も起きない壊れた設定になっていると事実を伝えてください。お支払い方法が未選択だから等の推測や嘘の説明は絶対にしないでください。',
    '   - role が decoy の部品は押しても何も起きないおとり、role が trap の部品は最初からチェック等が入っている仕掛け、role が popup の部品は時間差で出る広告です。',
    '   - role が info や total の部品、actions が設定された primary_action の部品について聞かれたら、正常に動いている部品だと事実を伝えてください。',
    '   - お客さんの反応について聞かれたら、これまでの会話にあるお客さん本人の発言をそのまま伝えるだけにしてください。どの部品のせいかの解釈は足さないでください。',
    '2. 最後にどう変えたいかを短く尋ねてください。',
    '【unclear のときのルール】',
    '1. 発言を短く受け止め、どこをどう変えたいかを聞き返してください。改造はまだしません。',
    '【どこが悪いかを見つけるのは学習者自身です。ヒントの出し方の絶対ルール】',
    '1. 説明や改造の候補は、学習者が自分で指した部品についてだけ出してください。自分で指した部品とは、赤ペンで囲んだ部品、発言で名前や見た目を挙げた部品、直前に自分で押して画面通知が出た部品です。',
    '2. 学習者が何も指していないときは、どの部品が悪いか・どこを直すべきかを一切言わないでください。左のスマホで実際に買ってみるか、気になるところを赤ペンで囲むよう短く促すだけにし、suggestedFollowUps は空配列にしてください。',
    '3. 画面全体の問題点を挙げたり、まだ話題に出ていない部品を勧めたりしないでください。',
    '【共通のルール】',
    '1. 誰が喜ぶか・誰が困るかといったお客さんや店長の気持ちの先回り代弁や、それっぽい一般論は一切言わないでください（反応はお客さんや店長本人が言います）。',
    '2. suggestedFollowUps は、指した部品をどう変えるかの、ユーザーがそのまま押して改造を指示できる短い言葉を2個にしてください。形は「〇〇を消す」「〇〇を小さくする」のようにします。2つとも実際に画面を変える指示にし、「そのままにする」のような変えない選択肢は入れないでください。',
    '3. 若年層のチャットのように読みやすくするため、1文は35文字以内で短く区切り、合計2文以内（70文字以内）・括弧なしにしてください。',
    '4. change のときは reply を空文字、suggestedFollowUps を空配列にしてください。',
    '',
    `【話題の部品】\n${targets.length > 0 ? JSON.stringify(targets) : '特定の部品は指していません'}`,
    `【画面にある全部品の実際の仕様】\n${JSON.stringify(componentFacts)}`,
    `【現在の状態初期値】\n${JSON.stringify(req.currentSpec.state)}`,
    `【これまでの会話と画面通知】\n${formatHistory(req.history)}`,
    `【ユーザーの発言】\n${req.userMessage}`,
  ].join('\n');

  const response = await aiInfo.client.models.generateContent({
    model: aiInfo.model,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: TRIAGE_SCHEMA,
      temperature: 0.3,
      ...thinkingConfig(),
    },
  });

  const parsed = parseJsonResponse<{
    intent: 'question' | 'change' | 'unclear';
    reply: string;
    pointedComponentIds?: string[];
    suggestedFollowUps?: string[];
  }>(response.text, 'triage');

  if (parsed.intent === 'change') {
    return applyFromChat(req);
  }

  // 学習者が何も指していないのに直す候補を出すと、どこが悪いかの答えを教えてしまう。
  // 赤ペンで囲んだ部品も、AIが「指した」と判断した実在の部品もなければ候補は出さない
  const existingIds = new Set(req.currentSpec.components.map((c) => c.id));
  const pointed =
    req.targetComponentIds.length > 0 ||
    (parsed.pointedComponentIds ?? []).some((id) => existingIds.has(id));

  return {
    intent: parsed.intent === 'unclear' ? 'clarify' : 'explain',
    reply: parsed.reply,
    suggestedFollowUps: pointed ? (parsed.suggestedFollowUps ?? []).slice(0, 2) : [],
  };
}
