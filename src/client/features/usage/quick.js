// src/client/features/usage/quick.js
//
// 会话头快捷入口：芯片 + 悬停浮层（对应源插件的 11-quick.js）。
//
// ⚠️ 关闭判定完全走**几何**（不碰 mouseenter / mouseleave / blur）—— 这段一个字都不要改：
//   1. 芯片与浮层之间有视觉缝隙，指针穿过时 mouseleave 已经触发；
//   2. 祖先若有 transform / filter / backdrop-filter，`position: fixed` 的包含块会换人，
//      浮层实际位置与触发体矩形对不上，enter/leave 的结论随之失效；
//   3. blur 关浮层会让「点浮层里的按钮」把浮层点没（焦点一移走就关）。
// 现在只问一句：指针还在「触发体 ∪ 浮层」的矩形里吗？不在且超过宽限期才关。
//
// ⚠️ 另一个不能改的设计：**每个挂载点各渲染一份 <Styles/>**（会话头芯片在设置面板之外，
// 样式必须跟着组件走，否则裸 DOM 撑开页面）。

import { h, useState, useEffect, useRef } from '../../runtime.js';
import { api } from './api.js';
import { clipText, clockTime, durationText, relativeTime, statusTone } from './format.js';
import { Badge, Button, UsageView } from './atoms.js';
import { statusKey } from './provider.js';
import { UsageIcon, createHoverLiveness, pickChipProvider, providerSummary } from './hover.js';
import { POP_GRACE_MS, POP_SLACK_PX } from './constants.js';
import { Styles } from './styles.js';

/**
 * 浮层里的单条记录。
 *
 * @param {object} props 属性。
 * @returns {object} React 元素。
 */
export function QuickProvider(props) {
  var t = props.t;
  var provider = props.provider;
  var summary = providerSummary(provider, t);
  var credential = provider.credential || {};
  // 自动续期：登录态失效时，这里要能一键换好 —— 浮层才是平时真正会用的入口，
  // 把按钮只放在设置面板里等于没做（踩过一次：改完设置面板才发现浮层没有）。
  var renewal = provider.renewal || {};
  var canRenew = renewal.supported === true && provider.source === 'curl';
  var credentialText = (function () {
    if (credential.found !== true) return t('credentialNone');
    if (typeof credential.exp !== 'number') return t('credentialOpaque');
    var ms = credential.exp * 1000;
    if (ms <= Date.now()) return t('credentialExpired', { time: clockTime(ms) });
    return t('credentialExpires', { time: clockTime(ms), left: durationText(ms - Date.now()) });
  })();
  return h('div', { className: 'duq-pop-card' },
    h('div', { className: 'duq-pop-head' },
      h('span', { className: 'duq-chip-dot is-' + statusTone(provider.status) }),
      h('span', { className: 'duq-pop-title' }, provider.label),
      h(Badge, { text: t(statusKey(provider.status)), tone: statusTone(provider.status) }),
      h('button', {
        type: 'button',
        className: 'duq-star' + (props.chipId === provider.id ? ' is-on' : ''),
        title: props.chipId === provider.id ? t('chipUnpin') : t('chipPin'),
        'aria-pressed': props.chipId === provider.id,
        'aria-label': t('chipPin'),
        onClick: function () { props.onPickChip(provider.id); }
      }, props.chipId === provider.id ? '★' : '☆'),
      provider.queryable === true
        ? h(Button, { quiet: true, onClick: function () { props.onRefresh(provider.id); }, disabled: props.busy }, t('refresh'))
        : null,
      canRenew ? h(Button, {
        variant: provider.status === 'expired' ? 'primary' : 'quiet',
        onClick: function () { props.onRenew(provider.id); },
        disabled: props.busy
      }, props.busy ? t('renewRunning') : t('renew')) : null
    ),
    h('div', { className: 'duq-pop-meta' },
      provider.last === null ? t('neverQueried') : t('lastUpdated') + '：' + relativeTime(provider.last.at, t),
      provider.last !== null && provider.last.httpStatus !== null ? ' · HTTP ' + provider.last.httpStatus : '',
      provider.last !== null && (provider.last.trigger === 'auto' || provider.last.trigger === 'import') ? ' · ' + t('autoTag') : '',
      ' · ' + t('credential') + '：' + credentialText
    ),
    provider.status === 'expired'
      ? h('div', { className: 'duq-pop-warn' },
        t('expiredTitle') + ' —— ' + (canRenew ? t('renewNeedsLogin') : t('expiredBody')))
      : null,
    h(UsageView, { view: provider.view, t: t, placeholder: t('viewEmpty'), maxCards: 1 }),
    h('div', { className: 'duq-pop-foot' }, summary.detail === '' ? provider.endpoint : summary.detail)
  );
}

/**
 * 浮层内容。
 *
 * 抽成独立组件有两个好处：调用方只管开关与数据，规则（默认只展开第一个接口、
 * 其余折叠、点了刷新就固定住）集中在这里；同时它可以在没有浏览器的环境里被
 * 单独渲染验证（scripts/render-check.mjs）。
 *
 * @param {object} props 属性。
 * @returns {object} React 元素。
 */
export function QuickPopover(props) {
  var t = props.t;
  var providers = props.providers;
  var shown = props.expanded === true ? providers : providers.slice(0, 1);
  var restCount = providers.length - shown.length;
  return h('div', {
    className: 'duq-quick-pop',
    ref: props.popRef,
    style: props.style
  },
  h('div', { className: 'duq-quick-scroll' },
  h('div', { className: 'duq-quick-head' },
    h('span', { className: 'duq-quick-title' }, t('quickTitle')),
    providers.length > 0 ? h(Button, { quiet: true, onClick: props.onRefreshAll, disabled: props.busy }, t('quickRefreshAll')) : null
  ),
  providers.length === 0
    ? h('p', { className: 'duq-quick-empty' }, t('quickEmpty'))
    : shown.map(function (item) {
      return h(QuickProvider, {
        key: item.id,
        t: t,
        provider: item,
        busy: props.busy,
        chipId: props.chipId,
        onPickChip: props.onPickChip,
        onRefresh: props.onRefresh,
        onRenew: props.onRenew
      });
    }),
  restCount > 0 || props.expanded === true
    ? h('button', {
      type: 'button',
      className: 'duq-more',
      onClick: props.onToggleExpanded
    }, props.expanded === true ? t('collapse') : t('quickMore', { n: restCount }))
    : null,
  props.note !== undefined && props.note !== '' ? h('div', { className: 'duq-quick-note' }, props.note) : null,
  h('div', { className: 'duq-quick-foot' },
    h('span', { className: 'duq-quick-hint' }, t('quickHint'))
  )
  )
  );
}

/**
 * 会话头右侧的快捷入口：**悬停**弹出浮层（点击也可固定），浮层里就是设置面板的卡片。
 *
 * 为什么必须自己注入 <style>：客户端的样式是随组件渲染的 <style> 元素带出来的，
 * 而这个组件住在会话头槽位里 —— 设置面板/主区页面都没挂载时，全局就没有这份 CSS，
 * 浮层会以裸 DOM 出现在文档流里（把页面撑开）。这条是踩过的坑，见 render-check 的断言。
 *
 * @param {{t: Function}} props 属性。
 * @returns {object} React 元素。
 */
export function UsageChip(props) {
  var t = props.t;
  var [open, setOpen] = useState(false);
  var [pinned, setPinned] = useState(false);
  var [showAll, setShowAll] = useState(false);
  var [state, setState] = useState(null);
  var [busy, setBusy] = useState(false);
  // 续期/刷新之后要说人话。以前 renewOne 的 catch 直接 `return load()`，
  // 失败被整个吞掉：卡片只是「看起来没变化」，用户完全不知道发生了什么。
  // 一次几分钟的操作如果失败后毫无反馈，下次就只会觉得「这功能坏了」。
  var [note, setNote] = useState('');
  var [anchor, setAnchor] = useState(null);
  var containerRef = useRef(null);
  var popRef = useRef(null);
  var loadedAt = useRef(0);
  var correctedRef = useRef(false);
  var livenessRef = useRef(null);
  if (livenessRef.current === null) {
    livenessRef.current = createHoverLiveness({
      graceMs: POP_GRACE_MS,
      now: function () { return Date.now(); },
      onLeaveExpired: function () { setOpen(false); }
    });
  }

  var load = function () {
    loadedAt.current = Date.now();
    return api.state().then(function (next) { setState(next); }).catch(function () { /* 面板负责报错，这里静默 */ });
  };

  /** 悬停会反复触发：3 秒内的重复进入不再重读，避免鼠标扫过时抖着读文件。 */
  var loadFresh = function () {
    if (Date.now() - loadedAt.current < 3000) return Promise.resolve();
    return load();
  };

  useEffect(function () {
    load();
    var timer = window.setInterval(function () {
      if (document.visibilityState === 'hidden') return;
      load();
    }, 30000);
    return function () { window.clearInterval(timer); };
  }, []);

  /**
   * 关闭判定完全走**几何**（不碰 mouseenter / mouseleave / blur）。
   *
   * 为什么非这样不可（三个都真踩过）：
   *   1. 芯片与浮层之间有视觉缝隙，指针穿过时 mouseleave 已经触发；缝隙大一点或手速
   *      慢一点，延迟关闭就真把浮层关掉了 —— 表现就是「往卡片上一移就没了」；
   *   2. 祖先若有 transform / filter / backdrop-filter，`position: fixed` 的包含块会
   *      换人，浮层实际位置与触发体矩形对不上，enter/leave 的结论随之失效；
   *   3. blur 关浮层会让「点浮层里的按钮」把浮层点没（焦点一移走就关）。
   *
   * 现在只问一句：指针还在「触发体 ∪ 浮层」的矩形里吗？不在且超过宽限期才关。
   */
  useEffect(function () {
    if (!open) {
      correctedRef.current = false;
      return undefined;
    }
    var liveness = livenessRef.current;
    var onMove = function (event) {
      liveness.pointerAt(event.clientX, event.clientY, [containerRef.current, popRef.current], POP_SLACK_PX);
    };
    // 指针静止时不会有 pointermove（例如快速甩出窗口），所以还要按拍检查一次。
    var tick = window.setInterval(function () { liveness.tick(); }, 150);
    document.addEventListener('pointermove', onMove, true);
    return function () {
      document.removeEventListener('pointermove', onMove, true);
      window.clearInterval(tick);
    };
  }, [open]);

  useEffect(function () {
    livenessRef.current.setPinned(pinned);
  }, [pinned]);

  /**
   * 自检锚点：量一下浮层**实际**落在哪，与「触发体下沿」差多少。
   *
   * `position: fixed` 的包含块本该是视口，但只要有祖先带 transform / filter /
   * backdrop-filter 就会换人 —— 那时按视口坐标算出来的 top/right 会整体偏移。
   * 这里量一次真实偏差并纠正回来（每次打开只纠正一次，避免抖动）。
   */
  useEffect(function () {
    if (!open || correctedRef.current) return;
    var wrap = containerRef.current;
    var pop = popRef.current;
    if (wrap === null || pop === null) return;
    var wrapRect = wrap.getBoundingClientRect();
    var popRect = pop.getBoundingClientRect();
    var driftTop = Math.round(popRect.top - (wrapRect.bottom + 8));
    var driftRight = Math.round((window.innerWidth - popRect.right) - Math.max(8, window.innerWidth - wrapRect.right));
    if (Math.abs(driftTop) <= 4 && Math.abs(driftRight) <= 4) return;
    correctedRef.current = true;
    setAnchor(function (current) {
      if (current === null) return null;
      return { top: current.top + 8 - driftTop, right: current.right - driftRight };
    });
  }, [open, anchor]);

  // 另外两个关闭入口：Esc、点浮层外面（点外面在固定态下尤其重要）。
  useEffect(function () {
    if (!open) return undefined;
    var onKey = function (event) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      setPinned(false);
    };
    var onPointerDown = function (event) {
      var node = containerRef.current;
      if (node === null || node === undefined) return;
      if (!node.contains(event.target)) {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return function () {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  var openNow = function () {
    if (open) return;
    setNote('');
    var node = containerRef.current;
    var rect = node === null || node === undefined ? null : node.getBoundingClientRect();
    setAnchor(rect === null ? null : { top: rect.bottom, right: Math.max(8, window.innerWidth - rect.right) });
    livenessRef.current.setPinned(false);
    setOpen(true);
    loadFresh();
  };

  var providers = state === null ? [] : state.providers;
  var chipId = state !== null && state.chip !== undefined && state.chip !== null ? state.chip.id : null;
  var chipProvider = pickChipProvider(providers, chipId);
  var first = chipProvider === null ? null : providerSummary(chipProvider, t);
  var chipValue = first === null ? '' : first.value;
  // 多接口时把「接口名」与「数值」分成两段渲染：名字是可压缩的次要信息（最多 12 字，
  // 超出用省略号），数值永远完整 —— 顶部芯片的价值就是一眼看到那个数。
  var showChipLabel = first !== null && providers.length > 1 && chipProvider !== null;
  var chipName = showChipLabel ? clipText(chipProvider.label, 12) : '';
  var pickChip = function (id) {
    var next = chipId === id ? '' : id;
    api.setChip(next).then(load).catch(function () { return load(); });
  };

  var failText = function (error) {
    return t('actionFail') + '：' + String(error.message || error);
  };
  var refreshOne = function (id) {
    setBusy(true);
    setNote('');
    setPinned(true);
    livenessRef.current.setPinned(true);
    api.refresh(id).then(function () { return load(); })
      .catch(function (error) { setNote(failText(error)); return load(); })
      .then(function () { setBusy(false); });
  };
  // 续期是分钟级的阻塞操作（要等人扫码/点同意）：置灰期间浮层保持打开并钉住，
  // 否则浮层一关，用户就失去了「窗口在等授权」这件事的上下文。
  var renewOne = function (id) {
    setBusy(true);
    setNote('');
    setPinned(true);
    livenessRef.current.setPinned(true);
    // 服务端成功时会直接带回续期后的记录 —— 用它就地更新，省掉一次「先续期、
    // 再重读」的往返，也避免中间态（登录态已换新、状态还是旧的 401）被看见。
    api.renew(id, true).then(function (result) {
      // 用函数式更新，避免闭包里那份 state 是旧的（轮询随时可能在改它）。
      if (result !== null && result.provider !== undefined) {
        setState(function (prev) {
          if (prev === null) return prev;
          return {
            ...prev,
            providers: prev.providers.map(function (item) { return item.id === id ? result.provider : item; }),
          };
        });
      }
      setNote(result !== null && typeof result.message === 'string' ? result.message : t('renewDone'));
      return load();
    }).catch(function (error) {
      setNote(failText(error));
      return load();
    }).then(function () { setBusy(false); });
  };
  var refreshAll = function () {
    var queryable = providers.filter(function (item) { return item.queryable === true; });
    if (queryable.length === 0) return;
    setBusy(true);
    setPinned(true);
    livenessRef.current.setPinned(true);
    Promise.all(queryable.map(function (item) { return api.refresh(item.id).catch(function () { return null; }); }))
      .then(function () { setBusy(false); return load(); });
  };

  return h('div', {
    className: 'duq-quick',
    ref: containerRef,
    onMouseEnter: openNow
  },
  h(Styles, null),
  h('button', {
    type: 'button',
    className: 'duq-quick-trigger' + (open ? ' is-open' : '') + (first === null ? ' is-idle' : ''),
    title: chipProvider === null
      ? t('quickTitle')
      : t('quickTitle') + '：' + chipProvider.label + ' · ' + (first.detail === '' ? chipValue : first.detail),
    'aria-expanded': open,
    'aria-haspopup': 'true',
    onClick: function () {
      if (open && pinned) {
        setPinned(false);
        livenessRef.current.setPinned(false);
        setOpen(false);
        return;
      }
      setPinned(true);
      livenessRef.current.setPinned(true);
      openNow();
    }
  },
  h(UsageIcon, { size: 15 }),
  chipName === '' ? null : h('span', { className: 'duq-quick-name' }, chipName),
  chipValue === '' ? null : h('span', { className: 'duq-quick-value' }, chipValue),
  h('span', { className: 'duq-chip-dot is-' + (first === null ? 'idle' : first.tone) })
  ),
  open ? h(QuickPopover, {
    t: t,
    providers: providers,
    chipId: chipId,
    onPickChip: pickChip,
    expanded: showAll,
    busy: busy,
    popRef: popRef,
    style: anchor === null ? undefined : { top: anchor.top + 8 + 'px', right: anchor.right + 'px' },
    onRefresh: refreshOne,
    onRenew: renewOne,
    note: note,
    onRefreshAll: refreshAll,
    onToggleExpanded: function () {
      setPinned(true);
      livenessRef.current.setPinned(true);
      setShowAll(!showAll);
    },
  }) : null
  );
}
