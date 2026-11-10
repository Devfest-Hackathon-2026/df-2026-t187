import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  AGGREGATE_TIP_BOX_IDS,
  buildAggregateTipFacts,
  buildAggregateTipsPrompt,
  buildPublicComponentLabels,
  composeAggregateTips,
  containsTipBracket,
  extractNumbers,
  findTipRuleViolations,
  isPublicAggregateTips,
  normalizeTipDraft,
  type AggregateTipBoxFacts,
  type AggregateTipDraftRequest,
  type AggregateTipDrafts,
  type AggregateTipTag,
} from '../src/shared/aggregateTips.ts';
import {
  formatPublicAggregateStats,
  type PublicAggregateStats,
  type RawBigQueryAggregatePayload,
} from '../src/shared/promptTelemetry.ts';
import { ACTIVE_THEME, TARGET_COHORTS } from '../src/shared/initialTheme.ts';
import {
  AGGREGATE_TIPS_REFRESH_MS,
  clearAggregateTipsCache,
  getPublicAggregateTips,
  type AggregateTipsDeps,
} from '../src/server/aggregateTips.ts';
import { rateLimitGroupOf } from '../src/server/rateLimit.ts';

// テストは AI と Google Cloud に接続しない前提で実行する（package.json の test スクリプトで接続設定を空にしている）

const COMPONENT_LABELS = buildPublicComponentLabels(ACTIVE_THEME);

/** コツを3つとも出せるだけの挑戦がそろった集計 */
function enoughRaw(): RawBigQueryAggregatePayload {
  return {
    runTotals: { total_runs: 19, cleared_runs: 7, reset_runs: 3, abandoned_runs: 9, avg_execute_turns_on_clear: 3.2 },
    cohortStats: [
      { cohort_id: 'quick', run_count: 8, execute_run_count: 5, cleared_count: 4 },
      { cohort_id: 'careful', run_count: 7, execute_run_count: 5, cleared_count: 2 },
      { cohort_id: 'thrifty', run_count: 4, execute_run_count: 2, cleared_count: 1 },
    ],
    promptTotals: {
      total_prompts: 60,
      execute_prompts: 40,
      rework_prompts: 8,
      removed_needed_prompts: 5,
      execute_run_count: 11,
    },
    archetypeStats: [{ archetype: 'goal_directed', cnt: 20 }],
    entityStats: [{ term: '定期便', cnt: 9 }],
    archetypeOutcomes: [
      { archetype: 'goal_directed', execute_count: 20, run_count: 8, redone_count: 2 },
      { archetype: 'vague_delegate', execute_count: 10, run_count: 5, redone_count: 4 },
      { archetype: 'simple_delete', execute_count: 4, run_count: 2, redone_count: 1 },
      { archetype: 'unknown', execute_count: 6, run_count: 3, redone_count: 1 },
    ],
    componentStats: [
      { component_id: 'check-subscription', run_count: 8, struggle_runs: 3 },
      { component_id: 'popup-coupon', run_count: 6, struggle_runs: 3 },
      { component_id: 'btn-order', run_count: 2, struggle_runs: 2 },
      { component_id: 'my-own-widget-yamada', run_count: 9, struggle_runs: 9 },
    ],
  };
}

function enoughStats(): PublicAggregateStats {
  return formatPublicAggregateStats(enoughRaw(), TARGET_COHORTS, {
    componentLabels: COMPONENT_LABELS,
    generatedAt: '2026-11-10T05:00:00.000Z',
  });
}

function readyFacts(): AggregateTipBoxFacts[] {
  return buildAggregateTipFacts(enoughStats());
}

const TAGS: AggregateTipTag[] = [
  { text: '目的を伝えた指示 やり直し10%', title: '' },
  { text: '丸投げした指示 やり直し40%', title: '' },
];

const GOOD_DRAFT = {
  heading: '目的から伝えてみる',
  body: '目的を伝えた指示はやり直しが10%と少なめでした。何のために直すのかを添えた人が多いようです。',
};

describe('みんなの集計のコツ', () => {
  beforeEach(() => {
    clearAggregateTipsCache();
  });

  it('集計は指示の型と部品のやり直しを3件以上の挑戦があるときだけ出し、題材にない部品は出さない', () => {
    const stats = enoughStats();
    assert.equal(stats.redoneRatePercent, 20); // (2 + 4 + 1 + 1) / 40
    const goal = stats.archetypeOutcomes?.find((o) => o.archetype === 'goal_directed');
    assert.equal(goal?.suppressed, false);
    assert.equal(goal?.redoneRatePercent, 10);
    const simple = stats.archetypeOutcomes?.find((o) => o.archetype === 'simple_delete');
    assert.equal(simple?.suppressed, true);
    assert.equal(simple?.redoneRatePercent, undefined);
    assert.equal(simple?.runsNeeded, 1);

    const labels = stats.componentStats?.map((c) => c.label) ?? [];
    assert.ok(labels.includes('定期便の選択欄'));
    assert.ok(labels.includes('クーポン広告のポップアップ'));
    assert.ok(!labels.some((l) => l.includes('yamada') || l.includes('my-own')));
    const order = stats.componentStats?.find((c) => c.label === '注文確定ボタン');
    assert.equal(order?.suppressed, true);
    assert.equal(order?.struggleRatePercent, undefined);

    const quick = stats.cohorts.find((c) => c.cohortId === 'quick');
    // 客層のクリア率は、手直しを1回以上した挑戦（execute_run_count = 5）を分母にする
    assert.equal(quick?.suppressed, false);
    assert.equal(quick?.runCount, 8);
    assert.equal(quick?.executeRunCount, 5);
    assert.equal(quick?.clearRatePercent, 80);

    // 挑戦全体が4件あっても、手直しをした挑戦が2件なら伏せる
    const thrifty = stats.cohorts.find((c) => c.cohortId === 'thrifty');
    assert.equal(thrifty?.suppressed, true);
    assert.equal(thrifty?.runsNeeded, 1);
  });

  it('タグはコードで決め、1ボックス3個までにする', () => {
    const facts = readyFacts();
    assert.deepEqual(
      facts.map((f) => f.id),
      [...AGGREGATE_TIP_BOX_IDS],
    );
    assert.ok(facts.every((f) => f.status === 'ready'));
    assert.ok(facts.every((f) => f.tags.length >= 1 && f.tags.length <= 3));

    const [phrasing, stumbling, blindspot] = facts;
    // 指示全体のやり直しタグは出さず、型ごとのタグだけを並べる
    assert.deepEqual(
      phrasing.tags.map((t) => t.text),
      ['目的を伝えた指示 やり直し10%', '丸投げした指示 やり直し40%'],
    );
    // 件数はマウスを乗せたときの title にだけ出す
    assert.match(phrasing.tags[0].title, /20件/);
    assert.ok(!/件/.test(phrasing.tags[0].text));

    // つまずきやすい所は挑戦ごとの割合なので「何度も直した」と表す
    assert.deepEqual(
      stumbling.tags.map((t) => t.text),
      ['クーポン広告のポップアップ 何度も直した50%', '定期便の選択欄 何度も直した38%', '話題の多い言葉 定期便'],
    );

    // 5件に満たない客層 thrifty はタグにしない。クリア率の低い客層と高い客層を出す
    assert.deepEqual(
      blindspot.tags.map((t) => t.text),
      ['必要な機能を消した指示 13%', '確実に買いたい人 クリア40%', 'さっと買いたい人 クリア80%'],
    );
    assert.match(blindspot.tags[1].title, /確実に買いたい人を選んで1回以上手直しした5件の挑戦のうち、クリアした割合/);
    assert.match(blindspot.tags[2].title, /さっと買いたい人を選んで1回以上手直しした5件の挑戦のうち、クリアした割合/);
  });

  it('全体の挑戦が足りないときは3つとも集計中にし、5件までに必要な件数を出す', () => {
    const stats = formatPublicAggregateStats(
      { runTotals: { total_runs: 1, cleared_runs: 1 } },
      TARGET_COHORTS,
      { componentLabels: COMPONENT_LABELS },
    );
    const facts = buildAggregateTipFacts(stats);
    assert.ok(facts.every((f) => f.status === 'collecting' && f.runsNeeded === 4 && f.tags.length === 0));
  });

  it('3件以上の公開の決まりを満たしていても、5件未満の区分はコツの根拠から外し、足りなければ集計中にする', () => {
    const raw = enoughRaw();
    // 4件（公開はされるが、コツの根拠の5件には足りない）と2件（非公開）
    raw.archetypeOutcomes = [
      { archetype: 'goal_directed', execute_count: 6, run_count: 4, redone_count: 1 },
      { archetype: 'simple_delete', execute_count: 3, run_count: 2, redone_count: 1 },
    ];
    raw.componentStats = [
      { component_id: 'check-subscription', run_count: 3, struggle_runs: 2 },
      { component_id: 'popup-coupon', run_count: 1, struggle_runs: 1 },
    ];
    raw.entityStats = [{ term: '定期便', cnt: 4 }];
    raw.cohortStats = [
      { cohort_id: 'quick', run_count: 6, execute_run_count: 4, cleared_count: 3 },
      { cohort_id: 'careful', run_count: 5, execute_run_count: 5, cleared_count: 2 },
    ];
    const stats = formatPublicAggregateStats(raw, TARGET_COHORTS, { componentLabels: COMPONENT_LABELS });
    // 公開データとしては 3件以上の区分は suppressed: false のまま残る
    assert.equal(stats.archetypeOutcomes?.find((o) => o.archetype === 'goal_directed')?.suppressed, false);
    assert.equal(stats.componentStats?.find((c) => c.label === '定期便の選択欄')?.suppressed, false);
    assert.equal(stats.cohorts.find((c) => c.cohortId === 'quick')?.suppressed, false);

    const facts = buildAggregateTipFacts(stats);
    assert.equal(facts[0].status, 'collecting');
    assert.equal(facts[0].runsNeeded, 1); // 4件 → 5件まであと1件
    assert.equal(facts[1].status, 'collecting');
    assert.equal(facts[1].runsNeeded, 2); // 3件 → 5件まであと2件
    assert.equal(facts[2].status, 'ready');
    // quick は execute_run_count が4件なので外れ、5件ある careful だけが客層タグになる
    assert.deepEqual(
      facts[2].tags.map((t) => t.text),
      ['必要な機能を消した指示 13%', '確実に買いたい人 クリア40%'],
    );

    // executeCount が5未満の型や、全体の手直し挑戦数が5未満のときも集計中にする
    raw.archetypeOutcomes = [{ archetype: 'goal_directed', execute_count: 4, run_count: 5, redone_count: 1 }];
    raw.cohortStats = [{ cohort_id: 'careful', run_count: 6, execute_run_count: 4, cleared_count: 2 }];
    raw.promptTotals = { ...raw.promptTotals, execute_run_count: 4 };
    const allCollecting = buildAggregateTipFacts(
      formatPublicAggregateStats(raw, TARGET_COHORTS, { componentLabels: COMPONENT_LABELS }),
    );
    assert.deepEqual(
      allCollecting.map((f) => [f.id, f.status, f.runsNeeded]),
      [
        ['phrasing', 'collecting', 1],
        ['stumbling', 'collecting', 2],
        ['blindspot', 'collecting', 1],
      ],
    );
  });

  it('BigQuery を読めないときは3つとも unavailable にする', () => {
    const facts = buildAggregateTipFacts(formatPublicAggregateStats(null, TARGET_COHORTS));
    assert.ok(facts.every((f) => f.status === 'unavailable' && f.tags.length === 0));
  });

  it('括弧は全角も半角もすべて見つける', () => {
    for (const ch of ['(', ')', '（', '）', '「', '」', '『', '』', '【', '】', '[', ']', '［', '］', '{', '}', '〈', '》', '〔', '<', '＜']) {
      assert.equal(containsTipBracket(`目的を${ch}伝える`), true, ch);
      const violations = findTipRuleViolations({ heading: '目的を伝える', body: `目的を${ch}伝えた人が多いようです。` }, TAGS);
      assert.ok(violations.some((v) => v.includes('括弧')), ch);
    }
    assert.equal(containsTipBracket('目的を伝えた人が多いようです。'), false);
  });

  it('見出しは15文字までにし、最後の句点は取る', () => {
    const fifteen = 'あいうえおかきくけこさしすせそ';
    assert.equal([...fifteen].length, 15);
    assert.deepEqual(findTipRuleViolations({ heading: fifteen, body: GOOD_DRAFT.body }, TAGS), []);
    assert.ok(
      findTipRuleViolations({ heading: `${fifteen}た`, body: GOOD_DRAFT.body }, TAGS).some((v) => v.includes('15文字')),
    );
    assert.equal(normalizeTipDraft({ heading: ' 目的から伝えてみる。 ', body: 'x' }).heading, '目的から伝えてみる');
    assert.ok(
      findTipRuleViolations({ heading: '目的。伝える', body: GOOD_DRAFT.body }, TAGS).some((v) => v.includes('句点')),
    );
  });

  it('本文の数字はそのボックスのタグの数字だけを許す', () => {
    assert.deepEqual(findTipRuleViolations(GOOD_DRAFT, TAGS), []);
    // 全角の数字もタグの数字と照らし合わせる
    assert.deepEqual(
      findTipRuleViolations({ heading: GOOD_DRAFT.heading, body: '丸投げした指示は４０%がやり直しになりました。' }, TAGS),
      [],
    );
    const stray = findTipRuleViolations(
      { heading: GOOD_DRAFT.heading, body: '目的を伝えた指示は12%でした。' },
      TAGS,
    );
    assert.ok(stray.some((v) => v.includes('12')));
    // 見出しの数字も確かめる
    assert.ok(findTipRuleViolations({ heading: '3回で決める', body: GOOD_DRAFT.body }, TAGS).length > 0);
    // 漢数字の割合や件数も弾く
    assert.ok(
      findTipRuleViolations({ heading: GOOD_DRAFT.heading, body: '三割の人がやり直しました。' }, TAGS).some((v) =>
        v.includes('漢数字'),
      ),
    );
    assert.deepEqual(extractNumbers('１２.５と3'), ['12.5', '3']);
  });

  it('本文は2文まで、言い切りは使わない', () => {
    const three = findTipRuleViolations(
      { heading: GOOD_DRAFT.heading, body: '目的を伝えましょう。少なめでした。多いようです。' },
      TAGS,
    );
    assert.ok(three.some((v) => v.includes('2文')));
    const assertive = findTipRuleViolations(
      { heading: GOOD_DRAFT.heading, body: '目的を伝えると必ずうまくいきます。' },
      TAGS,
    );
    assert.ok(assertive.some((v) => v.includes('言い切り')));
    assert.deepEqual(
      findTipRuleViolations({ heading: GOOD_DRAFT.heading, body: '必ずしも一度で決まるわけではないようです。' }, TAGS),
    [],
    );
  });

  it('具体的な画面の直し方（答えそのもの）に踏み込んだ案は弾き、部品の名前だけでは弾かない', () => {
    for (const spoiler of [
      '広告をバナーに変えてみましょう。',
      '閉じるボタンを見やすくしてみましょう。',
      '最初からオフにしておくと安心です。',
      '定期便のチェックを外しておきましょう。',
      '確認画面を足してみるとよさそうです。',
      'ボタンを大きくしてみるとよさそうです。',
    ]) {
      const violations = findTipRuleViolations({ heading: GOOD_DRAFT.heading, body: spoiler }, TAGS);
      assert.ok(violations.some((v) => v.includes('具体的な直し方')), spoiler);
    }
    assert.ok(
      findTipRuleViolations({ heading: 'バナーに変えてみる', body: GOOD_DRAFT.body }, TAGS).some((v) =>
        v.includes('具体的な直し方'),
      ),
    );
    // 題材の部品の役割名そのものは違反にならない
    for (const label of COMPONENT_LABELS.values()) {
      assert.deepEqual(
        findTipRuleViolations(
          { heading: '迷ったら聞いてみる', body: `${label}は手こずる人が多かったようです。` },
          TAGS,
        ),
        [],
        label,
      );
    }
  });

  it('テンプレートの文は、どの組み合わせでも決まりに合っている', () => {
    const variants: RawBigQueryAggregatePayload[] = [];
    variants.push(enoughRaw());
    for (const archetype of ['goal_directed', 'condition_design', 'direct_fix', 'simple_delete', 'vague_delegate']) {
      const raw = enoughRaw();
      raw.archetypeOutcomes = [{ archetype, execute_count: 10, run_count: 5, redone_count: 1 }];
      raw.componentStats = [];
      raw.cohortStats = [{ cohort_id: 'careful', run_count: 6, execute_run_count: 5, cleared_count: 1 }];
      raw.promptTotals = { ...raw.promptTotals, execute_run_count: 2 };
      variants.push(raw);
    }
    for (const raw of variants) {
      const facts = buildAggregateTipFacts(
        formatPublicAggregateStats(raw, TARGET_COHORTS, { componentLabels: COMPONENT_LABELS }),
      );
      for (const box of facts.filter((f) => f.status === 'ready')) {
        assert.deepEqual(findTipRuleViolations(box.template, box.tags), [], `${box.id}: ${box.template.body}`);
      }
    }
  });

  it('プロンプトにはタグと決まりを入れ、件数や発言の本文は入れない', () => {
    const facts = readyFacts();
    const prompt = buildAggregateTipsPrompt({ boxes: facts, feedback: { phrasing: ['括弧が使われています。'] } });
    assert.ok(prompt.includes('目的を伝えた指示 やり直し10%'));
    assert.ok(prompt.includes('括弧を一切使わない'));
    assert.ok(prompt.includes('15文字以内'));
    assert.ok(prompt.includes('前回の案はここが決まりに外れていた'));
    // 件数は title にだけ入れ、Gemini には渡さない
    assert.ok(!prompt.includes('20件'));
  });

  it('決まりに合った案は Gemini の文として使う', async () => {
    const facts = readyFacts();
    const calls: AggregateTipDraftRequest[] = [];
    const drafter = async (req: AggregateTipDraftRequest): Promise<AggregateTipDrafts> => {
      calls.push(req);
      return {
        phrasing: GOOD_DRAFT,
        stumbling: { heading: '迷ったら聞いてみる', body: 'クーポン広告のポップアップは50%でやり直しがありました。' },
        blindspot: { heading: '消す前に考える', body: '必要な機能を消した指示が13%ありました。' },
      };
    };
    const boxes = await composeAggregateTips(facts, drafter);
    assert.equal(calls.length, 1);
    assert.deepEqual(boxes.map((b) => b.source), ['gemini', 'gemini', 'gemini']);
    assert.equal(boxes[0].heading, GOOD_DRAFT.heading);
  });

  it('決まりに外れた案は1回だけ作り直させ、外れた点を伝える', async () => {
    const facts = readyFacts();
    const calls: AggregateTipDraftRequest[] = [];
    const drafter = async (req: AggregateTipDraftRequest): Promise<AggregateTipDrafts> => {
      calls.push(req);
      if (calls.length === 1) {
        return {
          phrasing: { heading: '「目的」から伝える', body: GOOD_DRAFT.body },
          stumbling: { heading: '迷ったら聞いてみる', body: 'クーポン広告のポップアップは50%でやり直しがありました。' },
          blindspot: { heading: '消す前に考える', body: '必要な機能を消した指示が99%ありました。' },
        };
      }
      return {
        phrasing: GOOD_DRAFT,
        blindspot: { heading: '消す前に考える', body: '必要な機能を消した指示が13%ありました。' },
      };
    };
    const boxes = await composeAggregateTips(facts, drafter);
    assert.equal(calls.length, 2);
    // 作り直しでは、外れたボックスだけを頼み、外れた点を伝える
    assert.deepEqual(calls[1].boxes.map((b) => b.id), ['phrasing', 'blindspot']);
    assert.ok(calls[1].feedback.phrasing?.some((v) => v.includes('括弧')));
    assert.ok(calls[1].feedback.blindspot?.some((v) => v.includes('99')));
    assert.deepEqual(boxes.map((b) => b.source), ['gemini', 'gemini', 'gemini']);
  });

  it('作り直してもだめなら、そのボックスだけテンプレートの文にする', async () => {
    const facts = readyFacts();
    let count = 0;
    const drafter = async (): Promise<AggregateTipDrafts> => {
      count++;
      return {
        phrasing: { heading: 'とても長くて十五文字を超えてしまう見出し', body: GOOD_DRAFT.body },
        stumbling: { heading: '迷ったら聞いてみる', body: 'クーポン広告のポップアップは50%でやり直しがありました。' },
        blindspot: { heading: '消す前に考える', body: '必要な機能を消した指示が13%ありました。' },
      };
    };
    const boxes = await composeAggregateTips(facts, drafter);
    assert.equal(count, 2);
    assert.equal(boxes[0].source, 'template');
    assert.equal(boxes[0].heading, facts[0].template.heading);
    assert.equal(boxes[0].body, facts[0].template.body);
    assert.equal(boxes[1].source, 'gemini');
    assert.equal(boxes[2].source, 'gemini');
  });

  it('Gemini が使えないときや失敗したときは、作り直さずにテンプレートの文にする', async () => {
    const facts = readyFacts();
    const none = await composeAggregateTips(facts, async () => null);
    assert.ok(none.every((b) => b.source === 'template'));
    let count = 0;
    const failing = await composeAggregateTips(facts, async () => {
      count++;
      throw new Error('timeout');
    });
    assert.equal(count, 1);
    assert.ok(failing.every((b) => b.source === 'template'));
    const noDrafter = await composeAggregateTips(facts, null);
    assert.ok(noDrafter.every((b) => b.source === 'template'));
  });

  it('集計中のボックスは Gemini に頼まない', async () => {
    const stats = formatPublicAggregateStats({ runTotals: { total_runs: 2 } }, TARGET_COHORTS);
    let count = 0;
    const boxes = await composeAggregateTips(buildAggregateTipFacts(stats), async () => {
      count++;
      return {};
    });
    assert.equal(count, 0);
    assert.ok(boxes.every((b) => b.status === 'collecting' && b.runsNeeded === 3 && b.heading === undefined));
  });

  it('タグが変わっていなければ、前に作った Gemini の文を使い回す', async () => {
    const facts = readyFacts();
    const first = await composeAggregateTips(facts, async () => ({
      phrasing: GOOD_DRAFT,
      stumbling: { heading: '迷ったら聞いてみる', body: 'クーポン広告のポップアップは50%でやり直しがありました。' },
      blindspot: { heading: '消す前に考える', body: '必要な機能を消した指示が13%ありました。' },
    }));
    let count = 0;
    const second = await composeAggregateTips(
      facts,
      async () => {
        count++;
        return null;
      },
      { previous: first },
    );
    assert.equal(count, 0);
    assert.deepEqual(second, first);
  });

  it('コツは1時間ごとに作り直し、その間は保存したものを返す', async () => {
    let now = Date.parse('2026-11-10T05:00:00.000Z');
    let draftCalls = 0;
    let loadCalls = 0;
    const written: string[] = [];
    const deps: AggregateTipsDeps = {
      loadStats: async () => {
        loadCalls++;
        return enoughStats();
      },
      drafter: async () => {
        draftCalls++;
        return { phrasing: GOOD_DRAFT };
      },
      readStored: async () => null,
      writeStored: async (key) => {
        written.push(key);
      },
      now: () => now,
    };
    const first = await getPublicAggregateTips(undefined, deps);
    assert.equal(first.available, true);
    assert.equal(first.boxes[0].source, 'gemini');
    // 案のなかった2つのボックスは1回だけ作り直させ、テンプレートの文にした
    assert.equal(draftCalls, 2);
    assert.deepEqual(written, ['all']);

    now += 30 * 60 * 1000;
    const again = await getPublicAggregateTips(undefined, deps);
    assert.equal(again, first);
    assert.equal(loadCalls, 1);
    assert.equal(draftCalls, 2);

    // 1時間を過ぎたら、保存したものを返しつつ裏で作り直す
    now += AGGREGATE_TIPS_REFRESH_MS;
    const stale = await getPublicAggregateTips(undefined, deps);
    assert.equal(stale, first);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loadCalls, 2);
    const fresh = await getPublicAggregateTips(undefined, deps);
    assert.notEqual(fresh.generatedAt, first.generatedAt);
    // 前回と同じタグの Gemini の文は使い回し、テンプレートだったボックスだけ頼み直す
    assert.equal(fresh.boxes[0].heading, GOOD_DRAFT.heading);
  });

  it('保存したコツが新しければ、Gemini も BigQuery も呼ばずに返す', async () => {
    const now = Date.parse('2026-11-10T05:10:00.000Z');
    const stored = {
      available: true,
      generatedAt: '2026-11-10T05:00:00.000Z',
      segment: { kind: 'all' as const },
      minRunsForDisplay: 3,
      boxes: await composeAggregateTips(readyFacts(), null),
    };
    assert.ok(isPublicAggregateTips(stored));
    let calls = 0;
    const deps: AggregateTipsDeps = {
      loadStats: async () => {
        calls++;
        return enoughStats();
      },
      drafter: async () => {
        calls++;
        return null;
      },
      readStored: async () => stored,
      writeStored: async () => {},
      now: () => now,
    };
    const tips = await getPublicAggregateTips(undefined, deps);
    assert.deepEqual(tips, stored);
    assert.equal(calls, 0);

    // 形や決まりに合わない保存は使わない
    assert.equal(isPublicAggregateTips({ ...stored, boxes: stored.boxes.slice(0, 2) }), false);
    const broken = structuredClone(stored);
    broken.boxes[0].heading = '「括弧つき」';
    assert.equal(isPublicAggregateTips(broken), false);
  });

  it('BigQuery がつながっていなくても壊れずに3つのボックスを返す', async () => {
    const tips = await getPublicAggregateTips();
    assert.equal(tips.available, false);
    assert.deepEqual(
      tips.boxes.map((b) => [b.id, b.status]),
      [
        ['phrasing', 'unavailable'],
        ['stumbling', 'unavailable'],
        ['blindspot', 'unavailable'],
      ],
    );
    assert.equal(rateLimitGroupOf('GET', '/api/aggregate-tips'), 'record');
  });

  it('一時的に BigQuery を読めなくなっても、前に作ったコツを出し続ける', async () => {
    let now = Date.parse('2026-11-10T05:00:00.000Z');
    let available = true;
    const deps: AggregateTipsDeps = {
      loadStats: async () => (available ? enoughStats() : formatPublicAggregateStats(null, TARGET_COHORTS)),
      drafter: null,
      readStored: async () => null,
      writeStored: async () => {},
      now: () => now,
    };
    const first = await getPublicAggregateTips(undefined, deps);
    available = false;
    now += AGGREGATE_TIPS_REFRESH_MS + 1;
    await getPublicAggregateTips(undefined, deps);
    await new Promise((resolve) => setImmediate(resolve));
    const after = await getPublicAggregateTips(undefined, deps);
    assert.equal(after, first);
  });
});
