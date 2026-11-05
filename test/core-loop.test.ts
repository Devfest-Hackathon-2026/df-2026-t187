import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyOptionToSpec,
  chatWithStudio,
  evaluateAppWithPersonas,
  proposeTradeoffs,
  recordHumanDecisionWithFunctionCalling,
} from '../src/server/gemini.ts';
import { detectHitComponents, type Rect2D } from '../src/shared/hitTest.ts';
import {
  ALL_REVIEWER_PERSONAS,
  getReviewersByCohort,
  INITIAL_ALARM_SPEC,
} from '../src/shared/initialTheme.ts';
import { validateSandboxSpec } from '../src/shared/sandboxValidator.ts';

describe('core-loop', () => {
  it('ペン囲みの軌跡座標から重なるUI部品IDを特定できる', () => {
    const rects: Rect2D[] = [
      { id: 'clock-display', left: 20, top: 20, right: 300, bottom: 70 },
      { id: 'btn-cancel-all', left: 20, top: 180, right: 300, bottom: 250 },
      { id: 'btn-set-alarm', left: 20, top: 270, right: 180, bottom: 310 },
    ];

    // btn-cancel-all の周囲を丸く囲んだペン軌跡
    const stroke = [
      { x: 15, y: 175 },
      { x: 305, y: 175 },
      { x: 305, y: 255 },
      { x: 15, y: 255 },
      { x: 15, y: 175 },
    ];

    const hits = detectHitComponents(stroke, rects);
    assert.deepEqual(hits, ['btn-cancel-all']);
  });

  it('壁打ち(propose)→改修反映(apply)→架空顧客評価(evaluate)でグラデーション評価が変化する', async () => {
    // 0. 初期状態では3人全員が離脱(0/3達成)
    const initialEval = await evaluateAppWithPersonas({
      currentSpec: INITIAL_ALARM_SPEC,
    });
    assert.equal(
      initialEval.results.filter((r) => r.outcome === 'achieved').length,
      0,
    );

    // 1. 壁打ち: 邪魔な部品の撤去と予約ボタンの接続を提案
    const proposal = await proposeTradeoffs({
      currentSpec: INITIAL_ALARM_SPEC,
      targetComponentIds: ['btn-cancel-all', 'btn-set-alarm'],
      userInstruction: '赤いキャンセルボタンが邪魔！文字を大きくして予約ボタンが動くようにしたい',
    });
    assert.equal(proposal.options.length, 3);

    // 2. 案A(シンプル化のみ・＋α機能なし)を適用した場合:
    //    会社員(kenta)と祖母(kazuko)は達成するが、朝が弱い高校生(shota)は離脱のまま(2/3達成のグラデーション)
    const appliedSimple = await applyOptionToSpec({
      currentSpec: INITIAL_ALARM_SPEC,
      targetComponentIds: ['btn-cancel-all', 'btn-set-alarm'],
      userInstruction: '赤いキャンセルボタンが邪魔！文字を大きくして予約ボタンが動くようにしたい',
      selectedOption: proposal.options[0],
    });
    const simpleEval = await evaluateAppWithPersonas({
      currentSpec: appliedSimple.updatedSpec,
    });
    const simpleMap = new Map(simpleEval.results.map((r) => [r.reviewerId, r.outcome]));
    assert.equal(simpleMap.get('kenta'), 'achieved');
    assert.equal(simpleMap.get('kazuko'), 'achieved');
    assert.equal(simpleMap.get('shota'), 'abandoned');

    // 3. 案B(シンプル化＋二度寝防止の計算クイズ機能を追加)を適用した場合:
    //    3人全員が達成(3/3達成)
    const appliedPlusAlpha = await applyOptionToSpec({
      currentSpec: INITIAL_ALARM_SPEC,
      targetComponentIds: ['btn-cancel-all', 'btn-set-alarm', 'btn-mystery'],
      userInstruction: '邪魔な部品を消して、計算クイズ付きの二度寝防止ボタンも追加したい',
      selectedOption: proposal.options[1],
    });
    const plusAlphaEval = await evaluateAppWithPersonas({
      currentSpec: appliedPlusAlpha.updatedSpec,
    });
    const plusMap = new Map(plusAlphaEval.results.map((r) => [r.reviewerId, r.outcome]));
    assert.equal(plusMap.get('kenta'), 'achieved');
    assert.equal(plusMap.get('kazuko'), 'achieved');
    assert.equal(plusMap.get('shota'), 'achieved');
  });

  it('自由対話(chatWithStudio)で「しくみ質問(explain)」「即改造(direct_apply)」「作戦比較(tradeoff_propose)」を判別できる', async () => {
    // 1. 質問したときは改造を強制せず、しくみ解説(explain)を返す
    const explainRes = await chatWithStudio({
      currentSpec: INITIAL_ALARM_SPEC,
      targetComponentIds: ['btn-set-alarm'],
      userMessage: 'なんでこのボタン押しても動かないの？',
    });
    assert.equal(explainRes.intent, 'explain');
    assert.equal(explainRes.appliedResult, undefined);
    assert.ok((explainRes.inspectedComponents?.length ?? 0) > 0);

    // 2. 具体的な改造指示を出したときは3択を挟まず即座に改造反映(direct_apply)する
    const directRes = await chatWithStudio({
      currentSpec: INITIAL_ALARM_SPEC,
      targetComponentIds: ['btn-cancel-all', 'btn-set-alarm'],
      userMessage: '邪魔な部品を消して、すぐ予約できるようにして！',
    });
    assert.equal(directRes.intent, 'direct_apply');
    assert.ok(directRes.appliedResult?.updatedSpec);

    // 3. 作戦の比較を求めたときは3つの作戦カード(tradeoff_propose)を返す
    const planRes = await chatWithStudio({
      currentSpec: INITIAL_ALARM_SPEC,
      targetComponentIds: [],
      userMessage: '3人全員が満足する作戦を3つ比較したい',
    });
    assert.equal(planRes.intent, 'tradeoff_propose');
    assert.equal(planRes.options?.length, 3);
  });

  it('3つの顧客層ごとに異なる制約変数を持つ3人(計9人)で実操作シミュレーション評価ができる', async () => {
    assert.equal(ALL_REVIEWER_PERSONAS.length, 9);
    for (const cohortId of ['elderly', 'office_worker', 'student'] as const) {
      const personas = getReviewersByCohort(cohortId);
      assert.equal(personas.length, 3);

      const initialCohortEval = await evaluateAppWithPersonas({
        currentSpec: INITIAL_ALARM_SPEC,
        cohortId,
      });
      assert.equal(initialCohortEval.results.length, 3);
      assert.ok(initialCohortEval.results.every((r) => (r.actionTrace?.length ?? 0) > 0));
    }
  });

  it('単一HTMLサンドボックス検証とFunction Calling判断記録が機能する', async () => {
    // 初期状態は予約ボタンが空っぽのためタスク完了イベント未接続
    const initialValidation = validateSandboxSpec(INITIAL_ALARM_SPEC, {
      requireTaskCompletionEvent: true,
    });
    assert.equal(initialValidation.canRenderHtml, true);
    assert.equal(initialValidation.hasTaskCompletionEvent, false);

    // 意思決定のFunction Calling記録
    const decisionRes = await recordHumanDecisionWithFunctionCalling({
      stage: 'review_disposition',
      targetId: 'kazuko',
      chosenLabel: '和子:直す',
      reason: '目が遠い人でも読めるように文字を特大にしたいから',
      cohortId: 'elderly',
    });
    assert.equal(decisionRes.decision.stage, 'review_disposition');
    assert.ok(decisionRes.decision.reason.includes('文字を特大'));
  });
});
