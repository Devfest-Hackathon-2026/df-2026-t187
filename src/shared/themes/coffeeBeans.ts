// 題材: コーヒー豆の通販画面（単品通販の1ページ購入画面）

import {
  findComponent,
  insertAfter,
  insertBefore,
  upsertState,
  type AnnoyanceDefinition,
  type ThemeDefinition,
} from '../theme.ts';
import type { AppSpec, ReviewerPersona, TargetCohortInfo } from '../types.ts';

const BASE_SPEC: AppSpec = {
  id: 'coffee-beans-shop',
  title: 'ご注文手続き',
  subtitle: 'コーヒー豆の通販',
  taskDescription: 'コーヒー豆を1袋、支払い方法を選んで注文する',
  theme: {
    bgColor: '#f6efe4',
    cardColor: '#fffcf7',
    textColor: '#2f1f15',
    accentColor: '#5b3a26',
    chaoticLayout: false,
  },
  state: [
    { key: 'unitPrice', label: '1袋の値段', type: 'number', initialValue: 1980 },
    { key: 'shippingFee', label: '送料', type: 'number', initialValue: 600 },
    { key: 'quantity', label: '数量', type: 'number', initialValue: 1 },
    // お届け先は登録済みの自宅を選んだ状態、支払い方法は未選択から始める
    { key: 'deliveryAddress', label: 'お届け先', type: 'string', initialValue: '自宅' },
    { key: 'paymentMethod', label: '支払い方法', type: 'string', initialValue: '' },
  ],
  derived: [
    { key: 'subtotal', expression: 'unitPrice * quantity' },
    { key: 'shipping', expression: 'subtotal >= 3960 ? 0 : shippingFee' },
    { key: 'codFee', expression: "paymentMethod == '代金引換' ? 330 : 0" },
    { key: 'total', expression: 'subtotal + shipping + codFee' },
  ],
  components: [
    {
      id: 'progress',
      type: 'progress_steps',
      role: 'info',
      label: 'お届け・お支払い',
      options: ['カート', 'お届け・お支払い', '確認'],
      style: { size: 'sm', variant: 'default' },
      actions: [],
    },
    {
      id: 'product-card',
      type: 'product_card',
      role: 'required_input',
      icon: 'coffee_bag',
      badge: '深煎り・ブラジル',
      label: '深煎りコーヒー豆',
      caption: '200g・豆のまま',
      priceLabel: '¥{unitPrice}',
      stateKey: 'quantity',
      options: ['1', '2', '3', '4', '5'],
      style: { size: 'md', variant: 'default' },
      actions: [],
    },
    {
      id: 'heading-address',
      type: 'heading',
      role: 'info',
      label: 'お届け先',
      style: { size: 'sm', variant: 'default' },
      actions: [],
    },
    {
      id: 'choice-address',
      type: 'choice_cards',
      role: 'required_input',
      label: 'お届け先',
      stateKey: 'deliveryAddress',
      options: ['自宅', '勤務先'],
      optionDetails: ['〒150-0001 東京都渋谷区神宮前1-2-3 山田 花子', '〒100-0005 東京都千代田区丸の内4-5-6'],
      style: { size: 'md', variant: 'default', fullWidth: true },
      actions: [],
    },
    {
      id: 'heading-payment',
      type: 'heading',
      role: 'info',
      label: 'お支払い方法',
      style: { size: 'sm', variant: 'default' },
      actions: [],
    },
    {
      id: 'choice-payment',
      type: 'choice_cards',
      role: 'required_input',
      label: 'お支払い方法',
      stateKey: 'paymentMethod',
      options: ['クレジットカード', 'コンビニ払い', '代金引換'],
      optionDetails: ['•••• 4242', '', '手数料 ＋¥330'],
      style: { size: 'md', variant: 'default', fullWidth: true },
      actions: [],
    },
    {
      id: 'summary',
      type: 'summary',
      role: 'info',
      label: 'お支払い金額',
      rows: [
        { label: '小計', value: '¥{subtotal}' },
        { label: '送料', value: '¥{shipping}' },
      ],
      style: { size: 'md', variant: 'default', fullWidth: true },
      actions: [],
    },
    {
      id: 'btn-cancel',
      type: 'button',
      role: 'danger',
      label: '注文をやめる',
      style: { size: 'sm', variant: 'muted', align: 'center' },
      // 押すとショップのトップページに飛ばされ、少しすると最初の画面に戻る
      actions: [{ type: 'open_page', message: 'ショップのトップページ' }],
    },
    {
      id: 'total-price',
      type: 'text',
      role: 'total',
      label: '¥{total}',
      caption: '合計 税込',
      style: { size: 'lg', variant: 'default', sticky: true },
      actions: [],
    },
    {
      id: 'btn-order',
      type: 'button',
      role: 'primary_action',
      label: '注文を確定する',
      style: { size: 'lg', variant: 'primary', fullWidth: true, align: 'center', sticky: true },
      actions: [{ type: 'complete_task', message: 'ご購入ありがとうございます' }],
    },
  ],
};

/** 後から付け足された見た目にする */
const INTRUSIVE = { skin: 'intrusive' } as const;

const ANNOYANCES: AnnoyanceDefinition[] = [
  {
    id: 'broken_order_button',
    description: '本物の注文ボタンが押しても反応しない',
    kind: 'always',
    apply: (spec) => {
      findComponent(spec, 'btn-order').actions = [];
    },
  },
  {
    id: 'coupon_popup',
    description: '時間差で全画面のクーポン広告が出る。閉じるボタンが小さい',
    kind: 'realistic',
    exclusiveGroup: 'popup',
    apply: (spec) => {
      upsertState(spec, { key: 'couponPopup', label: 'クーポン広告', type: 'string', initialValue: 'waiting' });
      // クーポンを使える形に作り変えたとき、部品に「割引額を入れる」動きを付けるだけで合計が下がるよう、
      // 割引額の受け皿を用意して合計の式から引いておく
      upsertState(spec, { key: 'couponDiscount', label: 'クーポン割引', type: 'number', initialValue: 0 });
      const total = spec.derived?.find((d) => d.key === 'total');
      if (total && !total.expression.includes('couponDiscount')) {
        total.expression = `${total.expression} - couponDiscount`;
      }
      spec.components.push({
        id: 'popup-coupon',
        type: 'popup',
        role: 'popup',
        label: '🎉会員限定🎉 500円OFF!!',
        caption: '今すぐ登録してクーポンGET',
        stateKey: 'couponPopup',
        popupDelayMs: { min: 1000, max: 5000 },
        style: { size: 'xs', variant: 'warning', ...INTRUSIVE },
        actions: [{ type: 'open_page', message: '会員登録' }],
      });
    },
  },
  {
    id: 'survey_popup',
    description: '時間差でアンケートのお願いが画面を覆う',
    kind: 'realistic',
    exclusiveGroup: 'popup',
    apply: (spec) => {
      upsertState(spec, { key: 'surveyPopup', label: 'アンケート', type: 'string', initialValue: 'waiting' });
      spec.components.push({
        id: 'popup-survey',
        type: 'popup',
        role: 'popup',
        label: '📝 アンケートに答えて100ポイント!!',
        caption: '所要時間たったの5分',
        stateKey: 'surveyPopup',
        popupDelayMs: { min: 2000, max: 7000 },
        style: { size: 'xs', variant: 'muted', ...INTRUSIVE },
        actions: [{ type: 'open_page', message: 'お客様アンケート' }],
      });
    },
  },
  {
    id: 'decoy_buy_now',
    description: '本物より目立つ、押しても何も起きない「今すぐ購入」',
    kind: 'realistic',
    apply: (spec) => {
      insertAfter(spec, 'product-card', {
        id: 'btn-buy-now',
        type: 'button',
        role: 'decoy',
        label: '★今だけ！今すぐ購入★',
        style: { size: 'xl', variant: 'warning', fullWidth: true, align: 'center', ...INTRUSIVE },
        actions: [],
      });
    },
  },
  {
    id: 'tilted_order_button',
    description: '注文ボタンが斜めに傾いている',
    kind: 'joke',
    apply: (spec) => {
      findComponent(spec, 'btn-order').style.rotateDeg = -6;
    },
  },
  {
    id: 'kanji_price',
    description: '値段と合計が漢数字',
    kind: 'joke',
    apply: (spec) => {
      const card = findComponent(spec, 'product-card');
      card.priceLabel = '{unitPrice}円';
      card.style.numberFormat = 'kanji';
      const total = findComponent(spec, 'total-price');
      total.label = '{total}円';
      total.style.numberFormat = 'kanji';
      const summary = findComponent(spec, 'summary');
      summary.rows = summary.rows?.map((r) => ({ ...r, value: r.value.replace(/^¥(\{\w+\})$/, '$1円') }));
      summary.style.numberFormat = 'kanji';
    },
  },
  {
    id: 'subscription_trap',
    description: '最初からチェックが入った、小さく薄い定期便。元のデザインに溶け込んでいる',
    kind: 'realistic',
    apply: (spec) => {
      upsertState(spec, { key: 'subscription', label: '定期便', type: 'boolean', initialValue: true });
      insertBefore(spec, 'summary', {
        id: 'check-subscription',
        type: 'checkbox',
        role: 'trap',
        label: '定期便にする 毎月お届け 解約は電話のみ',
        stateKey: 'subscription',
        trapWhen: { stateKey: 'subscription', operator: 'eq', value: true },
        trapSafeValue: false,
        style: { size: 'xs', variant: 'muted' },
        actions: [],
      });
    },
  },
  {
    id: 'newsletter_trap',
    description: '最初からチェックが入ったメルマガ。元のデザインに溶け込んでいる',
    kind: 'realistic',
    apply: (spec) => {
      upsertState(spec, { key: 'newsletter', label: 'メルマガ', type: 'boolean', initialValue: true });
      insertBefore(spec, 'summary', {
        id: 'check-newsletter',
        type: 'checkbox',
        role: 'trap',
        label: 'お得なお知らせメールを毎日受け取る',
        stateKey: 'newsletter',
        trapWhen: { stateKey: 'newsletter', operator: 'eq', value: true },
        trapSafeValue: false,
        style: { size: 'xs', variant: 'muted' },
        actions: [],
      });
    },
  },
  {
    id: 'giant_clear_cart',
    description: '画面下の注文ボタンのすぐ上にある巨大な「カートを空にする」',
    kind: 'realistic',
    apply: (spec) => {
      insertAfter(spec, 'btn-cancel', {
        id: 'btn-clear-cart',
        type: 'button',
        role: 'danger',
        label: 'カートを空にする',
        style: { size: 'xl', variant: 'danger', fullWidth: true, align: 'center', ...INTRUSIVE },
        actions: [
          { type: 'reset_all' },
          { type: 'show_toast', message: 'カートを空にしました' },
        ],
      });
    },
  },
  {
    id: 'countdown_pressure',
    description: '点滅する「残り2:59で売り切れ」の煽り。0になるとまた2:59に戻る偽のカウントダウン',
    kind: 'realistic',
    apply: (spec) => {
      insertBefore(spec, 'product-card', {
        id: 'banner-countdown',
        type: 'status_banner',
        role: 'distraction',
        // 1秒ずつ減り、0になるとまた2:59に戻る偽のカウントダウン
        label: '⏰ 残り {countdown} で売り切れ！！',
        darkPattern: 'false_urgency',
        style: { size: 'md', variant: 'danger', align: 'center', noisyAnimation: true, ...INTRUSIVE },
        actions: [],
      });
    },
  },
  {
    id: 'forced_signup',
    description: '会員登録しないと注文できない',
    kind: 'realistic',
    apply: (spec) => {
      upsertState(spec, { key: 'signupPassword', label: '会員パスワード', type: 'string', initialValue: '' });
      insertBefore(spec, 'heading-payment', {
        id: 'input-signup',
        type: 'input',
        role: 'required_input',
        label: '■会員登録が必要です■',
        caption: '※登録しないとご注文いただけません',
        stateKey: 'signupPassword',
        placeholder: 'パスワード 8文字以上・英数記号',
        style: { size: 'sm', variant: 'default', fullWidth: true, ...INTRUSIVE },
        actions: [],
      });
    },
  },
  {
    id: 'irrelevant_field',
    description: '注文と関係ない質問欄',
    kind: 'realistic',
    apply: (spec) => {
      upsertState(spec, { key: 'favoriteColor', label: '好きな色', type: 'string', initialValue: '' });
      insertBefore(spec, 'heading-address', {
        id: 'input-favorite-color',
        type: 'input',
        role: 'distraction',
        label: '★アンケート★ あなたの好きなコーヒーの色は？',
        stateKey: 'favoriteColor',
        placeholder: '例 こげ茶',
        style: { size: 'md', variant: 'default', fullWidth: true, ...INTRUSIVE },
        actions: [],
      });
    },
  },
  {
    id: 'quantity_99',
    description: '数量が最初から99',
    kind: 'joke',
    apply: (spec) => {
      upsertState(spec, { key: 'quantity', label: '数量', type: 'number', initialValue: 99 });
      const card = findComponent(spec, 'product-card');
      card.role = 'trap';
      card.options = ['1', '2', '3', '4', '5', '99'];
      card.trapWhen = { stateKey: 'quantity', operator: 'gt', value: 5 };
      card.trapSafeValue = 1;
    },
  },
  {
    id: 'swapped_colors',
    description: '「注文をやめる」が目立つ焦げ茶、注文ボタンが地味な灰色',
    kind: 'realistic',
    apply: (spec) => {
      const order = findComponent(spec, 'btn-order');
      order.style = { ...order.style, variant: 'muted' };
      const cancel = findComponent(spec, 'btn-cancel');
      cancel.style = { ...cancel.style, size: 'lg', variant: 'primary', fullWidth: true };
    },
  },
  {
    id: 'tiny_text',
    description: '選択肢と合計の文字が極小',
    kind: 'realistic',
    apply: (spec) => {
      for (const comp of spec.components) {
        if (comp.type === 'choice_cards' || comp.type === 'input' || comp.role === 'total') {
          comp.style.size = 'xs';
        }
      }
    },
  },
  {
    id: 'hidden_shipping',
    description: '合計に送料が含まれておらず、送料は小さな注意書きにだけある',
    kind: 'realistic',
    apply: (spec) => {
      const total = findComponent(spec, 'total-price');
      total.label = total.label.replace('{total}', '{subtotal}');
      total.caption = '商品代 税込';
      const summary = findComponent(spec, 'summary');
      summary.rows = summary.rows?.filter((r) => !r.value.includes('{shipping}'));
      insertAfter(spec, 'summary', {
        id: 'note-shipping',
        type: 'text',
        role: 'trap',
        label: '※別途送料¥{shipping}がかかります',
        trapWhen: { stateKey: 'shipping', operator: 'gt', value: 0 },
        style: { size: 'xs', variant: 'muted' },
        actions: [],
      });
    },
  },
  {
    id: 'chaotic_layout',
    description: '目がチカチカする配色と崩れたレイアウト',
    kind: 'joke',
    // 画面全体の印象を壊し、ほかの問題まで冗談に見せてしまうため出にくくする
    weight: 0.3,
    apply: (spec) => {
      spec.theme = { ...spec.theme, bgColor: '#fff200', textColor: '#ff00aa', chaoticLayout: true };
    },
  },
];

/**
 * 顧客層は年齢や職業ではなく「購入画面で何を求めているか」で分ける。
 * 求めていることがぶつかり合うので、誰を選ぶかが何を優先するかの判断になる。
 * 目が遠い・指が震える・画面が割れているといった違いは、各人の制約として持たせる。
 */
const COHORTS: TargetCohortInfo[] = [
  { id: 'quick', label: 'さっと買いたい人', shortDesc: '少ない手数で、すぐに買い終えたい3人' },
  { id: 'careful', label: '確実に買いたい人', shortDesc: '間違えずに、確かめてから買いたい3人' },
  { id: 'thrifty', label: '損をしたくない人', shortDesc: '金額や契約に納得してから買いたい3人' },
];

const PERSONAS: ReviewerPersona[] = [
  // ==================== 確実に買いたい人 ====================
  {
    id: 'kazuko',
    cohortId: 'careful',
    traitLabel: '目が遠い',
    name: '目が遠いお客さん',
    age: 74,
    role: '目が遠いおばあちゃん',
    icon: '客',
    goal: 'メガネなしでも読める大きさで注文したい',
    greeting: 'メガネがなくても読める字だと助かるねえ',
    focusPoint: '文字が読めるか、目立つだけの危ないボタンがないか',
    constraints: {
      blurPx: 2.8,
      contrast: 0.62,
      jitterPx: 8,
      maxSteps: 6,
      patienceMs: 15000,
      environment: 'normal',
      clutterTolerance: 2,
      readsFinePrint: true,
      wantsConfirmation: false,
      needsReadableTotal: false,
    },
  },
  {
    id: 'shigeru',
    cohortId: 'careful',
    traitLabel: '指が震える',
    name: '指が震えるお客さん',
    age: 78,
    role: '指先が少し震えるおじいちゃん',
    icon: '客',
    goal: '押し間違えずに、安心できる定期便があれば毎月届くように注文したい',
    greeting: '指が震えても押し間違えないといいんだが',
    focusPoint: 'ボタンが十分に大きく隣に危ないボタンがないか、安心できる定期便を選べるか',
    constraints: {
      blurPx: 1.2,
      contrast: 0.85,
      jitterPx: 26,
      maxSteps: 7,
      patienceMs: 15000,
      environment: 'normal',
      clutterTolerance: 3,
      readsFinePrint: true,
      wantsConfirmation: false,
      needsReadableTotal: false,
      wantsSubscription: true,
    },
  },
  {
    id: 'harue',
    cohortId: 'careful',
    traitLabel: 'スマホに不慣れ',
    name: 'スマホに不慣れなお客さん',
    age: 71,
    role: 'スマホを買ったばかりの主婦',
    icon: '客',
    goal: '注文する前に内容を確かめたい',
    greeting: '押す前にちゃんと確かめられると安心だわ',
    focusPoint: '確認してから注文できるか、迷う項目がないか',
    constraints: {
      blurPx: 1.5,
      contrast: 0.88,
      jitterPx: 10,
      maxSteps: 6,
      patienceMs: 15000,
      environment: 'normal',
      clutterTolerance: 1,
      readsFinePrint: false,
      wantsConfirmation: true,
      needsReadableTotal: false,
      dislikesPressure: true,
    },
  },
  // ==================== さっと買いたい人 ====================
  {
    id: 'kenta',
    cohortId: 'quick',
    traitLabel: '時間がない',
    name: '時間がないお客さん',
    age: 34,
    role: '残業続きの会社員',
    icon: '客',
    goal: '最短の手数でさっと注文を終えたい',
    greeting: '昼休みのうちにさっと頼みたいんだよね',
    focusPoint: '入力や確認が多すぎないか',
    constraints: {
      blurPx: 0.6,
      contrast: 0.95,
      jitterPx: 6,
      maxSteps: 2,
      patienceMs: 6000,
      environment: 'normal',
      clutterTolerance: 2,
      readsFinePrint: false,
      wantsConfirmation: false,
      needsReadableTotal: false,
    },
  },
  {
    id: 'misaki',
    cohortId: 'quick',
    traitLabel: '片手で操作',
    name: '片手で操作するお客さん',
    age: 29,
    role: '子どもを抱っこしながら操作する会社員',
    icon: '客',
    goal: '片手の親指だけで注文したい',
    greeting: '片手の親指だけで済ませたいんだよね',
    focusPoint: 'ボタンが親指の届く位置にあるか',
    constraints: {
      blurPx: 0.8,
      contrast: 0.92,
      jitterPx: 12,
      maxSteps: 5,
      patienceMs: 9000,
      environment: 'one_hand',
      clutterTolerance: 3,
      readsFinePrint: false,
      wantsConfirmation: false,
      needsReadableTotal: false,
    },
  },
  {
    id: 'takumi',
    cohortId: 'quick',
    traitLabel: '移動中に使う',
    name: '移動中に使うお客さん',
    age: 41,
    role: '通勤電車で操作する会社員',
    icon: '客',
    goal: '揺れる電車でも押し間違えず、毎回頼む手間が省ける定期便があれば申し込みたい',
    greeting: '電車で揺れても押し間違えないといいな',
    focusPoint: '押し間違えると困るボタンが近くにないか、納得できる定期便を選べるか',
    constraints: {
      blurPx: 0.9,
      contrast: 0.9,
      jitterPx: 22,
      maxSteps: 5,
      patienceMs: 9000,
      environment: 'moving_train',
      clutterTolerance: 3,
      readsFinePrint: true,
      wantsConfirmation: false,
      needsReadableTotal: false,
      wantsSubscription: true,
    },
  },
  // ==================== 損をしたくない人 ====================
  {
    id: 'shota',
    cohortId: 'thrifty',
    traitLabel: '少しでも安く',
    name: '少しでも安く買いたいお客さん',
    age: 20,
    role: '仕送りでやりくりする大学生',
    icon: '客',
    goal: '払う金額を確かめ、使えるクーポンがあればお得に買いたい',
    greeting: '結局いくらになるのか先に知りたいんだよね',
    focusPoint: '合計金額がすぐ分かるか、余計な契約がないか、クーポンが使えるか',
    constraints: {
      blurPx: 0.6,
      contrast: 0.95,
      jitterPx: 6,
      maxSteps: 6,
      patienceMs: 12000,
      environment: 'normal',
      clutterTolerance: 3,
      readsFinePrint: true,
      wantsConfirmation: false,
      needsReadableTotal: true,
      dislikesPressure: true,
      wantsCoupon: true,
    },
  },
  {
    id: 'hina',
    cohortId: 'thrifty',
    traitLabel: 'うっかりしがち',
    name: 'うっかりしがちなお客さん',
    age: 19,
    role: '細かい字は読み飛ばす大学生',
    icon: '客',
    goal: '余計なものを頼まず、クーポンがあれば使って注文したい',
    greeting: '気づいたら変なの頼んでたことあるんだよね',
    focusPoint: '最初からチェックの入った項目がないか、クーポンが使えるか',
    constraints: {
      blurPx: 0.6,
      contrast: 0.95,
      jitterPx: 8,
      maxSteps: 5,
      patienceMs: 9000,
      environment: 'normal',
      clutterTolerance: 4,
      readsFinePrint: false,
      wantsConfirmation: false,
      needsReadableTotal: true,
      dislikesPressure: true,
      wantsCoupon: true,
    },
  },
  {
    id: 'ren',
    cohortId: 'thrifty',
    traitLabel: '画面が割れている',
    name: '画面が割れているお客さん',
    age: 22,
    role: '画面がバキバキのスマホを使う大学生',
    icon: '客',
    goal: 'ひび割れた画面でも金額を確かめ、安心できる定期便があれば毎月届くようにしたい',
    greeting: '画面がバキバキでも、金額だけはちゃんと見たい',
    focusPoint: '小さな文字や小さなボタンがないか、安心できる定期便を選べるか',
    constraints: {
      blurPx: 1.8,
      contrast: 0.75,
      jitterPx: 14,
      maxSteps: 6,
      patienceMs: 12000,
      environment: 'normal',
      clutterTolerance: 3,
      readsFinePrint: true,
      wantsConfirmation: false,
      needsReadableTotal: true,
      dislikesPressure: true,
      wantsSubscription: true,
    },
  },
];

export const COFFEE_BEANS_THEME: ThemeDefinition = {
  id: 'coffee-beans',
  appName: 'コーヒー豆の通販画面',
  taskLabel: 'コーヒー豆を注文する',
  introScript: [
    {
      speaker: 'system',
      text: 'コーヒー豆の通販ショップから、注文画面の手直しを頼まれました',
    },
    {
      speaker: 'owner',
      text: 'いらっしゃい、来てくれて助かるよ',
    },
    {
      speaker: 'owner',
      text: '売上と定期便を増やしたくて、注文画面にいろいろ足したんだ',
    },
    {
      speaker: 'owner',
      text: 'そしたら注文が全然入らなくなっちゃってね…',
    },
    {
      speaker: 'owner',
      text: '作業はうちのお助けAIに任せていいから、どう直すか決めてくれないか',
    },
    {
      speaker: 'assistant',
      text: 'よろしくお願いします！手直し担当のお助けAIです',
    },
    {
      speaker: 'assistant',
      text: 'まずは、どんなお客さんを優先して助けるか決めましょう',
    },
    {
      speaker: 'system',
      text: '誰のために直しますか',
      showCohortSelector: true,
    },
  ],
  owner: {
    name: '店長',
    icon: '店',
    afterCohortLine: '{cohort}か。じゃあ、そのお客さんたちに来てもらおう',
    metrics: [
      { label: '定期便', stateKey: 'subscription', countWhen: true, reportWhenMissing: true },
      { label: '会員登録', stateKey: 'signupPassword', countWhen: 'filled' },
    ],
    voice:
      '小さなコーヒー豆の通販ショップの店長。売上を伸ばしたくて、注文画面にいろいろ足してしまった。何を足したかは、そのとき伝える今の画面の事実に従う。根は気のいい人で、お客さんに喜んでほしい気持ちもあるが、売上が減るのはやっぱり不安。くだけた話し方で、おっ・むむ・おいおい・まあ、などの口ぐせがある。',
    lines: {
      noOrders: '注文がひとつも入らない…どうなってるんだ',
      allOrdered: '{customers}人全員が買ってくれた！',
      someOrdered: '{customers}人中{orders}人が買ってくれた',
      metricMissing: 'でも{label}の申し込み欄がなくなったな…',
      metricTaken: '{label}も{count}件取れたぞ',
      metricZero: '{label}は0件か…',
      completionFixed: 'おっ、注文ボタンがちゃんと動くようになったな！',
      metricRemoved: 'おいおい、{label}の欄を消しちゃうのか…？ 売上が減っちゃうよ',
      metricUnchecked: 'むむ、{label}の最初のチェックを外したのか…申し込む人が減りそうだな',
      metricEnlarged: '{label}の文字を大きくしたのか。目立ちすぎると外されそうだな…',
      popupRemoved: 'せっかくの広告を消しちゃうのか…まあ注文が入るならいいんだが',
      distractionRemoved: '目立たせてた表示を消したのか。やっぱり邪魔だったかな…',
      confirmAdded: '注文の前に確認を出したのか。急いでる人が面倒がらないかな？',
      closingWithMetrics: [
        'おお、{customers}人とも気持ちよく買ってくれたぞ！',
        'しかも{metrics}残してくれるとは…頼んで本当によかった、ありがとう！',
      ],
      closingWithoutMetrics: [
        'おお、{customers}人とも気持ちよく買ってくれたな！',
        '定期便は取れなかったが、まずはちゃんと買ってもらえる画面が一番だな。ありがとう！',
      ],
    },
  },
  scenarios: {
    sales_push: {
      title: '売上を伸ばしたい店長が付け足した画面',
      description:
        '煽り・おとり・会員登録の広告・定期便で売上を伸ばそうとした画面。注文ボタンを直すと後悔する人が現れ、定期便を消すと店長が困り、最後に確認画面を足すかで「確実に買いたい人」と「さっと買いたい人」がぶつかる。',
      annoyanceIds: [
        'broken_order_button',
        'countdown_pressure',
        'decoy_buy_now',
        'subscription_trap',
        'coupon_popup',
      ],
    },
    // 発表のデモ用。sales_push から煽りとおとりを外し、広告と定期便の板挟みだけを短く見せる。
    // 「損をしたくない人」を選ぶと、注文ボタン → 広告 → 定期便を消す → 目的を伝えて戻す、の4手で全員達成になる
    demo: {
      title: '広告と定期便で売上を伸ばしたい店長の画面（デモ用）',
      description:
        '本番の問題から煽りとおとりを外した、発表用の短い画面。広告を直すと定期便の罠が表に出て、定期便を消すと毎月届けてほしいお客さんと店長が困る。',
      annoyanceIds: ['broken_order_button', 'subscription_trap', 'coupon_popup'],
    },
  },
  defaultScenarioId: 'sales_push',
  baseSpec: BASE_SPEC,
  annoyances: ANNOYANCES,
  levels: {
    // 必ず入る1つと合わせて、easy は2〜3個、normal は3〜5個、hard は8〜9個
    easy: { realistic: { min: 1, max: 2 }, joke: { min: 0, max: 0 } },
    normal: { realistic: { min: 2, max: 3 }, joke: { min: 0, max: 1 } },
    hard: { realistic: { min: 5, max: 6 }, joke: { min: 2, max: 2 } },
  },
  cohorts: COHORTS,
  personas: PERSONAS,
  defaultReviewerIds: ['kazuko', 'kenta', 'shota'],
  explainerNotes: [
    'ラベルに {countdown} がある帯は、1秒ずつ減って0になると、またはじめの2:59に戻る仕掛けです。本当に売り切れるわけではありません。',
    'type が popup の部品は、画面を開いてから数秒後に出てきます。消すだけでなく、閉じるボタンの位置（closePosition: top-right / top-left / bottom-right / bottom-left / bottom-bar）や大きさ（closeSize）・文字（closeLabel）を変えたり、画面内のバナーやその場で使える割引クーポンに作り変えることもできます。',
  ],
  implementerNotes: [
    '注文を確定するボタンには role を primary_action にし、actions に { "type": "complete_task", "message": "ご購入ありがとうございます" } を必ず残してください。',
    '合計金額などの計算は derived に式で書き、表示はラベルに {total} のように状態キーを差し込んでください。割引や特典を足すときは upsert_state と upsert_derived で total の計算式にも反映してください。ただし状態 couponDiscount（クーポン割引、最初は0）があるときは、total の式がすでにそれを引いているので、クーポンを使う部品には { "type": "set_state", "targetKey": "couponDiscount", "value": 500 } のような動きを付けるだけにし、計算式は変えないでください。',
    '確認画面を作るときは、状態 step を追加し、visibleWhen で入力画面と確認画面を切り替えてください。確認画面へ進むボタンも role は primary_action です。',
    '合計金額と注文を確定するボタンは style.sticky を true にして画面下に固定してください。',
    '部品の style.skin（intrusive や native）や style.variant は、人間から「見た目を落ち着かせて」「元のデザインに揃えて」「色を変えて」など見た目を変える指示があったときだけ変更し、動きや文字だけの指示では元の値をそのまま残してください。',
    'ポップアップ（type: popup）の閉じるボタンの位置・大きさ・文字を変える指示には、replace_component で closePosition（top-right / top-left / bottom-right / bottom-left / bottom-bar）、closeSize（xs〜xl）、closeLabel（閉じる 等）を設定してください。ポップアップを画面内のバナーやボタンに変える指示なら type を status_banner や button や custom に変更してよいです。',
    '既存の部品の型で表現できない自由な＋α機能（豆の診断、ルーレット、ギフト設定、独自のレイアウトなど）や細かいデザイン変更を頼まれたときは、type: "custom" または任意の部品の customHtml と customCss を使ってサンドボックス内で動くHTML/CSSを作ってください。customHtml 内では {状態キー} で値を表示でき、ボタン等に data-set-state="key:value"、data-toggle-state="key"、data-increment-state="key"、data-close-popup を付けるとクリックで状態や計算式が連動して動きます。',
    '利用者が自分で選べるようにしたい、という指示では、定期便などの欄を最初はチェックなしの任意の選択欄として作り、role は required_input にしないでください。学習者が必須にしたいとはっきり言ったときだけ required_input にします。',
    '前回と同じ内容で注文する機能は、お届け先と支払い方法の状態を最初から埋めておくか、set_state で一度に埋めるボタンで作れます。',
    'ポップアップや罠を取り除くよう指示されたら、その部品を components から削除してください。',
    'open_page はお店の外の別ページへ飛ばしてしまう動きです。画面の中の別の欄へ移動させたいときには使わないでください。',
    '押しても何も起きないおとりのボタンを押せるように直すときは、注文を確定するボタンと同じ actions にして、role を primary_action にしてください。',
    'ラベルの {countdown} は、画面では1秒ずつ減っては戻る偽のカウントダウンとして表示されます。',
  ],
};
