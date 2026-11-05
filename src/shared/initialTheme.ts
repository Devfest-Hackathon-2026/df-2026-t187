import type { AppSpec, ReviewerPersona, TargetCohortId, TargetCohortInfo } from './types.ts';

export const TARGET_COHORTS: TargetCohortInfo[] = [
  {
    id: 'elderly',
    label: '高齢者',
    shortDesc: '目が遠い・指が震える・スマホに不慣れな3人',
  },
  {
    id: 'office_worker',
    label: '忙しい会社員',
    shortDesc: '時間がない・片手で操作・移動中に使う3人',
  },
  {
    id: 'student',
    label: '朝が弱い学生',
    shortDesc: '寝ぼけている・二度寝常習・暗い部屋で使う3人',
  },
];

// 企画書 2章「層の中の3人と、制約変数」に基づく9人分のプロフィールと数値制約
export const ALL_REVIEWER_PERSONAS: ReviewerPersona[] = [
  // ==================== 1. 高齢者層 ====================
  {
    id: 'kazuko',
    cohortId: 'elderly',
    traitLabel: '目が遠い',
    name: '和子',
    age: 74,
    role: '目が遠いおばあちゃん',
    icon: '和',
    goal: 'メガネなしでも大きく見やすい文字で予約したい',
    focusPoint: '時刻やボタンが特大サイズで、赤い消去ボタンと迷わないか',
    constraints: {
      blurPx: 3.5,
      contrast: 0.62,
      jitterPx: 8,
      maxSteps: 3,
      patienceMs: 6000,
      environment: 'normal',
      voicePitch: 1.15,
      voiceRate: 0.85,
    },
  },
  {
    id: 'shigeru',
    cohortId: 'elderly',
    traitLabel: '指が震える',
    name: '茂',
    age: 78,
    role: '指先が少し震えるおじいちゃん',
    icon: '茂',
    goal: '指がズレても押し間違えずにアラームをセットしたい',
    focusPoint: 'ボタンが十分に大きく、隣に危険なリセットボタンがないか',
    constraints: {
      blurPx: 1.2,
      contrast: 0.85,
      jitterPx: 26,
      maxSteps: 3,
      patienceMs: 6000,
      environment: 'normal',
      voicePitch: 0.78,
      voiceRate: 0.82,
    },
  },
  {
    id: 'harue',
    cohortId: 'elderly',
    traitLabel: 'スマホに不慣れ',
    name: '春江',
    age: 71,
    role: 'スマホを買ったばかりの主婦',
    icon: '春',
    goal: 'どれを押せばいいか迷わないシンプルな画面で使いたい',
    focusPoint: '気合い度やポエムなどの無関係な項目がなく、1回で予約できるか',
    constraints: {
      blurPx: 1.5,
      contrast: 0.88,
      jitterPx: 10,
      maxSteps: 2,
      patienceMs: 5000,
      environment: 'normal',
      voicePitch: 1.22,
      voiceRate: 0.88,
    },
  },

  // ==================== 2. 忙しい会社員層 ====================
  {
    id: 'kenta',
    cohortId: 'office_worker',
    traitLabel: '時間がない',
    name: '健太',
    age: 29,
    role: '残業帰りで1秒でも早く寝たい会社員',
    icon: '健',
    goal: '布団に入って1タップだけですぐアラームを予約したい',
    focusPoint: '邪魔な項目や面倒なクイズがなく、1手で即座に予約完了できるか',
    constraints: {
      blurPx: 0.5,
      contrast: 0.95,
      jitterPx: 6,
      maxSteps: 1,
      patienceMs: 2000,
      environment: 'normal',
      voicePitch: 0.92,
      voiceRate: 1.25,
    },
  },
  {
    id: 'misaki',
    cohortId: 'office_worker',
    traitLabel: '片手で操作',
    name: '美咲',
    age: 34,
    role: '荷物を持って片手親指だけで操作する会社員',
    icon: '美',
    goal: '片手の親指だけで端まで指を伸ばさずに予約したい',
    focusPoint: '予約ボタンが横幅いっぱいか中央に大きく配置されているか',
    constraints: {
      blurPx: 0.8,
      contrast: 0.92,
      jitterPx: 20,
      maxSteps: 2,
      patienceMs: 3200,
      environment: 'one_hand',
      voicePitch: 1.12,
      voiceRate: 1.15,
    },
  },
  {
    id: 'takumi',
    cohortId: 'office_worker',
    traitLabel: '移動中に使う',
    name: '拓海',
    age: 26,
    role: '揺れる電車の中で翌朝のセットをする営業職',
    icon: '拓',
    goal: '電車が揺れても誤タップで設定が消えない画面がいい',
    focusPoint: '揺れて指がズレても全部消すボタンを押してしまう危険がないか',
    constraints: {
      blurPx: 1.8,
      contrast: 0.85,
      jitterPx: 24,
      maxSteps: 2,
      patienceMs: 3000,
      environment: 'moving_train',
      voicePitch: 0.96,
      voiceRate: 1.18,
    },
  },

  // ==================== 3. 朝が弱い学生層 ====================
  {
    id: 'shota',
    cohortId: 'student',
    traitLabel: '寝ぼけている',
    name: '翔太',
    age: 16,
    role: 'いつも半分眠りながら操作する高校生',
    icon: '翔',
    goal: '寝ぼけた目でも見分けられて頭が覚めるアラームがいい',
    focusPoint: '時刻とボタンが大きく見やすく、頭を起こす仕掛けがあるか',
    constraints: {
      blurPx: 2.8,
      contrast: 0.72,
      jitterPx: 18,
      maxSteps: 3,
      patienceMs: 4500,
      environment: 'normal',
      requiresWakeGimmick: true,
      voicePitch: 0.98,
      voiceRate: 0.95,
    },
  },
  {
    id: 'hina',
    cohortId: 'student',
    traitLabel: '二度寝常習',
    name: '陽菜',
    age: 17,
    role: '普通のアラームは無意識に止めて二度寝する高校生',
    icon: '陽',
    goal: '計算クイズや連打など指と頭を使わないと完了しない仕掛けがほしい',
    focusPoint: '計算クイズ・逃げるボタン・3連打・声アラームなどの二度寝防止機能があるか',
    constraints: {
      blurPx: 1.2,
      contrast: 0.9,
      jitterPx: 10,
      maxSteps: 4,
      patienceMs: 5500,
      environment: 'normal',
      requiresWakeGimmick: true,
      voicePitch: 1.25,
      voiceRate: 1.08,
    },
  },
  {
    id: 'ren',
    cohortId: 'student',
    traitLabel: '暗い部屋で使う',
    name: '蓮',
    age: 15,
    role: '電気を消した真っ暗な部屋でスマホを見る中学生',
    icon: '蓮',
    goal: '暗い部屋でも眩しすぎず、くっきり見やすい画面でセットしたい',
    focusPoint: '眩しい黄色背景や散らかった配置が直り、二度寝防止も使えるか',
    constraints: {
      blurPx: 2.0,
      contrast: 0.58,
      jitterPx: 14,
      maxSteps: 3,
      patienceMs: 4500,
      environment: 'dark_room',
      requiresWakeGimmick: true,
      voicePitch: 1.02,
      voiceRate: 1.0,
    },
  },
];

export function getReviewersByCohort(cohortId?: TargetCohortId): ReviewerPersona[] {
  if (!cohortId) {
    return INITIAL_REVIEWERS;
  }
  const list = ALL_REVIEWER_PERSONAS.filter((p) => p.cohortId === cohortId);
  return list.length === 3 ? list : INITIAL_REVIEWERS;
}

// 未選択時または後方互換用の代表3人（各層の代表1人ずつ：健太・和子・翔太）
export const INITIAL_REVIEWERS: ReviewerPersona[] = [
  ALL_REVIEWER_PERSONAS.find((p) => p.id === 'kenta')!,
  ALL_REVIEWER_PERSONAS.find((p) => p.id === 'kazuko')!,
  ALL_REVIEWER_PERSONAS.find((p) => p.id === 'shota')!,
];

export const INITIAL_ALARM_SPEC: AppSpec = {
  id: 'ponkotsu-alarm',
  title: 'ぽんこつ目覚まし時計',
  subtitle: 'かいぞう前',
  taskDescription: '起きる時刻を合わせて、アラームを予約する',
  theme: {
    bgColor: '#fefce8',
    cardColor: '#ffffff',
    textColor: '#1c1917',
    accentColor: '#eab308',
    chaoticLayout: true,
  },
  state: [
    {
      key: 'alarmTime',
      label: '起きる時刻',
      type: 'string',
      initialValue: '07:00',
    },
    {
      key: 'motto',
      label: '今日の気合い度',
      type: 'number',
      initialValue: 20,
    },
    {
      key: 'poemNotify',
      label: '朝4時のポエム通知',
      type: 'boolean',
      initialValue: true,
    },
    {
      key: 'isAlarmSet',
      label: 'アラーム予約',
      type: 'boolean',
      initialValue: false,
    },
    {
      key: 'wakeMode',
      label: '二度寝防止モード',
      type: 'boolean',
      initialValue: false,
    },
  ],
  components: [
    {
      id: 'clock-display',
      type: 'clock_display',
      label: '起きる時刻',
      stateKey: 'alarmTime',
      style: {
        size: 'xs',
        variant: 'muted',
        align: 'right',
      },
      actions: [],
    },
    {
      id: 'input-time',
      type: 'select',
      label: '時刻を合わせる',
      options: ['06:00', '06:30', '07:00', '07:30', '08:00'],
      stateKey: 'alarmTime',
      style: {
        size: 'xs',
        variant: 'default',
        fullWidth: true,
      },
      actions: [],
    },
    {
      id: 'input-motto',
      type: 'slider',
      label: '今日の気合い度メーター',
      stateKey: 'motto',
      style: {
        size: 'xs',
        variant: 'warning',
        fullWidth: true,
      },
      actions: [],
    },
    {
      id: 'toggle-poem',
      type: 'toggle',
      label: '朝4時にポエム通知を受け取る',
      stateKey: 'poemNotify',
      style: {
        size: 'sm',
        variant: 'warning',
        fullWidth: true,
      },
      actions: [],
    },
    {
      id: 'btn-cancel-all',
      type: 'button',
      label: 'ぜんぶ消す',
      style: {
        size: 'xl',
        variant: 'danger',
        fullWidth: true,
        noisyAnimation: true,
      },
      actions: [
        {
          type: 'reset_all',
        },
        {
          type: 'show_toast',
          message: '設定がすべて消えました',
        },
      ],
    },
    {
      id: 'btn-set-alarm',
      type: 'button',
      label: '予約する',
      style: {
        size: 'xs',
        variant: 'muted',
        align: 'right',
      },
      actions: [],
    },
    {
      id: 'btn-mystery',
      type: 'button',
      label: '二度寝防止ボタン',
      style: {
        size: 'xs',
        variant: 'default',
        align: 'left',
      },
      actions: [
        {
          type: 'show_toast',
          message: 'まだ中身が空っぽです',
        },
      ],
    },
    {
      id: 'status-alarm',
      type: 'status_banner',
      label: 'アラームを予約しました',
      visibleWhen: {
        stateKey: 'isAlarmSet',
        operator: 'eq',
        value: true,
      },
      style: {
        size: 'lg',
        variant: 'success',
        fullWidth: true,
      },
      actions: [],
    },
  ],
};
