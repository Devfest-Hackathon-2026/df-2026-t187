import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AiNotConfiguredError,
  applyOptionToSpec,
  applyPatchesToSpecWithValidation,
  chatWithStudio,
  classifyUserMessageIntent,
  detectExplicitRecipientMention,
  evaluateAppWithPersonas,
  getAiConnectionStatus,
  normalizeUpdatedSpec,
  recordHumanDecisionWithFunctionCalling,
} from '../src/server/gemini.ts';
import {
  applyActions,
  createInitialState,
  evaluateExpression,
  renderLabel,
  renderTemplate,
  toKanjiNumber,
  withDerivedValues,
} from '../src/shared/appRuntime.ts';
import { detectHitComponents, type Rect2D } from '../src/shared/hitTest.ts';
import {
  ACTIVE_THEME,
  ALL_REVIEWER_PERSONAS,
  getReviewersByCohort,
} from '../src/shared/initialTheme.ts';
import {
  sanitizeCssColor,
  sanitizeCustomCss,
  sanitizeCustomHtml,
  simulatePersonaComputerUse,
  validateSandboxSpec,
} from '../src/shared/sandboxValidator.ts';
import { detectCheckpointRevertCommand } from '../src/shared/intent.ts';
import {
  buildOwnerChangeReaction,
  buildOwnerClosingLines,
  buildOwnerReport,
} from '../src/shared/owner.ts';
import { applySpecPatches } from '../src/shared/specPatch.ts';
import { buildInitialSpec, buildScenarioSpec, findComponent } from '../src/shared/theme.ts';
import type { AppSpec, ReviewOutcome, SpecPatch } from '../src/shared/types.ts';

// テストは AI に接続しない前提で実行する（package.json の test スクリプトで接続設定を空にしている）

function persona(id: string) {
  const p = ALL_REVIEWER_PERSONAS.find((x) => x.id === id);
  if (!p) throw new Error(`persona not found: ${id}`);
  return p;
}

function outcomeOf(spec: AppSpec, personaId: string): ReviewOutcome {
  return simulatePersonaComputerUse(spec, persona(personaId)).outcome;
}

/** 妨害要素を入れる前の、まともに動く購入画面 */
function cleanSpec(): AppSpec {
  return structuredClone(ACTIVE_THEME.baseSpec);
}

function withAnnoyance(spec: AppSpec, id: string): AppSpec {
  const annoyance = ACTIVE_THEME.annoyances.find((a) => a.id === id);
  if (!annoyance) throw new Error(`annoyance not found: ${id}`);
  annoyance.apply(spec);
  return spec;
}

describe('core-loop', () => {
  it('ペン囲みの軌跡座標から重なるUI部品IDを特定できる', () => {
    const rects: Rect2D[] = [
      { id: 'product-hero', left: 20, top: 20, right: 300, bottom: 70 },
      { id: 'btn-clear-cart', left: 20, top: 180, right: 300, bottom: 250 },
      { id: 'btn-order', left: 20, top: 270, right: 180, bottom: 310 },
    ];
    const stroke = [
      { x: 15, y: 175 },
      { x: 305, y: 175 },
      { x: 305, y: 255 },
      { x: 15, y: 255 },
      { x: 15, y: 175 },
    ];
    assert.deepEqual(detectHitComponents(stroke, rects), ['btn-clear-cart']);

    // 線が隣の部品に少しはみ出しても、中心まで囲んだ部品だけを選ぶ
    const sloppy = [
      { x: 15, y: 175 },
      { x: 305, y: 175 },
      { x: 305, y: 275 },
      { x: 15, y: 275 },
      { x: 15, y: 175 },
    ];
    assert.deepEqual(detectHitComponents(sloppy, rects), ['btn-clear-cart']);

    // 大きな部品の一部だけを囲んだときは、その部品を選ぶ
    const partial = [
      { x: 30, y: 25 },
      { x: 90, y: 25 },
      { x: 90, y: 50 },
      { x: 30, y: 50 },
    ];
    assert.deepEqual(detectHitComponents(partial, rects), ['product-hero']);
  });

  it('計算式で合計金額を求め、漢数字でも表示できる', () => {
    const spec = cleanSpec();
    const state = createInitialState(spec);
    assert.equal(state.subtotal, 1980);
    assert.equal(state.shipping, 600);
    assert.equal(state.total, 2580);

    // 2袋以上で送料無料
    assert.equal(evaluateExpression('subtotal >= 3960 ? 0 : shippingFee', { subtotal: 3960, shippingFee: 600 }), 0);
    assert.equal(evaluateExpression('(1 + 2) * 3 - 4 / 2', {}), 7);

    assert.equal(toKanjiNumber(1980), '千九百八十');
    assert.equal(toKanjiNumber(3960), '三千九百六十');
    assert.equal(toKanjiNumber(12000), '一万二千');
    assert.equal(toKanjiNumber(0), '零');

    const total = findComponent(spec, 'total-price');
    assert.equal(renderLabel(total, state), '¥2,580');
    // 漢数字の妨害要素を入れると、合計も内訳も漢数字になる
    const kanjiSpec = withAnnoyance(cleanSpec(), 'kanji_price');
    const kanjiTotal = findComponent(kanjiSpec, 'total-price');
    assert.equal(renderLabel(kanjiTotal, state), '二千五百八十円');
    const kanjiSummary = findComponent(kanjiSpec, 'summary');
    assert.deepEqual(
      kanjiSummary.rows?.map((r) => renderTemplate(r.value, state, kanjiSummary.style.numberFormat)),
      ['千九百八十円', '六百円'],
    );
    // 偽のカウントダウンは、画面の外では最初の値で表す
    const countdown = findComponent(withAnnoyance(cleanSpec(), 'countdown_pressure'), 'banner-countdown');
    assert.equal(renderLabel(countdown, state), '⏰ 残り 2:59 で売り切れ！！');
  });

  it('初期画面は毎回ランダムに妨害要素を組み込み、同じ乱数の元なら同じ画面になる', () => {
    const a = buildInitialSpec(ACTIVE_THEME, 1);
    const b = buildInitialSpec(ACTIVE_THEME, 1);
    assert.deepEqual(a.appliedAnnoyanceIds, b.appliedAnnoyanceIds);

    const expectedTotal = { easy: [2, 3], normal: [3, 5], hard: [8, 9] } as const;
    for (const level of ['easy', 'normal', 'hard'] as const) {
      const variations = new Set<string>();
      for (let seed = 1; seed <= 30; seed++) {
        const built = buildInitialSpec(ACTIVE_THEME, seed, level);
        variations.add(built.appliedAnnoyanceIds.join(','));
        const ids = built.appliedAnnoyanceIds;
        // 注文ボタンが反応しないことは毎回必ず入る
        assert.ok(ids.includes('broken_order_button'));
        const [min, max] = expectedTotal[level];
        assert.ok(ids.length >= min && ids.length <= max, `${level}:${seed} ${ids.length}個`);
        // 広告は1回に1つまで
        assert.ok(built.spec.components.filter((c) => c.role === 'popup').length <= 1);
        // 画面としては描画でき、完了イベントだけが失われている
        const validation = validateSandboxSpec(built.spec, { requireTaskCompletionEvent: true });
        assert.equal(validation.canRenderHtml, true);
        assert.equal(validation.hasTaskCompletionEvent, false);
        // 初期画面では誰も注文を完了できない
        for (const p of ALL_REVIEWER_PERSONAS) {
          assert.equal(simulatePersonaComputerUse(built.spec, p).outcome, 'abandoned', `${level}:${seed}:${p.id}`);
        }
      }
      assert.ok(variations.size > 10, `${level}: 乱数の元が違えば組み合わせも変わる`);
    }

    // 冗談枠は easy では出ない
    const jokeIds = new Set(ACTIVE_THEME.annoyances.filter((x) => x.kind === 'joke').map((x) => x.id));
    for (let seed = 1; seed <= 30; seed++) {
      const ids = buildInitialSpec(ACTIVE_THEME, seed, 'easy').appliedAnnoyanceIds;
      assert.ok(ids.every((id) => !jokeIds.has(id)));
    }
  });

  it('注文ボタンを直すだけで、誰かは注文できるようになる', () => {
    // 最初の改修で手応えが出ること。normal の画面で注文ボタンだけ直したとき、9人のうち誰かは達成か後悔に届く
    let seedsWithProgress = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const spec = buildInitialSpec(ACTIVE_THEME, seed, 'normal').spec;
      findComponent(spec, 'btn-order').actions = [
        { type: 'complete_task', message: 'ご購入ありがとうございます' },
      ];
      const progressed = ALL_REVIEWER_PERSONAS.some(
        (p) => simulatePersonaComputerUse(spec, p).outcome !== 'abandoned',
      );
      if (progressed) seedsWithProgress++;
    }
    assert.ok(seedsWithProgress >= 25, `30回中${seedsWithProgress}回`);
  });

  it('まともな購入画面なら多くの人が注文でき、確認したい人は確認がないと押せない', () => {
    const spec = cleanSpec();
    assert.equal(outcomeOf(spec, 'kazuko'), 'achieved');
    assert.equal(outcomeOf(spec, 'kenta'), 'achieved');
    assert.equal(outcomeOf(spec, 'shota'), 'achieved');
    assert.equal(outcomeOf(spec, 'misaki'), 'achieved');
    assert.equal(outcomeOf(spec, 'harue'), 'abandoned');
  });

  it('確認を足すと確認したい人は助かるが、急いでいる人は手数が増えて離脱する', () => {
    const spec = cleanSpec();
    findComponent(spec, 'btn-order').behavior = { effect: 'confirm_dialog' };
    assert.equal(outcomeOf(spec, 'harue'), 'achieved');
    assert.equal(outcomeOf(spec, 'kenta'), 'abandoned');

    // 前回と同じお届け先・支払い方法を最初から埋めておけば、両方が注文できる
    for (const v of spec.state) {
      if (v.key === 'deliveryAddress') v.initialValue = '自宅';
      if (v.key === 'paymentMethod') v.initialValue = 'クレジットカード';
    }
    assert.equal(outcomeOf(spec, 'harue'), 'achieved');
    assert.equal(outcomeOf(spec, 'kenta'), 'achieved');
  });

  it('最初からチェックの入った定期便に気づかず注文すると後悔になる', () => {
    const spec = withAnnoyance(cleanSpec(), 'subscription_trap');
    // 細かい字を読み飛ばす人
    assert.equal(outcomeOf(spec, 'hina'), 'regretted');
    // 細かい字は読むが、小さすぎて読めない人
    assert.equal(outcomeOf(spec, 'kazuko'), 'regretted');
    // 細かい字を読み、読める人は気づいて外す。買えはするが、勝手に付いていたことに不満が残る
    assert.equal(outcomeOf(spec, 'shota'), 'bothered');
    assert.equal(outcomeOf(cleanSpec(), 'shota'), 'achieved');
  });

  it('妨害要素ごとに、困る人が変わる', () => {
    // 漢数字の合計は、金額を確かめたい人を離脱させる
    assert.equal(outcomeOf(withAnnoyance(cleanSpec(), 'kanji_price'), 'shota'), 'abandoned');
    // 小さな閉じるボタンの広告は、目が遠い人には閉じられない
    assert.equal(outcomeOf(withAnnoyance(cleanSpec(), 'coupon_popup'), 'kazuko'), 'abandoned');
    // 文字が小さいと読めない
    assert.equal(outcomeOf(withAnnoyance(cleanSpec(), 'tiny_text'), 'kazuko'), 'abandoned');
    // 注文ボタンが反応しなければ誰も完了できない
    assert.equal(outcomeOf(withAnnoyance(cleanSpec(), 'broken_order_button'), 'kenta'), 'abandoned');
  });

  it('偽のカウントダウンは、急かされるのが嫌いな人だけを不満にする', () => {
    const spec = withAnnoyance(cleanSpec(), 'countdown_pressure');
    // 損をしたくない人は急かされると嫌
    assert.equal(outcomeOf(spec, 'shota'), 'bothered');
    assert.equal(outcomeOf(spec, 'hina'), 'bothered');
    // さっと買いたい人は気にしない
    assert.equal(outcomeOf(spec, 'kenta'), 'achieved');
    // 帯を消せば、損をしたくない人も満足して買える
    assert.equal(outcomeOf(cleanSpec(), 'shota'), 'achieved');
  });

  it('合計金額を消す改修も取り消さず、結果はお客さんの反応で分かる', () => {
    const totalId = cleanSpec().components.find((c) => c.role === 'total')!.id;
    const result = applyPatchesToSpecWithValidation(cleanSpec(), '合計金額を消しました', [
      { op: 'remove_component', id: totalId },
    ]);
    assert.equal(result.rolledBack, false);
    assert.ok(!result.updatedSpec.components.some((c) => c.role === 'total'));
    // 金額を確かめたい人は買うのをやめ、さっと買いたい人は買える
    assert.equal(outcomeOf(result.updatedSpec, 'shota'), 'abandoned');
    assert.equal(outcomeOf(result.updatedSpec, 'kenta'), 'achieved');
  });

  it('固定の問題「売上を伸ばしたい店長の画面」は、直すほど結果が変わり、店長の反応も変わる', () => {
    const scenario = ACTIVE_THEME.scenarios[ACTIVE_THEME.defaultScenarioId];
    const build = (removed: string[] = []) => {
      // 実装と同じく、題材に定義した順に組み込む
      const spec = cleanSpec();
      for (const a of ACTIVE_THEME.annoyances) {
        if (scenario.annoyanceIds.includes(a.id) && !removed.includes(a.id)) a.apply(spec);
      }
      return spec;
    };
    const report = (spec: AppSpec) => {
      const results = ALL_REVIEWER_PERSONAS.map((p) => simulatePersonaComputerUse(spec, p));
      return {
        outcomes: results.map((r) => r.outcome),
        owner: buildOwnerReport(ACTIVE_THEME.owner, spec, results),
      };
    };

    // 既定の問題と、妨害要素を順に入れた画面は同じ
    assert.deepEqual(buildScenarioSpec(ACTIVE_THEME, ACTIVE_THEME.defaultScenarioId).spec, build());

    // 最初は誰も注文できず、店長も困っている
    const initial = report(build());
    assert.ok(initial.outcomes.every((o) => o === 'abandoned'));
    assert.equal(initial.owner.orders, 0);
    assert.match(initial.owner.comment, /注文がひとつも入らない/);

    // 注文ボタンを直すと、定期便に気づいて外したが不満の残る人と、気づかず後悔する人が現れる。
    // まだ誰も嫌な思いをせずには買えない。店長は定期便が取れて喜ぶ
    const fixed = report(build(['broken_order_button']));
    assert.ok(fixed.outcomes.includes('bothered'));
    assert.ok(fixed.outcomes.includes('regretted'));
    assert.ok(!fixed.outcomes.includes('achieved'));
    const subscription = fixed.owner.metrics.find((m) => m.label === '定期便')!;
    assert.ok(subscription.count > 0);
    assert.match(fixed.owner.comment, /定期便も\d+件取れたぞ/);

    // 定期便の欄を消すと後悔はなくなるが、店長は定期便がなくなったことを嘆く
    const noTrap = build(['broken_order_button', 'coupon_popup', 'countdown_pressure', 'decoy_buy_now', 'subscription_trap']);
    const cleaned = report(noTrap);
    assert.ok(!cleaned.outcomes.includes('regretted'));
    assert.ok(cleaned.outcomes.filter((o) => o === 'achieved').length >= 8);
    assert.match(cleaned.owner.comment, /定期便の申し込み欄がなくなった/);
  });

  it('はっきりした改造の指示だけをすぐ改修に回し、迷う発言はお助けエージェントに判断させる', () => {
    // すぐ改修してよいもの
    for (const msg of [
      '邪魔な部品を消して、すぐ注文できるようにして！',
      '文字を大きくして',
      'この広告消して',
      '注文ボタンを動くように直す',
      '定期便のチェックを最初は外しておいて',
    ]) {
      assert.equal(classifyUserMessageIntent(msg), 'apply', msg);
    }
    // 質問・感想・あいさつ・変え方が決まらない発言
    for (const msg of [
      'なんでこのボタン押しても動かないの？',
      'これ何が困る？',
      'このボタンの仕組みを教えて',
      'なんで小さいの？大きくしてほしい',
      '赤いボタンが邪魔',
      '健太が困ってるのはどこ',
      'うーん',
      'ありがとう',
      '説明してほしい',
    ]) {
      assert.equal(classifyUserMessageIntent(msg), 'triage', msg);
    }
  });

  it('3つの顧客層にそれぞれ3人のペルソナがいる', () => {
    assert.equal(ALL_REVIEWER_PERSONAS.length, 9);
    for (const p of ALL_REVIEWER_PERSONAS) {
      assert.ok(p.greeting.trim().length > 0, `${p.name} の来店時の一言が空です`);
    }
    for (const cohort of ACTIVE_THEME.cohorts) {
      const reviewers = getReviewersByCohort(cohort.id);
      assert.equal(reviewers.length, 3);
      assert.deepEqual(reviewers.map((r) => r.name), ['客A', '客B', '客C']);
      assert.deepEqual(reviewers.map((r) => r.icon), ['A', 'B', 'C']);
    }
  });

  it('明確なメンション・呼びかけだけ宛先を切り替え、文中に名前が入っているだけでは切り替えない', () => {
    const carefulPersonas = getReviewersByCohort('careful');

    // 明確なメンション・呼びかけ
    assert.equal(detectExplicitRecipientMention('店長、広告を消してもいい？', carefulPersonas), 'owner');
    assert.equal(detectExplicitRecipientMention('@店長 定期便はどうする？', carefulPersonas), 'owner');
    assert.equal(detectExplicitRecipientMention('ねえ店長！売上って大事？', carefulPersonas), 'owner');
    assert.equal(detectExplicitRecipientMention('客A、どこで困ったの？', carefulPersonas), 'kazuko');
    assert.equal(detectExplicitRecipientMention('客Bさん、何が嫌だった？', carefulPersonas), 'shigeru');
    assert.equal(detectExplicitRecipientMention('@客C どこが分かりにくかった？', carefulPersonas), 'harue');
    assert.equal(detectExplicitRecipientMention('お助けAI、注文ボタンを直して', carefulPersonas), 'assistant');
    assert.equal(detectExplicitRecipientMention('@お助けAI これ何の部品？', carefulPersonas), 'assistant');

    // 文中に名前が入っているだけ（第三者としての言及）では切り替えない
    for (const msg of [
      '店長が付けた広告を消して',
      '店長の言ってる定期便って何？',
      '客Aはどこで困ったの？',
      '客Bが買えなかった原因を教えて',
      '客Cの言ってるボタンを直して',
      'お助けAIに頼む前にどう思う？',
    ]) {
      assert.equal(detectExplicitRecipientMention(msg, carefulPersonas), null, msg);
    }
  });

  it('実装AIが文字列で返した値を、状態の型に合わせて直す', () => {
    const previous = cleanSpec();
    const raw = structuredClone(previous) as unknown as AppSpec;
    const order = raw.components.find((c) => c.id === 'btn-order')!;
    order.visibleWhen = { stateKey: 'quantity', operator: 'gt', value: '0' };
    raw.components.push({
      id: 'check-x',
      type: 'checkbox',
      role: 'trap',
      label: 'x',
      stateKey: 'quantity',
      trapWhen: { stateKey: 'quantity', operator: 'gt', value: '5' },
      trapSafeValue: '1',
      style: { size: 'xs', variant: 'muted' },
      actions: [],
    });
    const normalized = normalizeUpdatedSpec(raw, previous);
    assert.equal(normalized.components.find((c) => c.id === 'btn-order')!.visibleWhen!.value, 0);
    const trap = normalized.components.find((c) => c.id === 'check-x')!;
    assert.equal(trap.trapWhen!.value, 5);
    assert.equal(trap.trapSafeValue, 1);
    assert.deepEqual(normalized.derived, previous.derived);
  });

  it('判断記録は理由が空でも勝手に補わない', async () => {
    const decisionRes = await recordHumanDecisionWithFunctionCalling({
      stage: 'review_disposition',
      targetId: 'kazuko',
      chosenLabel: '和子:直す',
      reason: '目が遠い人でも読めるように文字を大きくしたいから',
      cohortId: 'careful',
    });
    assert.equal(decisionRes.decision.stage, 'review_disposition');
    assert.ok(decisionRes.decision.reason.includes('文字を大きく'));

    const noReasonRes = await recordHumanDecisionWithFunctionCalling({
      stage: 'select_cohort',
      targetId: 'careful',
      chosenLabel: '確実に買いたい人',
      reason: '',
      cohortId: 'careful',
    });
    assert.equal(noReasonRes.decision.reason, '');
  });

  it('AIの接続設定がない場合は代替処理をせずエラーにする', async () => {
    assert.equal(getAiConnectionStatus().configured, false);
    const spec = cleanSpec();

    await assert.rejects(
      chatWithStudio({ currentSpec: spec, targetComponentIds: [], userMessage: '文字を大きくして' }),
      AiNotConfiguredError,
    );
    await assert.rejects(
      applyOptionToSpec({
        currentSpec: spec,
        targetComponentIds: [],
        userInstruction: '文字を大きくして',
      }),
      AiNotConfiguredError,
    );
    await assert.rejects(evaluateAppWithPersonas({ currentSpec: spec }), AiNotConfiguredError);
  });

  it('差分パッチ適用で対象外の部品が一切崩れず、不正な操作は安全に無視される', () => {
    const initial = buildScenarioSpec(ACTIVE_THEME, ACTIVE_THEME.defaultScenarioId).spec;

    // 1. 注文ボタンを直し、おとりボタンを消し、存在しないIDへの操作や重複見出しを混ぜる
    const { spec: patched, warnings, touchedComponentIds } = applySpecPatches(initial, [
      {
        op: 'replace_component',
        component: {
          id: 'btn-order',
          type: 'button',
          role: 'primary_action',
          label: '注文を確定する',
          // sticky を省略しても元の btn-order から引き継がれること
          style: { size: 'lg', variant: 'primary', fullWidth: true, align: 'center' },
          actions: [{ type: 'complete_task', message: 'ご購入ありがとうございます' }],
        },
      },
      { op: 'remove_component', id: 'btn-buy-now' },
      { op: 'remove_component', id: 'non-existent-id' },
      {
        op: 'insert_component',
        afterId: 'product-card',
        component: {
          id: 'heading-address-dup',
          type: 'heading',
          role: 'info',
          label: 'お届け先',
          style: { size: 'sm', variant: 'default' },
          actions: [],
        },
      },
    ]);

    assert.ok(touchedComponentIds.has('btn-order'));
    assert.ok(touchedComponentIds.has('btn-buy-now'));
    assert.ok(warnings.some((w) => w.includes('non-existent-id')));
    assert.ok(warnings.some((w) => w.includes('同じ見出しの重複追加')));

    // 触っていない部品（進行表示・商品カード・選択カード・内訳・合計）が完全にそのままであること
    for (const id of ['progress', 'product-card', 'choice-address', 'choice-payment', 'summary', 'total-price']) {
      assert.deepEqual(findComponent(patched, id), findComponent(initial, id), `${id} が変化していないこと`);
    }
    // 注文ボタンの sticky も維持されていること
    assert.equal(findComponent(patched, 'btn-order').style.sticky, true);
  });

  it('改修検証と店長の変更直後リアクションが一貫して動く', () => {
    const initial = buildScenarioSpec(ACTIVE_THEME, ACTIVE_THEME.defaultScenarioId).spec;

    // 注文ボタンが壊れたままでも、先に広告を削除する改修は通る
    const step1 = applyPatchesToSpecWithValidation(initial, '広告を消しました', [
      { op: 'remove_component', id: 'popup-coupon' },
    ]);
    assert.equal(step1.rolledBack, false);
    assert.ok(step1.ownerReaction?.includes('広告'));

    // 注文ボタンを動くように直すと、店長が喜ぶ
    const step2 = applyPatchesToSpecWithValidation(step1.updatedSpec, '注文ボタンを直しました', [
      {
        op: 'replace_component',
        component: {
          ...findComponent(step1.updatedSpec, 'btn-order'),
          actions: [{ type: 'complete_task', message: 'ご購入ありがとうございます' }],
        },
      },
    ]);
    assert.equal(step2.rolledBack, false);
    assert.equal(step2.validation?.hasTaskCompletionEvent, true);
    assert.ok(step2.ownerReaction?.includes('注文ボタン'));

    // 定期便のチェック欄を消すと、店長が売上の心配をする
    const step3 = applyPatchesToSpecWithValidation(step2.updatedSpec, '定期便の欄を消しました', [
      { op: 'remove_component', id: 'check-subscription' },
    ]);
    assert.equal(step3.rolledBack, false);
    assert.ok(step3.ownerReaction?.includes('定期便'));
    assert.equal(
      buildOwnerChangeReaction(ACTIVE_THEME.owner, step2.updatedSpec, step3.updatedSpec),
      step3.ownerReaction,
    );
  });

  it('改造の作業内容を、学習者が読める短い言葉の行にする', () => {
    const initial = buildScenarioSpec(ACTIVE_THEME, ACTIVE_THEME.defaultScenarioId).spec;
    const order = initial.components.find((c) => c.id === 'btn-order')!;
    const patches: SpecPatch[] = [
      {
        op: 'replace_component',
        component: { ...order, actions: [{ type: 'complete_task', message: 'ご購入ありがとうございます' }] },
      },
      { op: 'remove_component', id: 'popup-coupon' },
      { op: 'upsert_state', variable: { key: 'subscription', label: '定期便', type: 'boolean', initialValue: false } },
    ];
    const result = applyPatchesToSpecWithValidation(initial, '直しました', patches);
    const texts = (result.workSteps ?? []).map((s) => s.text);
    assert.equal(texts.length, 3);
    assert.match(texts[0], /注文を確定する.*押したときの動きを変更/);
    assert.match(texts[1], /を削除$/);
    assert.equal(texts[2], '「定期便」の最初の状態を変更');
    // 変えた部品はスマホで光らせられるよう、部品の名前が付いている
    assert.equal(result.workSteps?.[0].componentId, 'btn-order');
    assert.equal(result.workSteps?.[2].componentId, 'check-subscription');
    // 偽のカウントダウンも、画面に出る文字で書く
    const removedBanner = applyPatchesToSpecWithValidation(initial, '消しました', [
      { op: 'remove_component', id: 'banner-countdown' },
    ]);
    assert.match(removedBanner.workSteps?.[0].text ?? '', /2:59/);
  });

  it('店長が気にする変化は、何を消したかを区別した事実として取り出せる', () => {
    const initial = buildScenarioSpec(ACTIVE_THEME, ACTIVE_THEME.defaultScenarioId).spec;
    const removed = applyPatchesToSpecWithValidation(initial, '消しました', [
      { op: 'remove_component', id: 'btn-buy-now' },
      { op: 'remove_component', id: 'banner-countdown' },
    ]);
    const facts = removed.ownerFacts ?? [];
    assert.equal(facts.length, 2);
    assert.ok(facts.some((f) => f.includes('ボタン') && f.includes('今すぐ購入')));
    assert.ok(facts.some((f) => f.includes('煽り') && f.includes('2:59')));
    // AIを使えないときの決まったせりふは、同じものを重ねない
    assert.equal(removed.ownerReaction?.split('\n').length, 1);
  });

  it('客層選択はシステムメッセージで出され、別ページ遷移時にもシステム通知が生成される', () => {
    const cohortLine = ACTIVE_THEME.introScript.find((l) => l.showCohortSelector);
    assert.ok(cohortLine);
    assert.equal(cohortLine.speaker, 'system');

    const spec = cleanSpec();
    const state = createInitialState(spec);
    const topRes = applyActions(spec, state, [
      { type: 'open_page', message: 'ショップのトップページ' },
    ]);
    assert.equal(topRes.openedPage, 'ショップのトップページ');
    assert.deepEqual(topRes.messages, [
      { text: 'ショップのトップページに移動してしまいました', type: 'warning' },
    ]);

    const signupRes = applyActions(spec, state, [{ type: 'open_page', message: '会員登録' }]);
    assert.equal(signupRes.openedPage, '会員登録');
    assert.deepEqual(signupRes.messages, [
      { text: '会員登録のページに移動してしまいました', type: 'warning' },
    ]);

    // 導入がシステムメッセージのシーン提示から始まること
    assert.equal(ACTIVE_THEME.introScript[0]?.speaker, 'system');

    // 全員達成時の店長の締めセリフが、店の指標達成有無に応じて変化すること
    const withSubClosing = buildOwnerClosingLines(ACTIVE_THEME.owner, {
      orders: 3,
      customers: 3,
      metrics: [{ label: '定期便', count: 1, missing: false }],
      comment: '',
    });
    assert.equal(withSubClosing.length, 2);
    assert.ok(withSubClosing[1].includes('定期便も1件'));

    const withoutSubClosing = buildOwnerClosingLines(ACTIVE_THEME.owner, {
      orders: 3,
      customers: 3,
      metrics: [{ label: '定期便', count: 0, missing: true }],
      comment: '',
    });
    assert.equal(withoutSubClosing.length, 2);
    assert.ok(withoutSubClosing[1].includes('まずはちゃんと買ってもらえる画面が一番'));
    assert.ok(withSubClosing[0].includes('3人とも'));
  });

  it('代引き手数料が合計金額に反映され、定義順が逆でも収束計算され、作業ログも日本語になる', () => {
    const spec = cleanSpec();
    const initial = createInitialState(spec);
    assert.equal(initial.codFee, 0);
    assert.equal(initial.total, 2580);

    // 代金引換を選ぶと +330 円が合計に入る
    const codState = withDerivedValues(spec, { ...initial, paymentMethod: '代金引換' });
    assert.equal(codState.codFee, 330);
    assert.equal(codState.total, 2910);

    // AIが後から計算値を足して、total の後ろに extraFee が並んだ場合でも total に反映される
    const patched = applyPatchesToSpecWithValidation(spec, '手数料を反映しました', [
      { op: 'upsert_derived', key: 'total', expression: 'subtotal + shipping + codFee' },
      { op: 'upsert_derived', key: 'codFee', expression: "paymentMethod == '代金引換' ? 330 : 0" },
    ]);
    assert.equal(patched.rolledBack, false);
    const reorderedSpec: AppSpec = {
      ...patched.updatedSpec,
      derived: [
        { key: 'subtotal', expression: 'unitPrice * quantity' },
        { key: 'shipping', expression: 'subtotal >= 3960 ? 0 : shippingFee' },
        { key: 'total', expression: 'subtotal + shipping + extraFee' },
        { key: 'extraFee', expression: "paymentMethod == '代金引換' ? 330 : 0" },
      ],
    };
    const reorderedState = withDerivedValues(reorderedSpec, {
      ...createInitialState(reorderedSpec),
      paymentMethod: '代金引換',
    });
    assert.equal(reorderedState.extraFee, 330);
    assert.equal(reorderedState.total, 2910);

    // 作業ログに codFee などの英語キーが出ないこと
    const stepTexts = (patched.workSteps ?? []).map((s) => s.text);
    assert.ok(stepTexts.some((t) => t.includes('代引き手数料')));
    assert.ok(stepTexts.every((t) => !t.includes('codFee')));
  });

  it('定期便を正直で読みやすい選択欄に直すと、注意書きを読む客が自ら申し込み店長も喜ぶ', () => {
    const base = cleanSpec();
    // 最初は極小文字で最初からチェック入りの定期便罠がある画面
    const trapSpec: AppSpec = {
      ...base,
      state: [
        ...base.state,
        { key: 'subscription', label: '定期便', type: 'boolean', initialValue: true },
      ],
      components: [
        ...base.components,
        {
          id: 'check-subscription',
          type: 'checkbox',
          role: 'trap',
          label: '定期便でのお届けに同意する（毎月自動発送・解約は電話のみ）',
          stateKey: 'subscription',
          style: { variant: 'muted', size: 'xs' },
          actions: [],
        },
      ],
    };

    // 正直な定期便（最初からOFF・読める文字サイズ・解約縛りなし）に改修する
    const reformed = applyPatchesToSpecWithValidation(trapSpec, '定期便を正直な選択欄に直しました', [
      {
        op: 'upsert_state',
        variable: { key: 'subscription', label: '定期便', type: 'boolean', initialValue: false },
      },
      {
        op: 'replace_component',
        component: {
          id: 'check-subscription',
          type: 'checkbox',
          role: 'trap',
          label: '定期便でお届け（毎回10%引き・いつでも解約OK）',
          stateKey: 'subscription',
          style: { variant: 'default', size: 'sm' },
          actions: [],
        },
      },
    ]);

    assert.equal(reformed.rolledBack, false);
    // 店長が前向きな反応を返すこと
    assert.ok(reformed.ownerReaction?.includes('消さずに分かりやすく残してくれた'));
    assert.ok((reformed.ownerFacts ?? []).some((f) => f.includes('正直で分かりやすい形に整えた')));

    // 後悔したくない客層（no_regret）で試すと、注意書きを読む客（美穂）が納得して定期便を申し込み、3人とも達成かつ店長の定期便件数も1件になる
    const noRegretPersonas = getReviewersByCohort('no_regret');
    const results = noRegretPersonas.map((p) => simulatePersonaComputerUse(reformed.updatedSpec, p));
    assert.equal(results.filter((r) => r.outcome === 'achieved').length, 3);
    const ownerReport = buildOwnerReport(ACTIVE_THEME.owner, reformed.updatedSpec, results);
    const subMetric = ownerReport.metrics.find((m) => m.label === '定期便');
    assert.ok((subMetric?.count ?? 0) >= 1);

    // 店長の関心事（定期便・広告・煽り・今すぐ購入）と無関係な改修では、店長の事実リストが空になり毎回同じ小言を繰り返さない
    const unrelated = applyPatchesToSpecWithValidation(reformed.updatedSpec, '合計欄を大きくしました', [
      {
        op: 'replace_component',
        component: {
          ...reformed.updatedSpec.components.find((c) => c.id === 'card-total')!,
          style: { variant: 'primary', size: 'lg' },
        },
      },
    ]);
    assert.deepEqual(unrelated.ownerFacts, []);
    assert.equal(unrelated.ownerReaction, '');

    // プロトタイプ汚染キー（__proto__, constructor, prototype）や不正CSS値が安全に拒否・無害化されること
    const state = createInitialState(reformed.updatedSpec);
    assert.equal(evaluateExpression('constructor', state), 0);
    assert.equal(evaluateExpression('__proto__', state), 0);
    assert.equal(renderTemplate('{constructor}{__proto__}', state), '');
    const unsafePatched = applySpecPatches(reformed.updatedSpec, [
      {
        op: 'upsert_state',
        variable: { key: '__proto__', label: '危険', type: 'string', initialValue: 'polluted' },
      },
      { op: 'upsert_derived', key: 'constructor', expression: '1 + 1' },
    ]);
    assert.equal(unsafePatched.spec.state.some((s) => s.key === '__proto__'), false);
    assert.equal(unsafePatched.spec.derived?.some((d) => d.key === 'constructor'), false);

    // カスタムHTML・カスタムCSS・テーマ色のサニタイズ検証
    assert.equal(sanitizeCssColor('#ff0000', '#ffffff'), '#ff0000');
    assert.equal(sanitizeCssColor('red; background: url(https://evil.example)', '#ffffff'), '#ffffff');
    const sanitizedCss = sanitizeCustomCss(
      'padding: 8px; background: url("https://evil.example/x.png"); @import "https://evil.example"; width: expression(alert(1));',
    );
    assert.ok(!sanitizedCss.includes('url('));
    assert.ok(!sanitizedCss.includes('@import'));
    assert.ok(!sanitizedCss.includes('expression('));
    const sanitizedHtml = sanitizeCustomHtml(
      '<div>安全<script>alert(1)</script><style>body{display:none}</style><a href="javascript:alert(1)" onclick="alert(2)">リンク</a></div>',
    );
    assert.ok(!sanitizedHtml.includes('<script'));
    assert.ok(!sanitizedHtml.includes('<style'));
    assert.ok(!sanitizedHtml.includes('javascript:'));
    assert.ok(!sanitizedHtml.includes('onclick='));
  });

  it('広告を削除せずに閉じるボタンの位置・大きさ・文字を変えたりバナー化する工夫も通り、客も店長も納得する', () => {
    const withPopup = withAnnoyance(cleanSpec(), 'coupon_popup');
    // 初期状態では目が遠い客（和子）は閉じるボタンが極小で閉じられず離脱し、翔太も不満になる
    assert.equal(outcomeOf(withPopup, 'kazuko'), 'abandoned');
    assert.equal(outcomeOf(withPopup, 'shota'), 'bothered');

    // 1. 広告を削除せず、閉じるボタンを下部バー（大きく押しやすい「あとで見る」）に改造する
    const popupComp = findComponent(withPopup, 'popup-coupon');
    const renovatedPopup = applyPatchesToSpecWithValidation(
      withPopup,
      '広告の閉じるボタンを下部に大きく配置しました',
      [
        {
          op: 'replace_component',
          component: {
            ...popupComp,
            closePosition: 'bottom-bar',
            closeSize: 'lg',
            closeLabel: 'あとで見る',
            style: { ...popupComp.style, skin: 'native', variant: 'default' },
            actions: [{ type: 'set_state', targetKey: 'couponApplied', value: true }],
          },
        },
      ],
    );
    assert.equal(renovatedPopup.rolledBack, false);
    // 作業ログに位置変更や文字変更が出ること
    const stepTexts = (renovatedPopup.workSteps ?? []).map((s) => s.text);
    assert.ok(stepTexts.some((t) => t.includes('閉じるボタンの位置')));
    // 店長も広告を残して工夫したことを喜ぶ
    assert.ok(renovatedPopup.ownerReaction?.includes('広告を消さずに押しやすく工夫して残してくれた'));
    // 目が遠い和子も翔太も嫌な思いをせず達成できる
    assert.equal(outcomeOf(renovatedPopup.updatedSpec, 'kazuko'), 'achieved');
    assert.equal(outcomeOf(renovatedPopup.updatedSpec, 'shota'), 'achieved');

    // 2. 広告を画面埋め尽くしポップアップからインラインの控えめなバナーに改造した場合も達成・店長納得になる
    const bannerized = applyPatchesToSpecWithValidation(
      withPopup,
      '広告を画面内の控えめなクーポンバナーに変えました',
      [
        {
          op: 'replace_component',
          component: {
            ...popupComp,
            type: 'status_banner',
            role: 'info',
            label: '🎁 今なら300円OFFクーポンをご利用いただけます',
            style: { variant: 'default', size: 'sm', skin: 'native' },
            actions: [{ type: 'set_state', targetKey: 'couponApplied', value: true }],
          },
        },
      ],
    );
    assert.equal(bannerized.rolledBack, false);
    assert.ok(bannerized.ownerReaction?.includes('広告を消さずに押しやすく工夫して残してくれた'));
    assert.equal(outcomeOf(bannerized.updatedSpec, 'kazuko'), 'achieved');
    assert.equal(outcomeOf(bannerized.updatedSpec, 'shota'), 'achieved');
  });

  it('サンドボックス内で自由なカスタムHTML部品やワンタップ入力ショートカットを追加して検証できる', () => {
    const base = cleanSpec();
    // 急いでいる健太でも確認ダイアログ付きだと手数が増えて離脱するが、ワンタップで住所と支払いを埋める＋α機能を追加すると達成できる
    findComponent(base, 'btn-order').behavior = { effect: 'confirm_dialog' };
    assert.equal(outcomeOf(base, 'kenta'), 'abandoned');

    const withShortcut = applyPatchesToSpecWithValidation(
      base,
      '前回と同じ設定でワンタップ入力できるカスタム部品を追加しました',
      [
        {
          op: 'insert_component',
          afterId: 'product-card',
          component: {
            id: 'custom-quick-preset',
            type: 'custom',
            role: 'info',
            label: '⚡ いつものお届け先・支払い方法をまとめてセット',
            customHtml:
              '<div class="quick-box"><p>前回の設定：自宅 / クレジットカード</p><button type="button" data-set-state="deliveryAddress" data-value="自宅">ワンタップでセット</button></div>',
            customCss: '.quick-box { padding: 8px; background: #f8fafc; border-radius: 8px; }',
            style: { variant: 'primary', size: 'md' },
            actions: [
              { type: 'set_state', targetKey: 'deliveryAddress', value: '自宅' },
              { type: 'set_state', targetKey: 'paymentMethod', value: 'クレジットカード' },
            ],
          },
        },
      ],
    );
    assert.equal(withShortcut.rolledBack, false);
    assert.equal(outcomeOf(withShortcut.updatedSpec, 'kenta'), 'achieved');
    assert.equal(outcomeOf(withShortcut.updatedSpec, 'harue'), 'achieved');

    // チャット経由での画面巻き戻し判定：全体巻き戻しと特定部品の復元を区別する
    assert.equal(detectCheckpointRevertCommand('1つ前の画面に戻して'), 'undo');
    assert.equal(detectCheckpointRevertCommand('やっぱり元に戻して！'), 'undo');
    assert.equal(detectCheckpointRevertCommand('さっきの変更を取り消して'), 'undo');
    assert.equal(detectCheckpointRevertCommand('一番最初の画面に戻して'), 'reset');
    assert.equal(detectCheckpointRevertCommand('最初からやり直して'), 'reset');
    assert.equal(detectCheckpointRevertCommand('定期便の欄を戻して'), null);
    assert.equal(detectCheckpointRevertCommand('消した広告を戻して'), null);
  });
});
