import { GoogleGenAI, Type, type FunctionDeclaration, type Schema } from '@google/genai';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getReviewersByCohort, TARGET_COHORTS } from '../shared/initialTheme.ts';
import {
  simulatePersonaComputerUse,
  validateSandboxSpec,
} from '../shared/sandboxValidator.ts';
import type {
  AppComponent,
  ApplyRequest,
  ApplyResponse,
  AppSpec,
  ChatRequest,
  ChatResponse,
  EvaluateRequest,
  EvaluationResponse,
  HumanDecisionRecord,
  InspectedComponentInfo,
  ProposeRequest,
  ProposeResponse,
  RecordDecisionRequest,
  RecordDecisionResponse,
  ReviewerEvaluation,
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

function createGenAIClient(): { client: GoogleGenAI; model: string; mode: string } | null {
  if (process.env.PONKOTSU_FORCE_FALLBACK === '1') {
    return null;
  }
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

export function getAiConnectionStatus(): { configured: boolean; mode: string; model: string } {
  const info = createGenAIClient();
  if (!info) {
    return {
      configured: false,
      mode: 'fallback (API未設定・ローカル検証モード)',
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
    '学習者が決めた顧客層・トレードオフ選択肢・レビュー指摘の採否と、その理由を構造化して記録する。',
  parameters: {
    type: Type.OBJECT,
    properties: {
      stage: {
        type: Type.STRING,
        enum: ['select_cohort', 'select_tradeoff', 'review_disposition'],
        description: '判断を行ったフェーズ',
      },
      targetId: {
        type: Type.STRING,
        description: '選択対象のID（顧客層ID・選択肢ID・レビュアーID）',
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
  let normalizedReason = req.reason.trim() || '直感で選択';

  if (aiInfo) {
    try {
      const response = await aiInfo.client.models.generateContent({
        model: aiInfo.model,
        contents: [
          '学習者がアプリ改造スタジオで以下の判断を行いました。関数 record_human_decision を呼び出して判断と理由をそのまま記録してください。人間の判断を上書きしないでください。',
          `フェーズ: ${req.stage}`,
          `対象ID: ${req.targetId}`,
          `選んだ内容: ${req.chosenLabel}`,
          `学習者の理由: ${normalizedReason}`,
        ].join('\n'),
        config: {
          tools: [{ functionDeclarations: [RECORD_HUMAN_DECISION_DECLARATION] }],
          temperature: 0,
        },
      });

      const fnCall = response.functionCalls?.[0];
      if (fnCall && fnCall.name === 'record_human_decision') {
        recordedVia = 'gemini_function_call';
        const args = fnCall.args as Record<string, unknown> | undefined;
        if (args && typeof args.reason === 'string' && args.reason.trim()) {
          normalizedReason = args.reason.trim();
        }
      }
    } catch (err) {
      console.error('[gemini:functionCall] ローカル関数記録にフォールバックします:', err);
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

const PROPOSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    analysis: {
      type: Type.STRING,
      description: 'ユーザーがペンで囲んだ部品と指摘内容の受け止め（1〜2文）',
    },
    question: {
      type: Type.STRING,
      description: 'トレードオフを踏まえてユーザーに方針決定を促す問いかけ',
    },
    options: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          title: { type: Type.STRING },
          summary: { type: Type.STRING },
          uiChange: { type: Type.STRING },
          logicChange: { type: Type.STRING },
          pros: { type: Type.STRING },
          tradeoff: { type: Type.STRING },
        },
        required: ['id', 'title', 'summary', 'uiChange', 'logicChange', 'pros', 'tradeoff'],
      },
    },
  },
  required: ['analysis', 'question', 'options'],
};

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

const APPLY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    commitMessage: {
      type: Type.STRING,
      description: '履歴に残す簡潔な変更要約',
    },
    changeHighlights: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '画面と裏側の処理で変更した点の箇条書き（2〜3個）',
    },
    updatedSpec: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING },
        title: { type: Type.STRING },
        subtitle: { type: Type.STRING },
        taskDescription: { type: Type.STRING },
        theme: {
          type: Type.OBJECT,
          properties: {
            bgColor: { type: Type.STRING },
            cardColor: { type: Type.STRING },
            textColor: { type: Type.STRING },
            accentColor: { type: Type.STRING },
            chaoticLayout: { type: Type.BOOLEAN },
          },
          required: ['bgColor', 'cardColor', 'textColor', 'accentColor', 'chaoticLayout'],
        },
        state: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              key: { type: Type.STRING },
              label: { type: Type.STRING },
              type: { type: Type.STRING, enum: ['string', 'number', 'boolean'] },
              initialValue: { type: Type.STRING },
            },
            required: ['key', 'label', 'type', 'initialValue'],
          },
        },
        components: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              type: {
                type: Type.STRING,
                enum: [
                  'heading',
                  'text',
                  'clock_display',
                  'input',
                  'select',
                  'toggle',
                  'slider',
                  'button',
                  'quiz_box',
                  'status_banner',
                ],
              },
              label: { type: Type.STRING },
              placeholder: { type: Type.STRING },
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
                },
                required: ['size', 'variant'],
              },
              behavior: {
                type: Type.OBJECT,
                properties: {
                  effect: {
                    type: Type.STRING,
                    enum: [
                      'none',
                      'escape_on_hover',
                      'require_3_clicks',
                      'math_quiz_gate',
                      'confirm_dialog',
                      'play_alarm_sound',
                      'tts_voice_alarm',
                      'vibrate_shake',
                    ],
                  },
                  quizQuestion: { type: Type.STRING },
                  quizAnswer: { type: Type.STRING },
                  confirmText: { type: Type.STRING },
                  voiceText: { type: Type.STRING },
                },
                required: ['effect'],
              },
              visibleWhen: {
                type: Type.OBJECT,
                properties: {
                  stateKey: { type: Type.STRING },
                  operator: { type: Type.STRING, enum: ['eq', 'neq', 'gt', 'lt'] },
                  value: { type: Type.STRING },
                },
                required: ['stateKey', 'operator', 'value'],
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
            required: ['id', 'type', 'label', 'style', 'actions'],
          },
        },
      },
      required: ['id', 'title', 'subtitle', 'taskDescription', 'theme', 'state', 'components'],
    },
  },
  required: ['commitMessage', 'changeHighlights', 'updatedSpec'],
};

function normalizeUpdatedSpec(rawSpec: AppSpec, previousSpec: AppSpec): AppSpec {
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

  const stateTypeMap = new Map(normalizedState.map((s) => [s.key, s.type]));

  const coerceByStateKey = (key: string | undefined, val: unknown): string | number | boolean => {
    const t = key ? stateTypeMap.get(key) : undefined;
    if (t === 'boolean' || val === 'true' || val === 'false') {
      return val === true || val === 'true';
    }
    if (t === 'number') {
      const n = Number(val);
      return Number.isFinite(n) ? n : 0;
    }
    return String(val ?? '');
  };

  const normalizedComponents: AppComponent[] = (rawSpec.components || []).map((c) => {
    const visibleWhen = c.visibleWhen
      ? {
          ...c.visibleWhen,
          value: coerceByStateKey(c.visibleWhen.stateKey, c.visibleWhen.value),
        }
      : undefined;

    const actions = (c.actions || []).map((a) => ({
      ...a,
      ...(a.value !== undefined ? { value: coerceByStateKey(a.targetKey, a.value) } : {}),
    }));

    return {
      ...c,
      ...(visibleWhen ? { visibleWhen } : {}),
      actions,
    };
  });

  return {
    ...rawSpec,
    state: normalizedState,
    components: normalizedComponents,
  };
}

/**
 * ディスカッションAI:
 * ダメ出し（ペン囲み＋指摘）と選んだ顧客層を受け取り、トレードオフを問い返す。
 * コード（updatedSpec）は一切書かない。
 */
export async function proposeTradeoffs(req: ProposeRequest): Promise<ProposeResponse> {
  const aiInfo = createGenAIClient();
  const targetComponents = req.currentSpec.components.filter((c) =>
    req.targetComponentIds.includes(c.id),
  );
  const cohortInfo = TARGET_COHORTS.find((c) => c.id === req.cohortId);
  const cohortPersonas = getReviewersByCohort(req.cohortId);

  if (aiInfo) {
    try {
      const prompt = [
        'あなたはアプリ改造スタジオのディスカッションAIです。コードは書かず、トレードオフを含む3つの選択肢を問い返してください。',
        '【絶対ルール：文字数を短く・専門用語や英語や括弧は使わない】',
        '1. 方向性が異なる3つの作戦（option_a, option_b, option_c）を出してください。',
        '2. 選んだ顧客層の中の3人（それぞれ異なる制約を持つ）にとって誰が喜び、誰にとってどんな弱点があるかを pros / tradeoff に短く書いてください。',
        '3. カギ括弧や丸括弧は使わず、一目で読める短い日本語にしてください。',
        '',
        cohortInfo
          ? `【選んだ顧客層】${cohortInfo.label}（${cohortPersonas.map((p) => `${p.name}:${p.traitLabel}`).join(' / ')}）`
          : `【想定する3人の顧客】${cohortPersonas.map((p) => `${p.name}:${p.traitLabel}`).join(' / ')}`,
        `【ペンで囲まれた部品】\n${
          targetComponents.length > 0 ? JSON.stringify(targetComponents) : '画面全体'
        }`,
        `【ユーザーの指摘】\n${req.userInstruction}`,
      ].join('\n');

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

      const response = await aiInfo.client.models.generateContent({
        model: aiInfo.model,
        contents: parts,
        config: {
          responseMimeType: 'application/json',
          responseSchema: PROPOSE_SCHEMA,
          temperature: 0.7,
        },
      });

      if (response.text) {
        const parsed = JSON.parse(response.text) as Omit<ProposeResponse, 'source'>;
        return {
          source: 'gemini',
          ...parsed,
        };
      }
    } catch (err) {
      console.error('[gemini:propose] Gemini呼び出し失敗、フォールバックを使用します:', err);
    }
  }

  return fallbackPropose(req, targetComponents);
}

/**
 * 実装AI:
 * 人間が決定した仕様（selectedOption ＋ 理由）だけでアプリを書き換える。
 * 自分のアイデアを勝手に足さず、改修後は単一HTML描画＆タスク完了イベント検証を行い、失敗時は直前の版へ自動ロールバックする。
 */
export async function applyOptionToSpec(req: ApplyRequest): Promise<ApplyResponse> {
  const decisionPromise =
    req.selectionReason !== undefined
      ? recordHumanDecisionWithFunctionCalling({
          stage: 'select_tradeoff',
          targetId: req.selectedOption.id,
          chosenLabel: req.selectedOption.title,
          reason: req.selectionReason || req.userInstruction,
          cohortId: req.cohortId,
        }).then((r) => r.decision)
      : Promise.resolve(undefined);

  const aiInfo = createGenAIClient();
  const specUpdatePromise = (async (): Promise<ApplyResponse | null> => {
    if (!aiInfo) return null;
    try {
      const prompt = [
        'あなたは開発スタジオの実装AIです。人間が決定した仕様だけに従って、お題アプリの構造化仕様を更新してください。自分の勝手なアイデアは足さないでください。',
        '【重要なルール】',
        '1. 画面の見た目だけでなく、裏側の処理（actions, behavior, state, visibleWhen）も整合するように更新してください。',
        '2. アラーム予約を完了させるボタンには actions に `{ "type": "set_state", "targetKey": "isAlarmSet", "value": "true" }` と `{ "type": "complete_task", "message": "アラームを予約しました" }` を必ず残してください。',
        '3. 部品箱の組み込み：声や音声読み上げが指示された場合は behavior.effect に `tts_voice_alarm` を設定し、計算クイズは `math_quiz_gate`、逃げるボタンは `escape_on_hover`、3連打は `require_3_clicks` を設定してください。',
        '',
        `【現在のアプリ仕様】\n${JSON.stringify(req.currentSpec)}`,
        `【決定済みの仕様】\n${JSON.stringify(req.selectedOption)}`,
        req.selectionReason ? `【人間がこの仕様を選んだ理由】\n${req.selectionReason}` : '',
      ].join('\n');

      const response = await aiInfo.client.models.generateContent({
        model: aiInfo.model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: APPLY_SCHEMA,
          temperature: 0.3,
        },
      });

      if (response.text) {
        const parsed = JSON.parse(response.text) as Omit<ApplyResponse, 'source'>;
        return {
          source: 'gemini',
          commitMessage: parsed.commitMessage,
          changeHighlights: parsed.changeHighlights,
          updatedSpec: normalizeUpdatedSpec(parsed.updatedSpec, req.currentSpec),
        };
      }
    } catch (err) {
      console.error('[gemini:apply] Gemini呼び出し失敗、フォールバックを使用します:', err);
    }
    return null;
  })();

  const [decisionRecord, aiCandidate] = await Promise.all([decisionPromise, specUpdatePromise]);
  const candidateResponse = aiCandidate ?? fallbackApply(req);

  // サンドボックス検証（単一HTMLとして描画できるか・タスク完了イベントが残っているか）
  const validation = validateSandboxSpec(candidateResponse.updatedSpec, {
    requireTaskCompletionEvent: true,
  });

  if (!validation.valid) {
    // 検証失敗時は直前の版へ自動ロールバック
    return {
      source: candidateResponse.source,
      commitMessage: '検証エラーのため直前の版へ自動ロールバック',
      changeHighlights: [
        `改修コード検証に失敗したため直前の版へ戻しました（${validation.errors.join(' / ')}）`,
      ],
      updatedSpec: structuredClone(req.currentSpec),
      validation,
      rolledBack: true,
      decisionRecord,
    };
  }

  return {
    ...candidateResponse,
    validation,
    rolledBack: false,
    decisionRecord,
  };
}

/**
 * レビューAI:
 * 改修意図も議論も一切知らず、画面と Computer Use 実操作シミュレーション結果（制約変数適用済み）のみを受け取る。
 * 達成/離脱はアプリのタスク完了イベントでコード判定し、Geminiは各ペルソナの感想の言葉だけを担う（直し方は言わない）。
 */
export async function evaluateAppWithPersonas(req: EvaluateRequest): Promise<EvaluationResponse> {
  const reviewers = getReviewersByCohort(req.cohortId);

  // 1. まずコード側で、各ペルソナの制約変数（視力ぼかし・指のズレ・手数上限・待てる時間）をかけた
  //    Computer Use 実操作シミュレーションを実行し、タスク完了イベント発火の有無で達成/離脱を確定する。
  const simMap = new Map(
    reviewers.map((persona) => [
      persona.id,
      simulatePersonaComputerUse(req.currentSpec, persona, req.componentBounds),
    ]),
  );

  const aiInfo = createGenAIClient();

  if (aiInfo) {
    try {
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
        'あなたは目覚まし時計アプリを実際に操作した3人の顧客です。改修の意図やこれまでの議論は一切知りません。',
        '各顧客が実際に画面を操作したログと達成/離脱結果（codeDeterminedOutcome）に基づき、本人になりきった感想（comment）と困った点・良かった点（frictionPoint）を生成してください。',
        '',
        '【絶対ルール：短く・直し方は絶対に言わない・括弧は使わない】',
        '1. comment は30文字以内の自然な話し言葉にしてください。',
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
        },
      });

      if (response.text) {
        const parsed = JSON.parse(response.text) as {
          comments: Array<{ reviewerId: string; frictionPoint: string; comment: string }>;
        };
        const results: ReviewerEvaluation[] = reviewers.map((p) => {
          const sim = simMap.get(p.id)!;
          const aiComment = parsed.comments.find((c) => c.reviewerId === p.id);
          return {
            reviewerId: p.id,
            // 達成/離脱はコード側のタスク完了イベント判定を厳守し、AIが甘く判定するのを防ぐ
            outcome: sim.outcome,
            frictionPoint: aiComment?.frictionPoint || sim.frictionPoint,
            comment: aiComment?.comment || sim.fallbackComment,
            actionTrace: sim.actionTrace,
            appliedConstraintNote: sim.appliedConstraintNote,
          };
        });

        return {
          evaluatedAt: new Date().toISOString(),
          source: 'gemini',
          cohortId: req.cohortId,
          results,
        };
      }
    } catch (err) {
      console.error('[gemini:evaluate] Gemini呼び出し失敗、フォールバックを使用します:', err);
    }
  }

  const fallbackResults: ReviewerEvaluation[] = reviewers.map((p) => {
    const sim = simMap.get(p.id)!;
    return {
      reviewerId: p.id,
      outcome: sim.outcome,
      frictionPoint: sim.frictionPoint,
      comment: sim.fallbackComment,
      actionTrace: sim.actionTrace,
      appliedConstraintNote: sim.appliedConstraintNote,
    };
  });

  return {
    evaluatedAt: new Date().toISOString(),
    source: 'fallback',
    cohortId: req.cohortId,
    results: fallbackResults,
  };
}

/**
 * 部品の内部構造を初学者向けの平易な日本語に変換する
 */
function buildInspectedComponents(
  spec: AppSpec,
  targetIds: string[],
): InspectedComponentInfo[] {
  const targets =
    targetIds.length > 0
      ? spec.components.filter((c) => targetIds.includes(c.id))
      : spec.components.filter((c) => c.type === 'button' || c.type === 'clock_display');

  return targets.map((c) => {
    if (c.id === 'btn-set-alarm' && c.actions.length === 0) {
      return {
        id: c.id,
        label: c.label,
        howItWorks: 'ボタンの見た目だけで、中身が空っぽです。',
        issueOrHint: '予約できるように繋いでと指示すると動くようになります。',
      };
    }
    if (c.id === 'btn-cancel-all') {
      return {
        id: c.id,
        label: c.label,
        howItWorks: '押すと設定がすべて消えて最初に戻るリセット機能がついています。',
        issueOrHint:
          c.style.size === 'xl'
            ? '一番大きく真っ赤なので、予約ボタンと間違えて押しやすくなっています。'
            : '小さく控えめになり押し間違いしにくくなっています。',
      };
    }
    if (c.id === 'btn-mystery' || c.id === 'btn-wake-plus') {
      const eff = c.behavior?.effect;
      if (!eff || eff === 'none') {
        return {
          id: c.id,
          label: c.label,
          howItWorks: 'まだ中身が空っぽの未完成ボタンです。',
          issueOrHint: '計算クイズや声で起こすアラームなど二度寝防止の仕掛けを入れられます。',
        };
      }
      return {
        id: c.id,
        label: c.label,
        howItWorks:
          eff === 'math_quiz_gate'
            ? '計算クイズに正解すると予約できる二度寝防止ボタンです。'
            : eff === 'tts_voice_alarm'
              ? '声の読み上げアラーム付きで予約するボタンです。'
              : eff === 'escape_on_hover'
                ? '1回逃げるボタンを捕まえて予約する早押しボタンです。'
                : '3回連打でロック解除するボタンです。',
        issueOrHint: '二度寝を防ぐ仕掛けが動いています。',
      };
    }
    if (c.id === 'input-motto' || c.id === 'toggle-poem') {
      return {
        id: c.id,
        label: c.label,
        howItWorks: '時刻合わせとは関係ないおまけ設定です。',
        issueOrHint: '急いでいる人やスマホに不慣れな人には迷う原因になります。',
      };
    }
    if (c.id === 'clock-display') {
      return {
        id: c.id,
        label: c.label,
        howItWorks: '現在合わせているアラーム時刻を表示する文字盤です。',
        issueOrHint:
          c.style.size === 'xs'
            ? '文字が小さすぎて目が遠い人や寝ぼけている人には読めません。'
            : '大きく見やすい文字サイズになっています。',
      };
    }
    return {
      id: c.id,
      label: c.label,
      howItWorks: c.actions.length > 0 ? 'ボタンを押すと動く設定です。' : '画面に表示されている部品です。',
      issueOrHint: '色や大きさ、動きを自由に変えられます。',
    };
  });
}

function classifyUserMessageIntent(
  message: string,
): 'explain' | 'tradeoff_propose' | 'direct_apply' {
  const msg = message.trim();
  if (
    /なぜ|なんで|どうして|どうなって|何これ|なにこれ|何の|しくみ|仕組み|教えて|意味|とは|原因|どこがダメ|どこを直|[?？]$/.test(
      msg,
    ) &&
    !/直して|消して|変えて|作って|追加して|入れて|改造して|大きくして/.test(msg)
  ) {
    return 'explain';
  }
  if (
    /作戦|アイデア|選択肢|3つ|比較|いい感じに|おまかせで|全員|3人とも|どう改造すれば|相談/.test(msg)
  ) {
    return 'tradeoff_propose';
  }
  return 'direct_apply';
}

/**
 * 自由対話タイムライン型ハイブリッドAPI
 */
export async function chatWithStudio(req: ChatRequest): Promise<ChatResponse> {
  const intent = classifyUserMessageIntent(req.userMessage);
  const inspected = buildInspectedComponents(req.currentSpec, req.targetComponentIds);

  if (intent === 'explain') {
    const aiInfo = createGenAIClient();
    if (aiInfo) {
      try {
        const EXPLAIN_SCHEMA: Schema = {
          type: Type.OBJECT,
          properties: {
            reply: {
              type: Type.STRING,
              description: '中学生にもわかる短い話し言葉での解説（60文字以内、英語や専門用語や括弧は禁止）',
            },
            suggestedFollowUps: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '次にユーザーが言える短い言葉（2〜3個、各18文字以内）',
            },
          },
          required: ['reply', 'suggestedFollowUps'],
        };

        const prompt = [
          'あなたは開発スタジオの優しい相棒AIです。ユーザーが時計アプリの部品について質問しました。',
          '改造は勝手にせず、なぜそういう動きになっているのかを60文字以内のやさしい日本語で答えてください。括弧は使わないでください。',
          `【対象部品のしくみ】\n${JSON.stringify(inspected)}`,
          `【ユーザーの質問】\n${req.userMessage}`,
        ].join('\n');

        const response = await aiInfo.client.models.generateContent({
          model: aiInfo.model,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: EXPLAIN_SCHEMA,
            temperature: 0.5,
          },
        });

        if (response.text) {
          const parsed = JSON.parse(response.text) as {
            reply: string;
            suggestedFollowUps: string[];
          };
          return {
            source: 'gemini',
            intent: 'explain',
            reply: parsed.reply,
            inspectedComponents: inspected,
            suggestedFollowUps: parsed.suggestedFollowUps ?? [],
          };
        }
      } catch (err) {
        console.error('[gemini:chat:explain] fallback:', err);
      }
    }

    const first = inspected[0];
    const reply = first
      ? `${first.label} の中身を調べたよ。`
      : 'この時計は文字が小さすぎたり、予約ボタンの中身が空っぽで動かない状態だよ。';

    return {
      source: 'fallback',
      intent: 'explain',
      reply,
      inspectedComponents: inspected,
      suggestedFollowUps: [],
    };
  }

  if (intent === 'tradeoff_propose') {
    const proposed = await proposeTradeoffs({
      currentSpec: req.currentSpec,
      targetComponentIds: req.targetComponentIds,
      userInstruction: req.userMessage,
      cohortId: req.cohortId,
      annotatedImageBase64: req.annotatedImageBase64,
    });
    return {
      source: proposed.source,
      intent: 'tradeoff_propose',
      reply: '誰を優先するかで作戦が3つあるよ。作戦を選んで理由を一言書いてね。',
      options: proposed.options,
      suggestedFollowUps: [],
    };
  }

  const directOption = {
    id: 'direct_vibe',
    title: req.userMessage.slice(0, 22),
    summary: req.userMessage,
    uiChange: req.userMessage,
    logicChange: req.userMessage,
    pros: '自分の言葉どおりに改造',
    tradeoff: 'なし',
  };

  const applied = await applyOptionToSpec({
    currentSpec: req.currentSpec,
    targetComponentIds: req.targetComponentIds,
    userInstruction: req.userMessage,
    selectedOption: directOption,
    selectionReason: req.userMessage,
    cohortId: req.cohortId,
    annotatedImageBase64: req.annotatedImageBase64,
  });

  return {
    source: applied.source,
    intent: 'direct_apply',
    reply: applied.rolledBack
      ? '改修コードの検証で問題が見つかったため、直前の安全な版に戻したよ。'
      : 'スマホ画面を改造したよ。触って試すか、採点するボタンでお客さんの反応を見てみよう。',
    appliedResult: {
      commitMessage: applied.commitMessage,
      changeHighlights: applied.changeHighlights,
      updatedSpec: applied.updatedSpec,
      validation: applied.validation,
      rolledBack: applied.rolledBack,
    },
    suggestedFollowUps: [],
  };
}

// ============================================================================
// フォールバックエンジン
// ============================================================================

function fallbackPropose(req: ProposeRequest, targets: AppComponent[]): ProposeResponse {
  const targetNames =
    targets.length > 0 ? targets.map((t) => t.label).join('・') : '画面全体';
  const text = req.userInstruction;
  const personas = getReviewersByCohort(req.cohortId);
  const p1 = personas[0]?.name ?? '1人目';
  const p2 = personas[1]?.name ?? '2人目';
  const p3 = personas[2]?.name ?? '3人目';

  const isQuizOrPlusAlpha = /クイズ|計算|二度寝|逃げる|連打|声|音|朝|学生|謎/.test(text);
  const isRemoveOrClean = /消|削|邪魔|いらな|キャンセル|気合|ポエム|すっきり|整理/.test(text);

  if (isQuizOrPlusAlpha) {
    return {
      source: 'fallback',
      analysis: `${targetNames}に二度寝を防ぐ仕掛けを入れます。`,
      question: 'どの作戦で改造しますか？',
      options: [
        {
          id: 'option_a',
          title: '毎回計算クイズを必須にする',
          summary: '計算に正解しないと予約できない方式',
          uiChange: '予約ボタンを計算クイズ付きに変更',
          logicChange: '計算クイズ正解で予約完了',
          pros: `${p2}や${p1}が確実に目を覚ませる`,
          tradeoff: '急いでいる人には手数が増える',
        },
        {
          id: 'option_b',
          title: '大文字1発予約＋計算クイズと声アラーム併設',
          summary: '通常予約ボタンの下にクイズ＆声アラームボタンを置く',
          uiChange: '大きな予約ボタンと二度寝防止ボタンを並べる',
          logicChange: '通常予約とクイズ予約の両方を動かす',
          pros: `${p1}・${p2}・${p3}の3人全員が満足できる`,
          tradeoff: 'ボタンが2つ並ぶので見分けやすさが大事',
        },
        {
          id: 'option_c',
          title: '1回逃げる早押しボタンにする',
          summary: '押そうとすると1回だけ横に逃げる仕掛け',
          uiChange: 'ボタンに逃げる動きを追加',
          logicChange: '2回目のタップで捕まえて予約完了',
          pros: 'ゲーム感覚で楽しく二度寝を防げる',
          tradeoff: '指がズレやすい人には押しづらくなる',
        },
      ],
    };
  }

  if (isRemoveOrClean) {
    return {
      source: 'fallback',
      analysis: `${targetNames}を整理して使いやすくします。`,
      question: 'どの作戦で改造しますか？',
      options: [
        {
          id: 'option_a',
          title: '邪魔な部品を消して大文字1発予約にする',
          summary: '不要な項目を消し、時計と予約ボタンを特大にする',
          uiChange: '気合い度・赤ボタンを消し、時計と予約を特大化',
          logicChange: '予約ボタンで1発セットできるように繋ぐ',
          pros: `${p1}や${p2}が迷わず1手で予約できる`,
          tradeoff: '二度寝防止の仕掛けは入らない',
        },
        {
          id: 'option_b',
          title: '邪魔な部品を消し＋二度寝防止ボタンも追加',
          summary: '画面をスッキリさせた上で計算クイズ＆声アラームも作る',
          uiChange: '不要項目を消して大文字化し、二度寝防止ボタンを追加',
          logicChange: '通常予約と計算クイズ予約の両方を繋ぐ',
          pros: `${p1}・${p2}・${p3}の3人全員がクリアできる`,
          tradeoff: '2つのボタンの役割を分かりやすく並べる',
        },
        {
          id: 'option_c',
          title: '赤ボタンを小さくして確認画面をつける',
          summary: 'リセット機能は残したまま押し間違いだけを防ぐ',
          uiChange: '赤ボタンを小さく控えめにし、予約ボタンを拡大',
          logicChange: '消す前に確認画面を出し、予約ボタンを繋ぐ',
          pros: 'リセット機能を残したまま誤タップを防げる',
          tradeoff: '不要なメーター類は画面に残る',
        },
      ],
    };
  }

  return {
    source: 'fallback',
    analysis: `${targetNames}の改造アイデアを3つ考えました。`,
    question: 'どの作戦で改造しますか？',
    options: [
      {
        id: 'option_a',
        title: '邪魔な部品を消して大文字1発予約にする',
        summary: '余計な項目をなくし、大きく見やすい時計にする',
        uiChange: '時刻と予約ボタンを特大にし、邪魔な項目を撤去',
        logicChange: '予約ボタンを押せばすぐセット完了にする',
        pros: `${p1}や${p2}が迷わずすぐ使える`,
        tradeoff: '二度寝常習の人には刺激が足りない',
      },
      {
        id: 'option_b',
        title: '大文字1発予約＋計算クイズで二度寝防止',
        summary: '見やすい予約ボタンに加えて計算クイズ機能も入れる',
        uiChange: '邪魔な項目を消して大文字化し、クイズボタンを追加',
        logicChange: '予約ボタンと計算クイズボタンの両方を動かす',
        pros: `${p1}・${p2}・${p3}の3人全員の課題を解決できる`,
        tradeoff: 'ボタンが2つになるので役割分担が必要',
      },
      {
        id: 'option_c',
        title: '囲んだ部品だけをピンポイントで直す',
        summary: 'ほかの部品はそのままにして囲んだ所だけ直す',
        uiChange: '囲んだ部品を大きく見やすい色に変える',
        logicChange: '動かなかったボタンの中身を繋ぐ',
        pros: '少しずつ変化を確かめながら改造できる',
        tradeoff: 'ほかに邪魔な部品が残っていると迷いやすい',
      },
    ],
  };
}

function fallbackApply(req: ApplyRequest): ApplyResponse {
  const spec: AppSpec = structuredClone(req.currentSpec);
  const optId = req.selectedOption.id;
  const text = `${req.userInstruction} ${req.selectedOption.title} ${req.selectedOption.summary} ${req.customNote ?? ''}`;
  const targetSet = new Set(req.targetComponentIds);

  const highlights: string[] = [];

  spec.theme.chaoticLayout = false;
  if (/夜|暗|黒|ダーク|サイバー/.test(text)) {
    spec.theme.bgColor = '#0f172a';
    spec.theme.textColor = '#f8fafc';
    spec.theme.cardColor = '#1e293b';
    highlights.push('暗い部屋でも眩しくないダークカラーに変更');
  } else if (/青|ブルー|爽やか/.test(text)) {
    spec.theme.bgColor = '#eff6ff';
    highlights.push('背景をさわやかなブルーに変更');
  } else {
    spec.theme.bgColor = '#f8fafc';
  }
  spec.subtitle = '改造済み';

  const wantsVoice = /声|読み上げ|音声|しゃべ|TTS|音/.test(text);
  const wantsQuiz =
    optId === 'option_b' || /クイズ|計算|math_quiz|二度寝防止/.test(text);
  const wantsEscape = /逃げる|escape|早押し/.test(text);
  const wantsMash = /連打|3回/.test(text);
  const wantsRemoveClutter =
    optId === 'option_a' ||
    optId === 'option_b' ||
    /撤去|削除|消|整理|邪魔/.test(text);

  if (wantsRemoveClutter) {
    const removeIds = new Set(['input-motto', 'toggle-poem', 'btn-cancel-all']);
    for (const id of targetSet) {
      if (
        id !== 'clock-display' &&
        id !== 'input-time' &&
        id !== 'btn-set-alarm' &&
        id !== 'status-alarm'
      ) {
        removeIds.add(id);
      }
    }
    const beforeCount = spec.components.length;
    spec.components = spec.components.filter((c) => !removeIds.has(c.id));
    if (spec.components.length < beforeCount) {
      highlights.push('不要な項目と紛らわしい巨大赤ボタンを撤去');
    }
  } else {
    const cancelBtn = spec.components.find((c) => c.id === 'btn-cancel-all');
    if (cancelBtn) {
      cancelBtn.style.size = 'sm';
      cancelBtn.style.variant = 'muted';
      cancelBtn.style.noisyAnimation = false;
      cancelBtn.label = '入力をリセット';
      cancelBtn.behavior = {
        effect: 'confirm_dialog',
        confirmText: '設定をリセットしてもよろしいですか？',
      };
      highlights.push('巨大だった赤ボタンを小さくし、押し間違い防止の確認を追加');
    }
  }

  const clockComp = spec.components.find((c) => c.id === 'clock-display');
  if (clockComp) {
    clockComp.label = 'アラーム設定時刻';
    clockComp.style.size = 'xl';
    clockComp.style.variant = 'primary';
    clockComp.style.align = 'center';
  }

  const timeInput = spec.components.find((c) => c.id === 'input-time');
  if (timeInput) {
    timeInput.label = '起きる時刻を合わせる';
    timeInput.placeholder = '07:00';
    timeInput.style.size = 'lg';
    timeInput.style.variant = 'default';
  }

  let setBtn = spec.components.find((c) => c.id === 'btn-set-alarm');
  if (!setBtn) {
    setBtn = {
      id: 'btn-set-alarm',
      type: 'button',
      label: 'アラームをセットする',
      style: { size: 'xl', variant: 'primary', fullWidth: true, align: 'center' },
      actions: [],
    };
    spec.components.push(setBtn);
  }
  setBtn.label = 'アラームをセットする';
  setBtn.style.size = 'xl';
  setBtn.style.variant = 'primary';
  setBtn.style.fullWidth = true;
  setBtn.style.align = 'center';
  setBtn.actions = [
    { type: 'set_state', targetKey: 'isAlarmSet', value: true },
    { type: 'complete_task', message: 'アラームをセットしました' },
  ];
  highlights.push('時刻と予約ボタンを特大化してアラーム完了イベントを接続');

  if (wantsVoice || wantsQuiz || wantsEscape || wantsMash) {
    let plusBtn = spec.components.find((c) => c.id === 'btn-mystery' || c.id === 'btn-wake-plus');
    if (!plusBtn) {
      plusBtn = {
        id: 'btn-wake-plus',
        type: 'button',
        label: '二度寝防止アラーム予約',
        style: { size: 'lg', variant: 'warning', fullWidth: true, align: 'center' },
        actions: [],
      };
      const statusIdx = spec.components.findIndex((c) => c.id === 'status-alarm');
      if (statusIdx !== -1) {
        spec.components.splice(statusIdx, 0, plusBtn);
      } else {
        spec.components.push(plusBtn);
      }
    }

    if (wantsVoice && !wantsQuiz && !wantsEscape && !wantsMash) {
      plusBtn.id = 'btn-wake-plus';
      plusBtn.label = '声で起こすアラームをセット';
      plusBtn.style = { size: 'lg', variant: 'warning', fullWidth: true, align: 'center' };
      plusBtn.behavior = {
        effect: 'tts_voice_alarm',
        voiceText: '朝ですよ！起きてください！絶対に遅刻しないでね！',
      };
      plusBtn.actions = [
        { type: 'set_state', targetKey: 'wakeMode', value: true },
        { type: 'set_state', targetKey: 'isAlarmSet', value: true },
        { type: 'complete_task', message: '声で起こすアラームを予約しました' },
      ];
      highlights.push('部品箱から声で起こすTTSアラーム部品を組み込み');
    } else if (wantsEscape) {
      plusBtn.id = 'btn-wake-plus';
      plusBtn.label = '逃げるボタンを捕まえて予約';
      plusBtn.style = { size: 'lg', variant: 'warning', fullWidth: true, align: 'center' };
      plusBtn.behavior = {
        effect: 'escape_on_hover',
      };
      plusBtn.actions = [
        { type: 'set_state', targetKey: 'wakeMode', value: true },
        { type: 'set_state', targetKey: 'isAlarmSet', value: true },
        { type: 'complete_task', message: '逃げるボタンを捕まえて予約しました' },
      ];
      highlights.push('1回逃げるボタンを捕まえて予約する早押しモードを追加');
    } else if (wantsMash) {
      plusBtn.id = 'btn-wake-plus';
      plusBtn.label = '3回連打で二度寝防止セット';
      plusBtn.style = { size: 'lg', variant: 'warning', fullWidth: true, align: 'center' };
      plusBtn.behavior = {
        effect: 'require_3_clicks',
      };
      plusBtn.actions = [
        { type: 'set_state', targetKey: 'wakeMode', value: true },
        { type: 'set_state', targetKey: 'isAlarmSet', value: true },
        { type: 'complete_task', message: '3連打クリア！二度寝防止アラームを予約しました' },
      ];
      highlights.push('3回連打するとロック解除される二度寝防止ボタンを追加');
    } else {
      plusBtn.id = 'btn-wake-plus';
      plusBtn.label = '計算クイズ付き二度寝防止セット';
      plusBtn.style = { size: 'lg', variant: 'warning', fullWidth: true, align: 'center' };
      plusBtn.behavior = {
        effect: 'math_quiz_gate',
        quizQuestion: '17 + 28 = ?',
        quizAnswer: '45',
      };
      plusBtn.actions = [
        { type: 'set_state', targetKey: 'wakeMode', value: true },
        { type: 'set_state', targetKey: 'isAlarmSet', value: true },
        { type: 'complete_task', message: 'クイズ正解！二度寝防止アラームをセットしました' },
      ];
      highlights.push('計算クイズで頭を起こす二度寝防止ボタンを追加');
    }
  }

  return {
    source: 'fallback',
    commitMessage: req.selectedOption.title.replace(/^案[ABC]：/, ''),
    changeHighlights: highlights,
    updatedSpec: spec,
  };
}
